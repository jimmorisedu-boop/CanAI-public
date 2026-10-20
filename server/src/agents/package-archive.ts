import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { AgentPackageError } from './package-errors.js'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX_ENTRIES = 2048
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_RATIO = 200
const MAX_TREE_DEPTH = 64

export interface ArchiveBounds {
  maxEntries?: number
  maxArchiveBytes?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  /** Package archives require one wrapper directory; runtime archives do not. */
  requireSingleTopLevel?: boolean
}

interface ZipEntry {
  name: string
  canonical: string
  directory: boolean
  method: number
  flags: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

function fail(message: string, code = 'ARCHIVE_INVALID'): never { throw new AgentPackageError(code, message, 400) }

// ZIP stores CRC-32 in the central directory.  Checking it after bounded
// decompression is the last integrity barrier before a package can be probed;
// the SHA/tree check alone cannot distinguish a damaged upload from a valid
// package because both are computed only after extraction.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(value: Buffer): number {
  let result = 0xffffffff
  for (const byte of value) result = (result >>> 8) ^ CRC32_TABLE[(result ^ byte) & 0xff]!
  return (result ^ 0xffffffff) >>> 0
}

function reservedWindowsSegment(value: string): boolean {
  const stem = value.split('.')[0].toUpperCase()
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
}

function canonicalPath(name: string): string {
  if (!name || name.includes('\\') || name.includes('\u0000') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) fail('Archive path is invalid')
  const directory = name.endsWith('/')
  const parts = name.split('/')
  if (directory) parts.pop()
  if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) fail('Archive path contains traversal')
  for (const part of parts) {
    if (part.endsWith(' ') || part.endsWith('.') || reservedWindowsSegment(part) || /[:*?<>|\u0000-\u001f]/.test(part)) fail('Archive path contains a forbidden Windows segment')
    if (part.toLowerCase() === '.git' || part.toLowerCase() === '.gitmodules' || part.toLowerCase() === '.gitmodules'.toLowerCase()) fail('Archive metadata files are forbidden')
    if (part.toLowerCase() === 'node_modules' || part.toLowerCase() === 'data' || part.toLowerCase() === 'output' || part.toLowerCase() === '.env' || part.toLowerCase().startsWith('.env.')) fail('Archive contains local data or secrets')
  }
  return parts.join('/').normalize('NFC').toLocaleLowerCase('en-US')
}

function displayName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte >= 0x80)) fail('Archive filename must be UTF-8')
  const value = bytes.toString('utf8')
  if (value.includes('\ufffd')) fail('Archive filename is invalid')
  return value
}

function parseEntries(archive: Buffer, bounds: Required<ArchiveBounds>): ZipEntry[] {
  if (archive.length > bounds.maxArchiveBytes) fail('Archive exceeds the size limit', 'ARCHIVE_TOO_LARGE')
  const start = Math.max(0, archive.length - 65_557)
  let eocd = -1
  for (let index = archive.length - 22; index >= start; index -= 1) if (archive.readUInt32LE(index) === EOCD) { eocd = index; break }
  if (eocd < 0) fail('ZIP end record was not found')
  const entriesCount = archive.readUInt16LE(eocd + 10)
  const centralSize = archive.readUInt32LE(eocd + 12)
  const centralOffset = archive.readUInt32LE(eocd + 16)
  if (entriesCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP64 archives are not supported', 'ARCHIVE_UNSUPPORTED')
  if (entriesCount > bounds.maxEntries || centralOffset + centralSize > eocd) fail('ZIP central directory exceeds the limits')
  const entries: ZipEntry[] = []
  const names = new Set<string>()
  let cursor = centralOffset
  for (let index = 0; index < entriesCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL) fail('ZIP central entry is invalid')
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const madeBy = archive.readUInt16LE(cursor + 4)
    const external = archive.readUInt32LE(cursor + 38)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const end = cursor + 46 + nameLength + extraLength + commentLength
    if (end > archive.length || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) fail('ZIP64 or corrupt entries are forbidden', 'ARCHIVE_UNSUPPORTED')
    if (flags & 0x1) fail('Encrypted ZIP entries are forbidden', 'ARCHIVE_UNSUPPORTED')
    const name = displayName(archive.subarray(cursor + 46, cursor + 46 + nameLength), Boolean(flags & 0x800))
    const canonical = canonicalPath(name)
    if (names.has(canonical)) fail('Archive contains a case/unicode collision')
    names.add(canonical)
    const directory = name.endsWith('/')
    const unixMode = (madeBy >>> 8) === 3 ? external >>> 16 : 0
    const fileType = unixMode & 0o170000
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) fail('Symlink/special ZIP entries are forbidden', 'ARCHIVE_UNSUPPORTED')
    if (!directory && uncompressedSize > bounds.maxFileBytes) fail('File in archive exceeds the limit', 'ARCHIVE_TOO_LARGE')
    if (compressedSize > bounds.maxArchiveBytes || (compressedSize > 0 && uncompressedSize > compressedSize * MAX_RATIO + 64 * 1024)) fail('Archive compression ratio exceeds the limit', 'ARCHIVE_TOO_LARGE')
    entries.push({ name, canonical, directory, method, flags, crc32: crc, compressedSize, uncompressedSize, localOffset })
    cursor = end
  }
  return entries
}

function entryBytes(archive: Buffer, entry: ZipEntry): Buffer {
  if (entry.localOffset + 30 > archive.length || archive.readUInt32LE(entry.localOffset) !== LOCAL) fail('ZIP local header is invalid')
  const nameLength = archive.readUInt16LE(entry.localOffset + 26)
  const extraLength = archive.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (start < 0 || end > archive.length) fail('ZIP entry extends beyond the archive')
  const compressed = archive.subarray(start, end)
  let bytes: Buffer
  if (entry.method === 0) bytes = Buffer.from(compressed)
  else {
    if (entry.method !== 8) fail('Only stored/deflate ZIP entries are supported', 'ARCHIVE_UNSUPPORTED')
    try { bytes = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) }) }
    catch { fail('ZIP deflate entry cannot be decompressed') }
  }
  if (crc32(bytes) !== entry.crc32) fail('ZIP CRC entry does not match')
  return bytes
}

function requiredBounds(value: ArchiveBounds): Required<ArchiveBounds> {
  return {
    maxEntries: value.maxEntries ?? MAX_ENTRIES,
    maxArchiveBytes: value.maxArchiveBytes ?? MAX_ARCHIVE_BYTES,
    maxFileBytes: value.maxFileBytes ?? MAX_FILE_BYTES,
    maxTotalBytes: value.maxTotalBytes ?? MAX_TOTAL_BYTES,
    requireSingleTopLevel: value.requireSingleTopLevel ?? true,
  }
}

export async function extractPackageArchive(archive: Buffer, output: string, subdir?: string, customBounds: ArchiveBounds = {}): Promise<void> {
  const bounds = requiredBounds(customBounds)
  const entries = parseEntries(archive, bounds)
  if (!entries.length) fail('Archive is empty')
  const root = entries[0].name.split('/')[0]
  if (bounds.requireSingleTopLevel && entries.some((entry) => entry.name.split('/')[0] !== root)) fail('Archive must have one top-level root')
  const prefix = bounds.requireSingleTopLevel
    ? (subdir ? `${root}/${subdir}/` : `${root}/`)
    : (subdir ? `${subdir}/` : '')
  let total = 0
  await ensureDirectoryChain(output)
  const dirs = new Set<string>()
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix) || entry.directory) continue
    const relative = entry.name.slice(prefix.length)
    if (!relative || relative.endsWith('/')) continue
    const outputPath = path.resolve(output, ...relative.split('/'))
    const outputRoot = path.resolve(output)
    if (outputPath !== outputRoot && !outputPath.startsWith(`${outputRoot}${path.sep}`)) fail('Archive output traversal')
    const bytes = entryBytes(archive, entry)
    if (bytes.length !== entry.uncompressedSize) fail('ZIP uncompressed size mismatch')
    total += bytes.length
    if (total > bounds.maxTotalBytes) fail('Total package size exceeds the limit', 'ARCHIVE_TOO_LARGE')
    const parent = path.dirname(outputPath)
    await ensureDirectories(outputRoot, parent, dirs)
    try { await fs.writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 }) }
    catch { fail('Archive contains conflicting files') }
  }
  const files = await fs.readdir(output)
  if (!files.length) fail('The selected subdir contains no files')
}

async function ensureDirectories(root: string, target: string, known: Set<string>): Promise<void> {
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('Archive parent directory is outside the root')
  const resolved = path.resolve(target)
  if (known.has(resolved)) return
  await ensureDirectoryChain(resolved, path.resolve(root))
  known.add(resolved)
}

async function ensureDirectoryChain(target: string, boundary?: string): Promise<void> {
  const resolved = path.resolve(target)
  const resolvedBoundary = boundary ? path.resolve(boundary) : undefined
  if (resolvedBoundary && resolved !== resolvedBoundary && !resolved.startsWith(`${resolvedBoundary}${path.sep}`)) fail('Archive staging path is outside the root')
  const parsed = path.parse(resolved)
  const parts = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)
  const missing: string[] = []
  let current = parsed.root
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await fs.lstat(current).catch((error) => {
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return null
      throw error
    })
    if (!stat) {
      missing.push(current)
      continue
    }
    if (missing.length > 0) fail('Archive staging ancestor changed during validation')
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Archive staging ancestor contains a symlink')
  }
  for (const directory of missing) {
    await fs.mkdir(directory).catch((error) => {
      if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== 'EEXIST') throw error
    })
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Archive staging ancestor contains a symlink')
  }
}

export async function packageTreeIntegrity(root: string): Promise<{ packageSha: string; files: string[] }> {
  const rootStat = await fs.lstat(root).catch(() => null)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) fail('Package root is invalid', 'PACKAGE_INTEGRITY_INVALID')
  const entries: Array<{ relative: string; size: number; hash: string; kind: 'file' | 'dir' }> = []
  const canonicalEntries = new Set<string>()
  let totalBytes = 0
  async function walk(current: string, relative: string, depth: number): Promise<void> {
    if (depth > MAX_TREE_DEPTH) fail('Package tree is too deep', 'PACKAGE_INTEGRITY_INVALID')
    const directory = await fs.opendir(current)
    try {
      for await (const child of directory) {
      const next = relative ? `${relative}/${child.name}` : child.name
      const canonical = canonicalPath(next)
      if (canonicalEntries.has(canonical)) fail('Package tree contains a case/unicode collision', 'PACKAGE_INTEGRITY_INVALID')
      canonicalEntries.add(canonical)
      if (entries.length >= MAX_ENTRIES) fail('Package tree contains too many entries', 'PACKAGE_INTEGRITY_INVALID')
      const absolute = path.join(current, child.name)
      const stat = await fs.lstat(absolute)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail('Package tree contains a symlink/special file', 'PACKAGE_INTEGRITY_INVALID')
      if (stat.isDirectory()) {
        entries.push({ relative: canonical, size: 0, hash: '', kind: 'dir' })
        await walk(absolute, next, depth + 1)
      } else {
        if (stat.size > MAX_FILE_BYTES) fail('Package file exceeds the integrity limit', 'PACKAGE_INTEGRITY_INVALID')
        totalBytes += stat.size
        if (totalBytes > MAX_TOTAL_BYTES) fail('Package tree exceeds the integrity limit', 'PACKAGE_INTEGRITY_INVALID')
        const bytes = await fs.readFile(absolute)
        if (bytes.length !== stat.size) fail('Package file changed during validation', 'PACKAGE_INTEGRITY_INVALID')
        entries.push({ relative: canonical, size: bytes.length, hash: crypto.createHash('sha256').update(bytes).digest('hex'), kind: 'file' })
      }
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
  }
  await walk(root, '', 0)
  entries.sort((a, b) => a.relative.localeCompare(b.relative) || a.kind.localeCompare(b.kind))
  const lines = entries.map((entry) => `${entry.kind}\0${entry.relative}\0${entry.size}\0${entry.hash}`)
  return { packageSha: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'), files: entries.map((entry) => entry.relative) }
}

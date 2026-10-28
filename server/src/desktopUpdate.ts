import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { config, serverRootDir } from './config.js'
import { readBuildInfo, type BuildInfo } from './buildInfo.js'
import { listZipEntries, readZipEntry, type ZipEntry } from './zipExtract.js'
import { desktopUpdatePolicy, type DesktopUpdatePolicy } from './desktopUpdatePolicy.js'
import type {
  DesktopUpdateCurrent,
  DesktopUpdatePrepareRequest,
  DesktopUpdateRelease,
  DesktopUpdateStatus,
} from '../../packages/desktop-updates/protocol.js'

const execFileAsync = promisify(execFile)
const MAX_ARCHIVE_BYTES = 1_500 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_MANIFEST_BYTES = 256 * 1024
const STATE_FILE = 'desktop-update.json'
const JOB_FILE = 'desktop-update-job.json'
const HELPER_OWNER_FILE = 'desktop-update-helper.json'
const GITHUB_HOST = 'api.github.com'
const RELEASE_HOST = 'github.com'

export class DesktopUpdateError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code = 'update-error', status = 400) {
    super(message)
    this.name = 'DesktopUpdateError'
    this.code = code
    this.status = status
  }
}

export interface DesktopUpdateRuntime {
  /** Close the generation gate and perform the existing lifecycle shutdown. */
  requestShutdown: () => void | Promise<void>
  port: number
}

export interface DesktopUpdateServiceOptions {
  rootDir?: string
  dataDir?: string
  policy?: DesktopUpdatePolicy
  platform?: NodeJS.Platform
  arch?: string
  fetcher?: typeof fetch
  git?: (args: readonly string[], cwd: string) => Promise<string>
  current?: (root: string) => BuildInfo
  now?: () => number
  helperPath?: string
  spawnProcess?: typeof spawn
}

interface ReleaseManifestPlatform {
  platform: 'win32' | 'darwin'
  arch: 'x64' | 'arm64'
  file: string
  sha256: string
  size: number
}

interface ReleaseManifest {
  format: 'canai-desktop-update'
  schemaVersion: 1
  edition: 'local'
  version: string
  commit: string
  date?: string | null
  notes?: string[]
  platforms: ReleaseManifestPlatform[]
}

interface GithubAsset {
  name: string
  size?: number
  url?: string
  browser_download_url?: string
}

interface GithubRelease {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  published_at?: unknown
  assets?: unknown
}

interface PreparedJob {
  jobId: string
  rootDir: string
  dataDir: string
  stageRoot: string
  target: string
  edition: 'full' | 'local'
  expectedCurrent: string | null
  currentVersion: string
  currentDate: string | null
  latest: DesktopUpdateRelease
  oldPid: number
  port: number
  platform: 'win32' | 'darwin'
  arch: 'x64' | 'arm64'
  managedPaths: string[]
  protectedPaths: string[]
  launcher: { windows: 'start.ps1'; macos: 'start.command' }
  statePath: string
  helperPath?: string
  helperToken?: string
  helperPid?: number
  helperStartedAt?: string
  createdAt: string
}

interface StateRecord {
  status: DesktopUpdateStatus
  job?: PreparedJob
}

interface PackagedGitContext {
  repoRoot: string
  sourceRoot: string
  currentCommit: string
  targetCommit: string
}

export interface SafeExtractOptions {
  maxEntries?: number
  maxBytes?: number
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DesktopUpdateError(`Invalid ${field}`, 'invalid-release', 502)
  return value.trim()
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false
  const parts = value.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

function isProtectedRelative(relativePath: string, protectedPaths: readonly string[]): boolean {
  const name = relativePath.replaceAll('\\', '/')
  const isProtectedEnvPart = (part: string) => part === '.env' || (part.startsWith('.env.') && part !== '.env.example')
  if (isProtectedEnvPart(name) || name.split('/').some(isProtectedEnvPart)) return true
  return protectedPaths.some((protectedPath) => name === protectedPath || name.startsWith(`${protectedPath}/`))
}

function centralMetadataMap(zip: Buffer): Map<number, { external: number; creator: number }> {
  const map = new Map<number, { external: number; creator: number }>()
  const earliest = Math.max(0, zip.length - 22 - 0xffff)
  let eocd = -1
  for (let at = zip.length - 22; at >= earliest; at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) { eocd = at; break }
  }
  if (eocd < 0) throw new DesktopUpdateError('Archive is corrupted: end-of-central-directory record not found', 'invalid-archive', 422)
  const total = zip.readUInt16LE(eocd + 10)
  const directoryOffset = zip.readUInt32LE(eocd + 16)
  let cursor = directoryOffset
  for (let index = 0; index < total; index++) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014b50) throw new DesktopUpdateError('Archive is corrupted: failed to read file metadata', 'invalid-archive', 422)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    map.set(zip.readUInt32LE(cursor + 42), { external: zip.readUInt32LE(cursor + 38), creator: zip.readUInt16LE(cursor + 4) })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return map
}

function hasSymlinkAttributes(metadata: Map<number, { external: number; creator: number }>, entry: ZipEntry): boolean {
  const record = metadata.get(entry.localHeaderOffset)
  if (!record) throw new DesktopUpdateError(`Archive is corrupted: missing metadata for ${entry.name}`, 'invalid-archive', 422)
  const { external } = record
  // Unix mode is in the high 16 bits of external attributes.  Some Windows
  // archivers omit the Unix creator byte, while reparse points use the DOS
  // FILE_ATTRIBUTE_REPARSE_POINT bit, so accept either marker.
  const unixMode = external >>> 16
  return (unixMode & 0xf000) === 0xa000 || (external & 0x400) !== 0
}

/** Extract a release archive without following paths, symlinks, or ZIP bombs. */
export async function extractSafeZip(zip: Buffer, destination: string, options: SafeExtractOptions = {}): Promise<string> {
  const maxEntries = options.maxEntries ?? MAX_ARCHIVE_ENTRIES
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES
  const entries = listZipEntries(zip)
  const metadata = centralMetadataMap(zip)
  if (entries.length > maxEntries) throw new DesktopUpdateError('Update archive has too many entries', 'invalid-archive', 422)
  let totalBytes = 0
  const seen = new Set<string>()
  await fsp.mkdir(destination, { recursive: true })
  for (const entry of entries) {
    const relative = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name
    if (!isSafeRelativePath(relative)) throw new DesktopUpdateError(`Unsafe archive path: ${entry.name}`, 'invalid-archive', 422)
    if (!relative) continue
    if (seen.has(relative)) throw new DesktopUpdateError(`Duplicate archive path: ${relative}`, 'invalid-archive', 422)
    seen.add(relative)
    if (hasSymlinkAttributes(metadata, entry)) throw new DesktopUpdateError(`Symlinks are not allowed: ${relative}`, 'invalid-archive', 422)
    totalBytes += entry.uncompressedSize
    if (totalBytes > maxBytes) throw new DesktopUpdateError('Update archive is too large', 'invalid-archive', 422)
    const target = path.resolve(destination, relative)
    if (!target.startsWith(`${path.resolve(destination)}${path.sep}`)) throw new DesktopUpdateError(`Unsafe archive path: ${relative}`, 'invalid-archive', 422)
    if (entry.name.endsWith('/')) {
      await fsp.mkdir(target, { recursive: true })
      continue
    }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const data = readZipEntry(zip, entry)
    await fsp.writeFile(target, data, { flag: 'wx', mode: 0o644 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new DesktopUpdateError(`Duplicate archive path: ${relative}`, 'invalid-archive', 422)
      throw error
    })
  }
  return await findArchiveRoot(destination)
}

async function findArchiveRoot(destination: string): Promise<string> {
  const direct = path.join(destination, 'package.json')
  try {
    await fsp.access(direct)
    return destination
  } catch {
    // Releases commonly contain one top-level folder. Keep the search bounded
    // and reject an ambiguous archive rather than guessing a code root.
  }
  const children = await fsp.readdir(destination, { withFileTypes: true })
  const candidates: string[] = []
  for (const child of children) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue
    try {
      await fsp.access(path.join(destination, child.name, 'package.json'))
      candidates.push(path.join(destination, child.name))
    } catch { /* no package root */ }
  }
  if (candidates.length !== 1) throw new DesktopUpdateError('Update archive has no unambiguous package root', 'invalid-archive', 422)
  return candidates[0]
}

async function walkFiles(root: string, protectedPaths: readonly string[], relative = '', output: string[] = []): Promise<string[]> {
  const directory = path.join(root, relative)
  const entries = await fsp.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    if (isProtectedRelative(rel, protectedPaths)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new DesktopUpdateError(`Symlinks are not allowed in update tree: ${rel}`, 'invalid-archive', 422)
    if (entry.isDirectory()) await walkFiles(root, protectedPaths, rel, output)
    else if (entry.isFile()) output.push(rel)
  }
  return output
}

async function ensureDestinationParents(root: string, target: string): Promise<void> {
  const base = path.resolve(root)
  const parent = path.dirname(path.resolve(target))
  if (parent !== base && !parent.startsWith(`${base}${path.sep}`)) throw new DesktopUpdateError(`Unsafe destination path: ${target}`, 'invalid-archive', 422)
  let cursor = base
  for (const segment of path.relative(base, parent).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    try {
      const stat = await fsp.lstat(cursor)
      if (stat.isSymbolicLink()) throw new DesktopUpdateError(`Symlinked destination parent: ${segment}`, 'invalid-archive', 422)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') break
      throw error
    }
  }
}

/** Files produced while making a ZIP rather than tracked source files. */
function isPackagedGeneratedPath(relativePath: string): boolean {
  const name = relativePath.replaceAll('\\', '/')
  return name === 'build-info.json' || name === 'THIRD-PARTY-LICENSES.txt' || name === 'client/dist' || name.startsWith('client/dist/')
}

function isGeneratedLicenseDocument(value: Buffer): boolean {
  if (value.includes(0) || value.length > 64 * 1024 * 1024) return false
  const lines = value.toString('utf8').replace(/\r\n?/gu, '\n').split('\n')
  if (lines[0] !== 'CanAI — third-party production dependency licenses' ||
      lines[1] !== 'Generated by scripts/generate-third-party.mjs from installed production packages.' ||
      lines[2] !== 'Do not edit this file manually.') return false
  const packageCount = lines[4]?.match(/^Packages: (\d+)$/u)
  if (!packageCount) return false
  const packageLines = lines.filter((line) => line.startsWith('PACKAGE: '))
  return packageLines.length === Number(packageCount[1]) && packageLines.every((line) => /^PACKAGE: (?:@[^/\s]+\/[^@\s]+|[^@\s]+)@[^\s]+$/u.test(line))
}

function normalizeTextForCompare(value: Buffer): Buffer {
  // Git checkout settings may give the packaged copy CRLF while `git archive`
  // gives LF.  Normalize only text; binary files must remain byte-for-byte.
  if (value.includes(0)) return value
  return Buffer.from(value.toString('utf8').replace(/\r\n?/gu, '\n'), 'utf8')
}

function equivalentSourceFile(left: Buffer, right: Buffer): boolean {
  return left.equals(right) || normalizeTextForCompare(left).equals(normalizeTextForCompare(right))
}

async function readOptionalFile(file: string): Promise<Buffer | null> {
  try { return await fsp.readFile(file) } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * A distribution has no `.git`, but it still contains source files.  Before
 * creating metadata in that directory compare every shipped source file with
 * the trusted build commit.  The only generated tree is the prebuilt client;
 * build-info is checked separately by the caller.
 */
async function validatePackagedSource(root: string, trustedRoot: string, protectedPaths: readonly string[]): Promise<void> {
  const files = await walkFiles(root, protectedPaths)
  for (const relative of files) {
    if (isPackagedGeneratedPath(relative)) {
      if (relative === 'THIRD-PARTY-LICENSES.txt') {
        const license = await fsp.readFile(path.join(root, relative))
        if (!isGeneratedLicenseDocument(license)) throw new DesktopUpdateError('Generated third-party license inventory is invalid', 'packaged-license-invalid', 409)
      }
      continue
    }
    const currentPath = path.join(root, relative)
    const trustedPath = path.join(trustedRoot, relative)
    const trusted = await readOptionalFile(trustedPath)
    if (!trusted) throw new DesktopUpdateError(`Packaged copy contains an unexpected source file: ${relative}`, 'packaged-source-unexpected', 409)
    const current = await fsp.readFile(currentPath)
    if (equivalentSourceFile(current, trusted)) continue
    // make-dist may replace this documentation entry with the public protocol
    // while keeping the tracked path.  Accept exactly that deterministic
    // source, never an arbitrary edited README.
    if (relative === 'docs/agents/README.md') {
      const protocol = await readOptionalFile(path.join(trustedRoot, 'docs/public/AGENT-PROTOCOL.md'))
      if (protocol && equivalentSourceFile(current, protocol)) continue
    }
    throw new DesktopUpdateError(`Packaged source differs from build ${relative}`, 'packaged-source-changed', 409)
  }
}

/** Populate only absent tracked files; existing files were validated above. */
async function populateMissingTrackedSource(trustedRoot: string, destinationRoot: string, protectedPaths: readonly string[]): Promise<void> {
  const files = await walkFiles(trustedRoot, protectedPaths)
  for (const relative of files) {
    if (isPackagedGeneratedPath(relative)) continue
    const destination = path.resolve(destinationRoot, relative)
    if (!destination.startsWith(`${path.resolve(destinationRoot)}${path.sep}`)) throw new DesktopUpdateError(`Unsafe bootstrap destination: ${relative}`, 'invalid-tree', 409)
    try {
      const stat = await fsp.lstat(destination)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new DesktopUpdateError(`A packaged path collides with tracked source: ${relative}`, 'packaged-source-collision', 409)
      continue
    } catch (error) {
      if (error instanceof DesktopUpdateError) throw error
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    const source = path.join(trustedRoot, relative)
    await ensureDestinationParents(destinationRoot, destination)
    await fsp.mkdir(path.dirname(destination), { recursive: true })
    await fsp.copyFile(source, destination)
  }
}

async function restoreGeneratedProtocolReadme(trustedRoot: string, destinationRoot: string): Promise<void> {
  const packaged = path.join(destinationRoot, 'docs/agents/README.md')
  const protocol = await readOptionalFile(path.join(trustedRoot, 'docs/public/AGENT-PROTOCOL.md'))
  const tracked = await readOptionalFile(path.join(trustedRoot, 'docs/agents/README.md'))
  if (!protocol || !tracked) return
  const current = await readOptionalFile(packaged)
  if (current && equivalentSourceFile(current, protocol)) {
    await ensureDestinationParents(destinationRoot, packaged)
    await fsp.copyFile(path.join(trustedRoot, 'docs/agents/README.md'), packaged)
  }
}

async function restoreGeneratedLicenseOverlay(trustedRoot: string, destinationRoot: string): Promise<void> {
  const packagedPath = path.join(destinationRoot, 'THIRD-PARTY-LICENSES.txt')
  const current = await readOptionalFile(packagedPath)
  const trusted = await readOptionalFile(path.join(trustedRoot, 'THIRD-PARTY-LICENSES.txt'))
  if (!current || !trusted || equivalentSourceFile(current, trusted)) return
  if (!isGeneratedLicenseDocument(current)) throw new DesktopUpdateError('Generated third-party license inventory is invalid', 'packaged-license-invalid', 409)
  const backupRoot = path.join(destinationRoot, 'artifacts', '.tmp')
  await ensureDestinationParents(destinationRoot, path.join(backupRoot, 'placeholder'))
  await fsp.mkdir(backupRoot, { recursive: true })
  const backup = path.join(backupRoot, `desktop-update-license-overlay-${sha256(current)}.txt`)
  try { await fsp.writeFile(backup, current, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
  }
  // Git must see the tracked source blob during the first bootstrap.  Keep the
  // generated ZIP inventory in artifacts/.tmp for recovery/audit instead of
  // silently discarding it.
  await fsp.copyFile(path.join(trustedRoot, 'THIRD-PARTY-LICENSES.txt'), packagedPath)
}

async function hasGitMetadata(root: string): Promise<boolean> {
  try {
    const stat = await fsp.lstat(path.join(root, '.git'))
    if (stat.isSymbolicLink()) throw new DesktopUpdateError('The packaged .git path is a symlink', 'invalid-git-root', 409)
    return true
  } catch (error) {
    if (error instanceof DesktopUpdateError) throw error
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Copy a disposable repository's metadata without asking Git to fetch from a
 * partial/promisor repository.  A `git fetch <local-partial-repo>` can try to
 * lazy-hydrate missing blobs and fail with "lazy fetching disabled" or a bad
 * pack, while the repository already has the validated commit/tree objects we
 * need.  Copying the metadata and object store keeps its official origin and
 * promisor/filter configuration intact for later network fetches.
 */
async function copyGitMetadata(sourceGit: string, destinationGit: string): Promise<void> {
  const sourceStat = await fsp.lstat(sourceGit)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new DesktopUpdateError('Trusted Git metadata is not a directory', 'invalid-git-root', 409)
  const copy = async (source: string, destination: string): Promise<void> => {
    const entries = await fsp.readdir(source, { withFileTypes: true })
    await fsp.mkdir(destination, { recursive: true })
    for (const entry of entries) {
      const from = path.join(source, entry.name)
      const to = path.join(destination, entry.name)
      if (entry.isSymbolicLink()) throw new DesktopUpdateError(`Trusted Git metadata contains a symlink: ${entry.name}`, 'invalid-git-root', 409)
      if (entry.isDirectory()) {
        await copy(from, to)
        continue
      }
      if (!entry.isFile()) throw new DesktopUpdateError(`Trusted Git metadata contains an unsupported entry: ${entry.name}`, 'invalid-git-root', 409)
      await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL)
      try {
        const mode = (await fsp.stat(from)).mode & 0o777
        await fsp.chmod(to, mode)
      } catch { /* metadata remains usable with the destination default mode */ }
    }
  }
  await copy(sourceGit, destinationGit)
}

/** Overlay only managed files. Existing user files are never pruned. */
export async function overlayManagedTree(sourceRoot: string, destinationRoot: string, managedPaths: readonly string[], protectedPaths: readonly string[]): Promise<number> {
  let copied = 0
  for (const managedPath of managedPaths) {
    if (isProtectedRelative(managedPath, protectedPaths)) continue
    const source = path.join(sourceRoot, managedPath)
    let sourceStat: fs.Stats
    try { sourceStat = await fsp.lstat(source) } catch { continue }
    if (sourceStat.isSymbolicLink()) throw new DesktopUpdateError(`Symlinks are not allowed in update tree: ${managedPath}`, 'invalid-archive', 422)
    const files = sourceStat.isDirectory() ? await walkFiles(sourceRoot, protectedPaths, managedPath) : [managedPath]
    for (const relative of files) {
      if (isProtectedRelative(relative, protectedPaths) || !isSafeRelativePath(relative)) continue
      const input = path.join(sourceRoot, relative)
      const output = path.resolve(destinationRoot, relative)
      if (!output.startsWith(`${path.resolve(destinationRoot)}${path.sep}`)) throw new DesktopUpdateError(`Unsafe destination path: ${relative}`, 'invalid-archive', 422)
      const inputStat = await fsp.lstat(input)
      if (!inputStat.isFile()) continue
      await ensureDestinationParents(destinationRoot, output)
      await fsp.mkdir(path.dirname(output), { recursive: true })
      await fsp.copyFile(input, output)
      await fsp.chmod(output, inputStat.mode & 0o777).catch(() => undefined)
      copied++
    }
  }
  return copied
}

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\.git$/u, '').replace(/\/$/u, '').toLowerCase()
}

function expectedGithubOrigin(source: { owner: string; repository: string }): string[] {
  const base = `github.com/${source.owner}/${source.repository}`.toLowerCase()
  return [`https://${base}`, `http://${base}`, `git@github.com:${source.owner}/${source.repository}`.toLowerCase(), `ssh://git@github.com/${source.owner}/${source.repository}`.toLowerCase()]
}

function releaseApiUrl(source: { owner: string; repository: string }): string {
  return `https://${GITHUB_HOST}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/releases/latest`
}

function isGithubReleaseUrl(value: string, source: { owner: string; repository: string }): boolean {
  try {
    const parsed = new URL(value)
    const expected = `/${source.owner}/${source.repository}/releases/download/`
    return parsed.protocol === 'https:' && parsed.hostname === RELEASE_HOST && parsed.pathname.startsWith(expected)
  } catch { return false }
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function parseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== 'object') throw new DesktopUpdateError('Release manifest is not an object', 'invalid-release', 502)
  const raw = value as Record<string, unknown>
  if (raw.format !== 'canai-desktop-update' || raw.schemaVersion !== 1 || raw.edition !== 'local') throw new DesktopUpdateError('Release manifest has an unsupported format', 'invalid-release', 502)
  const version = asString(raw.version, 'manifest version')
  const commit = asString(raw.commit, 'manifest commit')
  if (!/^[0-9a-f]{7,40}$/iu.test(commit)) throw new DesktopUpdateError('Release manifest commit is invalid', 'invalid-release', 502)
  if (!Array.isArray(raw.platforms) || raw.platforms.length === 0) throw new DesktopUpdateError('Release manifest has no platforms', 'invalid-release', 502)
  const platforms: ReleaseManifestPlatform[] = []
  for (const candidate of raw.platforms) {
    if (!candidate || typeof candidate !== 'object') throw new DesktopUpdateError('Release manifest platform is invalid', 'invalid-release', 502)
    const item = candidate as Record<string, unknown>
    const platform = item.platform
    const arch = item.arch
    const file = asString(item.file, 'platform file')
    const digest = asString(item.sha256, 'platform checksum')
    const size = item.size
    if (platform !== 'win32' && platform !== 'darwin') throw new DesktopUpdateError('Release manifest platform is invalid', 'invalid-release', 502)
    if (arch !== 'x64' && arch !== 'arm64') throw new DesktopUpdateError('Release manifest architecture is invalid', 'invalid-release', 502)
    if (!/^[a-f0-9]{64}$/iu.test(digest) || !Number.isSafeInteger(size) || (size as number) < 1 || file.includes('/') || file.includes('\\')) throw new DesktopUpdateError('Release manifest archive descriptor is invalid', 'invalid-release', 502)
    platforms.push({ platform, arch, file, sha256: digest.toLowerCase(), size: size as number })
  }
  return {
    format: 'canai-desktop-update', schemaVersion: 1, edition: 'local', version, commit,
    date: typeof raw.date === 'string' ? raw.date : null,
    notes: Array.isArray(raw.notes) ? raw.notes.filter((note): note is string => typeof note === 'string').slice(0, 20) : [],
    platforms,
  }
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.ok) throw new DesktopUpdateError(`Update source returned HTTP ${response.status}`, 'update-source', 502)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new DesktopUpdateError('Update source response is too large', 'update-source', 502)
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new DesktopUpdateError('Update source response is too large', 'update-source', 502)
    return buffer
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      total += chunk.length
      if (total > maxBytes) throw new DesktopUpdateError('Update source response is too large', 'update-source', 502)
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function fetchGithubRelease(fetcher: typeof fetch, policy: DesktopUpdatePolicy, platform = process.platform, arch = process.arch): Promise<{ manifest: ReleaseManifest; zip: ReleaseManifestPlatform; zipUrl: string; latest: DesktopUpdateRelease }> {
  if (policy.source.kind !== 'release') throw new DesktopUpdateError('Release feed is unavailable for this edition', 'unsupported', 400)
  const source = policy.source
  const response = await fetcher(releaseApiUrl(source), { headers: { accept: 'application/vnd.github+json', 'user-agent': 'CanAI-desktop-updater' } })
  const release = JSON.parse((await readResponseBody(response, MAX_MANIFEST_BYTES)).toString('utf8')) as GithubRelease
  const assets = Array.isArray(release.assets) ? release.assets.filter((asset): asset is GithubAsset => Boolean(asset && typeof asset === 'object' && typeof (asset as GithubAsset).name === 'string')) : []
  const manifestAsset = assets.find((asset) => asset.name === source.manifestAsset)
  if (!manifestAsset || !manifestAsset.browser_download_url || !isGithubReleaseUrl(manifestAsset.browser_download_url, source)) throw new DesktopUpdateError('Release has no trusted update-manifest.json asset', 'no-release', 404)
  const manifestResponse = await fetcher(manifestAsset.browser_download_url, { headers: { accept: 'application/json', 'user-agent': 'CanAI-desktop-updater' } })
  const manifest = parseManifest(JSON.parse((await readResponseBody(manifestResponse, MAX_MANIFEST_BYTES)).toString('utf8')))
  const selected = manifest.platforms.find((item) => item.platform === platform && item.arch === arch)
  if (!selected) throw new DesktopUpdateError('No update is published for this platform', 'unsupported', 400)
  const zipAsset = assets.find((asset) => asset.name === selected.file)
  if (!zipAsset?.browser_download_url || !isGithubReleaseUrl(zipAsset.browser_download_url, source)) throw new DesktopUpdateError('Release archive is not a trusted asset', 'invalid-release', 502)
  const target = manifest.commit
  const notes = manifest.notes ?? (typeof release.body === 'string' && release.body ? [release.body] : [])
  return {
    manifest, zip: selected, zipUrl: zipAsset.browser_download_url,
    latest: { version: manifest.version, commit: manifest.commit, date: manifest.date ?? (typeof release.published_at === 'string' ? release.published_at : null), notes, target },
  }
}

async function defaultGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  return String(result.stdout).trim()
}

async function gitBuffer(args: readonly string[], cwd: string): Promise<Buffer> {
  const result = await execFileAsync('git', [...args], { cwd, encoding: 'buffer', windowsHide: true, maxBuffer: MAX_ARCHIVE_BYTES })
  return Buffer.from(result.stdout as Buffer)
}

function currentView(info: BuildInfo): DesktopUpdateCurrent {
  return { version: info.version, commit: info.commit, date: info.date }
}

function commitsEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  return a === b || (a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a)))
}

export class DesktopUpdateService {
  private readonly rootDir: string
  private readonly dataDir: string
  private readonly policy: DesktopUpdatePolicy
  private readonly platform: 'win32' | 'darwin'
  private readonly arch: 'x64' | 'arm64'
  private readonly fetcher: typeof fetch
  private readonly git: (args: readonly string[], cwd: string) => Promise<string>
  private readonly currentReader: (root: string) => BuildInfo
  private readonly now: () => number
  private readonly helperPath: string
  private readonly spawnProcess: typeof spawn
  private runtime: DesktopUpdateRuntime | null = null
  private state: StateRecord | null = null
  private operation: Promise<unknown> | null = null

  constructor(options: DesktopUpdateServiceOptions = {}) {
    this.rootDir = options.rootDir ? path.resolve(options.rootDir) : path.resolve(serverRootDir, '..')
    this.dataDir = path.resolve(options.dataDir ?? path.dirname(config.settingsFile))
    this.policy = options.policy ?? desktopUpdatePolicy
    const platform = options.platform ?? process.platform
    const arch = options.arch ?? process.arch
    // Keep the server importable on Linux/other hosts.  The route returns a
    // stable `unsupported` status there rather than preventing CanAI from
    // starting just because the optional desktop updater is unavailable.
    this.platform = platform as 'win32' | 'darwin'
    this.arch = arch as 'x64' | 'arm64'
    this.fetcher = options.fetcher ?? fetch
    this.git = options.git ?? defaultGit
    this.currentReader = options.current ?? ((root) => readBuildInfo(root))
    this.now = options.now ?? (() => Date.now())
    this.helperPath = options.helperPath ?? path.join(serverRootDir, 'src', 'desktopUpdateHelper.mjs')
    this.spawnProcess = options.spawnProcess ?? spawn
  }

  attachRuntime(runtime: DesktopUpdateRuntime): void {
    this.runtime = runtime
  }

  private statePath(): string { return path.join(this.dataDir, STATE_FILE) }
  private jobPath(): string { return path.join(this.dataDir, JOB_FILE) }
  private helperOwnerPath(): string { return path.join(this.dataDir, HELPER_OWNER_FILE) }

  private async saveJob(job: PreparedJob): Promise<void> {
    await fsp.mkdir(this.dataDir, { recursive: true })
    const temporary = `${this.jobPath()}.tmp-${process.pid}-${this.now()}`
    await fsp.writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 })
    await fsp.rename(temporary, this.jobPath())
  }

  private async helperAlive(job: PreparedJob): Promise<boolean> {
    if (!Number.isInteger(job.helperPid) || (job.helperPid ?? 0) <= 0) return false
    try { process.kill(job.helperPid!, 0); return true } catch (error) { return (error as NodeJS.ErrnoException)?.code === 'EPERM' }
  }

  private async reconcileRestarting(record: StateRecord): Promise<StateRecord> {
    const job = record.job
    if (!job) return record
    const alive = await this.helperAlive(job)
    let ownerMatches = false
    try {
      const owner = JSON.parse(await fsp.readFile(this.helperOwnerPath(), 'utf8')) as Record<string, unknown>
      ownerMatches = owner.jobId === job.jobId && owner.helperToken === (job.helperToken ?? null) && owner.pid === job.helperPid
    } catch { /* helper may not have journaled its PID yet */ }
    if (alive && ownerMatches) return record
    const age = job.helperStartedAt ? this.now() - Date.parse(job.helperStartedAt) : Number.POSITIVE_INFINITY
    // A freshly persisted restarting record may precede the detached child's
    // PID journal by a few milliseconds. Give that handoff a bounded grace
    // period, then make an interrupted update explicit instead of polling a
    // dead job forever.
    if (Number.isFinite(age) && age < 30_000) return record
    const interrupted: DesktopUpdateStatus = {
      ...record.status,
      phase: 'error',
      jobId: job.jobId,
      code: 'update-interrupted',
      message: `Desktop update helper stopped before completion; prepared files and recovery journal were retained at ${job.stageRoot}`,
    }
    const next = { status: interrupted, job }
    await this.saveState(next)
    return next
  }

  private async loadState(): Promise<StateRecord | null> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.statePath(), 'utf8')) as StateRecord
      if (raw && raw.status && typeof raw.status.phase === 'string') this.state = raw
    } catch { /* first run */ }
    return this.state
  }

  private async saveState(record: StateRecord): Promise<void> {
    this.state = record
    await fsp.mkdir(this.dataDir, { recursive: true })
    const temp = `${this.statePath()}.tmp-${process.pid}-${this.now()}`
    await fsp.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await fsp.rename(temp, this.statePath())
  }

  private baseStatus(info = this.currentReader(this.rootDir)): DesktopUpdateStatus {
    return { phase: 'idle', edition: this.policy.edition, current: currentView(info) }
  }

  async status(): Promise<DesktopUpdateStatus> {
    const info = this.currentReader(this.rootDir)
    const existing = await this.loadState()
    if (!existing) return this.baseStatus(info)
    const reconciled = existing.status.phase === 'restarting' ? await this.reconcileRestarting(existing) : existing
    return { ...reconciled.status, edition: this.policy.edition, current: currentView(info) }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operation) throw new DesktopUpdateError('Another desktop update operation is already running', 'busy', 409)
    const promise = operation()
    this.operation = promise
    try { return await promise } finally { if (this.operation === promise) this.operation = null }
  }

  private unsupportedStatus(info: BuildInfo): DesktopUpdateStatus {
    return { phase: 'unsupported', edition: this.policy.edition, current: currentView(info), code: 'unsupported', message: 'Desktop updater is unavailable on this platform' }
  }

  /**
   * Resolve a packaged build through a disposable trusted Git repository.  A
   * Settings check must remain read-only with respect to the installed copy;
   * only `artifacts/.tmp` is touched until prepare has validated the source.
   */
  private async packagedGitContext(info: BuildInfo): Promise<PackagedGitContext> {
    if (this.policy.source.kind !== 'git') throw new DesktopUpdateError('Git feed is unavailable for this edition', 'unsupported', 400)
    if (!info.commit || !/^[0-9a-f]{7,40}$/iu.test(info.commit)) {
      throw new DesktopUpdateError('This packaged copy has no valid build-info.json; install a verified CanAI ZIP before updating', 'missing-build-info', 409)
    }
    const source = this.policy.source
    const tempRoot = path.join(this.rootDir, 'artifacts', '.tmp')
    await fsp.mkdir(tempRoot, { recursive: true })
    const repoRoot = await fsp.mkdtemp(path.join(tempRoot, 'desktop-update-git-'))
    await this.git(['init', '-q'], repoRoot)
    await this.git(['remote', 'add', 'origin', `https://github.com/${source.owner}/${source.repository}.git`], repoRoot)
    const targetOutput = await this.git(['ls-remote', `https://github.com/${source.owner}/${source.repository}.git`, `refs/heads/${source.branch}`], repoRoot)
    const targetCommit = targetOutput.split(/\s+/u)[0] ?? ''
    if (!/^[0-9a-f]{40}$/iu.test(targetCommit)) throw new DesktopUpdateError('CanAI main branch could not be resolved', 'update-source', 502)
    // A packaged check must not clone the multi-gigabyte development history.
    // GitHub's partial clone keeps the commit/tree graph and hydrates only the
    // installed commit's blobs when the trusted source is read below.
    await this.git(['fetch', '--filter=blob:none', '--no-tags', 'origin', `refs/heads/${source.branch}:refs/remotes/origin/${source.branch}`], repoRoot)
    let currentCommit: string
    try {
      currentCommit = await this.git(['rev-parse', `${info.commit}^{commit}`], repoRoot)
    } catch {
      throw new DesktopUpdateError('The packaged build number is not present in the trusted CanAI history', 'invalid-build-info', 409)
    }
    try {
      await this.git(['merge-base', '--is-ancestor', currentCommit, targetCommit], repoRoot)
    } catch {
      throw new DesktopUpdateError('The packaged build is not an ancestor of trusted CanAI main; reinstall a verified ZIP', 'diverged-build', 409)
    }
    const archive = await gitBuffer(['archive', '--format=zip', currentCommit], repoRoot)
    const sourceRoot = await extractSafeZip(archive, path.join(repoRoot, 'trusted-source'))
    return { repoRoot, sourceRoot, currentCommit, targetCommit }
  }

  /**
   * Convert a validated no-`.git` full package into a normal clean checkout.
   * Existing tracked source is left intact; only absent tracked files and Git
   * metadata are added.  The two deterministic packager overlays are backed
   * up/restored separately. Protected data, env files, runtime and user files
   * are never copied or removed.
   */
  private async bootstrapPackagedGit(info: BuildInfo, requestedTarget?: string): Promise<string> {
    const context = await this.packagedGitContext(info)
    if (requestedTarget && requestedTarget !== context.targetCommit) {
      throw new DesktopUpdateError('Update target is no longer current; check again', 'stale-target', 409)
    }
    const rootHasGit = await hasGitMetadata(this.rootDir)
    if (rootHasGit) return info.commit ?? context.currentCommit
    await validatePackagedSource(this.rootDir, context.sourceRoot, this.policy.protectedPaths)
    await populateMissingTrackedSource(context.sourceRoot, this.rootDir, this.policy.protectedPaths)
    await restoreGeneratedProtocolReadme(context.sourceRoot, this.rootDir)
    await restoreGeneratedLicenseOverlay(context.sourceRoot, this.rootDir)
    const gitPath = path.join(this.rootDir, '.git')
    const metadataParent = await fsp.mkdtemp(path.join(path.dirname(context.repoRoot), 'desktop-update-git-metadata-'))
    const stagedGitPath = path.join(metadataParent, '.git')
    let installedGit = false
    try {
      // Transfer the validated partial repository's metadata/object store into
      // a fresh staging directory.  Do not run `git fetch context.repoRoot`:
      // that local-promisor fetch can attempt lazy blob hydration and fail
      // even though the required objects are already present.
      await copyGitMetadata(path.join(context.repoRoot, '.git'), stagedGitPath)
      // Recheck immediately before the install.  `rename` is atomic on the
      // same volume and fails when another process won the previously absent
      // `.git` path; never remove or replace that competing checkout.
      if (await hasGitMetadata(this.rootDir)) throw new DesktopUpdateError('The packaged checkout was initialized concurrently; retry the update', 'git-race', 409)
      try {
        await fsp.rename(stagedGitPath, gitPath)
      } catch (error) {
        if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw new DesktopUpdateError('The packaged checkout was initialized concurrently; retry the update', 'git-race', 409)
        throw error
      }
      installedGit = true
      await this.git(['symbolic-ref', 'HEAD', `refs/heads/${this.policy.source.kind === 'git' ? this.policy.source.branch : 'main'}`], this.rootDir)
      if (this.policy.source.kind !== 'git') throw new DesktopUpdateError('Git bootstrap is unavailable for this edition', 'unsupported', 400)
      // The copied config retains the fixed official origin and the
      // promisor/filter settings from the disposable partial clone.  Reassert
      // the target ref in case the fetch implementation packed refs only.
      await this.git(['update-ref', `refs/remotes/origin/${this.policy.source.branch}`, context.targetCommit], this.rootDir)
      await this.git(['reset', '--mixed', context.currentCommit], this.rootDir)
      const dirty = await this.git(['status', '--porcelain', '--untracked-files=all'], this.rootDir)
      if (dirty) throw new DesktopUpdateError('The packaged source could not be bootstrapped cleanly; reinstall a verified ZIP', 'bootstrap-dirty', 409)
      return context.currentCommit
    } catch (error) {
      // The source was validated before `.git` was created.  Remove only our
      // metadata on failure; user data and pre-existing files remain intact.
      if (installedGit) {
        try { await fsp.rm(gitPath, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      throw error
    } finally {
      try { await fsp.rm(metadataParent, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  async check(): Promise<DesktopUpdateStatus> {
    return this.exclusive(async () => {
      const info = this.currentReader(this.rootDir)
      if (!this.policy.supportedPlatforms.includes(this.platform) || !this.policy.supportedArchitectures.includes(this.arch)) {
        const result = this.unsupportedStatus(info); await this.saveState({ status: result }); return result
      }
      const checking: DesktopUpdateStatus = { phase: 'checking', edition: this.policy.edition, current: currentView(info), progress: { stage: 'checking', percent: 0 } }
      await this.saveState({ status: checking })
      try {
        const latest = this.policy.source.kind === 'release'
          ? (await fetchGithubRelease(this.fetcher, this.policy, this.platform, this.arch)).latest
          : await this.checkGitLatest()
        const same = commitsEqual(info.commit, latest.commit) || (info.version === latest.version && !latest.commit)
        const status: DesktopUpdateStatus = { phase: same ? 'up-to-date' : 'available', edition: this.policy.edition, current: currentView(info), latest, message: same ? 'CanAI is up to date' : 'A desktop update is available' }
        await this.saveState({ status })
        return status
      } catch (error) {
        return this.fail(info, error)
      }
    })
  }

  private async checkGitLatest(): Promise<DesktopUpdateRelease> {
    if (this.policy.source.kind !== 'git') throw new DesktopUpdateError('Git feed is unavailable for this edition', 'unsupported', 400)
    const source = this.policy.source
    const info = this.currentReader(this.rootDir)
    if (!(await hasGitMetadata(this.rootDir))) {
      const context = await this.packagedGitContext(info)
      const versionRaw = await this.git(['show', `${context.targetCommit}:package.json`], context.repoRoot)
      let version = '0.0.0'
      try { version = asString((JSON.parse(versionRaw) as { version?: unknown }).version, 'remote version') } catch (error) { if (error instanceof DesktopUpdateError) throw error }
      const date = await this.git(['show', '-s', '--format=%cI', context.targetCommit], context.repoRoot)
      return { version, commit: context.targetCommit, date: date || null, notes: [], target: context.targetCommit }
    }
    const origin = normalizeOrigin(await this.git(['remote', 'get-url', 'origin'], this.rootDir))
    if (!expectedGithubOrigin(source).includes(origin)) throw new DesktopUpdateError('Git origin is not the CanAI development repository', 'wrong-origin', 409)
    const target = await this.git(['ls-remote', `https://github.com/${source.owner}/${source.repository}.git`, `refs/heads/${source.branch}`], this.rootDir)
    const commit = target.split(/\s+/u)[0]
    if (!/^[0-9a-f]{40}$/iu.test(commit)) throw new DesktopUpdateError('CanAI main branch could not be resolved', 'update-source', 502)
    // Resolve metadata from a pinned object.  A fresh checkout may not have
    // the remote commit locally yet, so fetch only the fixed main ref before
    // reading package.json/date; this never changes the working tree.
    await this.git(['fetch', '--no-tags', 'origin', `refs/heads/${source.branch}:refs/remotes/origin/${source.branch}`], this.rootDir)
    const versionRaw = await this.git(['show', `${commit}:package.json`], this.rootDir)
    let version = '0.0.0'
    try { version = asString((JSON.parse(versionRaw) as { version?: unknown }).version, 'remote version') } catch (error) { if (error instanceof DesktopUpdateError) throw error }
    const date = await this.git(['show', '-s', '--format=%cI', commit], this.rootDir)
    return { version, commit, date: date || null, notes: [], target: commit }
  }

  private async ensureCurrentGitReady(target?: string): Promise<string | null> {
    if (this.policy.source.kind !== 'git') return this.currentReader(this.rootDir).commit
    const info = this.currentReader(this.rootDir)
    if (!(await hasGitMetadata(this.rootDir))) return await this.bootstrapPackagedGit(info, target)
    const branch = await this.git(['branch', '--show-current'], this.rootDir)
    if (branch !== this.policy.source.branch) throw new DesktopUpdateError('Current checkout is not on the updater branch', 'wrong-branch', 409)
    const dirty = await this.git(['status', '--porcelain', '--untracked-files=all'], this.rootDir)
    if (dirty) throw new DesktopUpdateError('Save or commit local changes before updating', 'dirty-tree', 409)
    const origin = normalizeOrigin(await this.git(['remote', 'get-url', 'origin'], this.rootDir))
    if (!expectedGithubOrigin(this.policy.source).includes(origin)) throw new DesktopUpdateError('Git origin is not the CanAI development repository', 'wrong-origin', 409)
    await this.git(['fetch', '--no-tags', 'origin', `refs/heads/${this.policy.source.branch}:refs/remotes/origin/${this.policy.source.branch}`], this.rootDir)
    return info.commit
  }

  async prepare(request: DesktopUpdatePrepareRequest): Promise<DesktopUpdateStatus> {
    return this.exclusive(async () => {
      const info = this.currentReader(this.rootDir)
      const target = typeof request?.target === 'string' ? request.target.trim() : ''
      if (!target || target.length > 160) throw new DesktopUpdateError('A valid update target is required', 'invalid-target', 400)
      const existing = await this.loadState()
      const latest = existing?.status.latest?.target === target ? existing.status.latest : null
      const releaseContext = this.policy.source.kind === 'release' ? await fetchGithubRelease(this.fetcher, this.policy, this.platform, this.arch) : null
      const resolved = releaseContext?.latest ?? latest ?? await this.checkGitLatest()
      if (resolved.target !== target) throw new DesktopUpdateError('Update target is no longer current; check again', 'stale-target', 409)
      const preparing: DesktopUpdateStatus = { phase: 'preparing', edition: this.policy.edition, current: currentView(info), latest: resolved, progress: { stage: 'preparing', percent: 0 } }
      await this.saveState({ status: preparing })
      try {
        const expectedCurrent = await this.ensureCurrentGitReady(resolved.target)
        const updateTempRoot = path.join(this.rootDir, 'artifacts', '.tmp')
        await fsp.mkdir(updateTempRoot, { recursive: true })
        const stageParent = await fsp.mkdtemp(path.join(updateTempRoot, 'desktop-update-'))
        const stage = path.join(stageParent, 'payload')
        await fsp.mkdir(stage, { recursive: true })
        const helperCopy = path.join(stageParent, 'desktopUpdateHelper.mjs')
        await fsp.copyFile(this.helperPath, helperCopy)
        let sourceRoot = stage
        if (releaseContext) {
          const response = await this.fetcher(releaseContext.zipUrl, { headers: { accept: 'application/octet-stream', 'user-agent': 'CanAI-desktop-updater' } })
          const bytes = await readResponseBody(response, MAX_ARCHIVE_BYTES)
          if (bytes.length !== releaseContext.zip.size || sha256(bytes) !== releaseContext.zip.sha256) throw new DesktopUpdateError('Update archive checksum or size does not match the release manifest', 'checksum-mismatch', 502)
          sourceRoot = await extractSafeZip(bytes, stage)
        } else {
          const bytes = await gitBuffer(['archive', '--format=zip', resolved.target], this.rootDir)
          sourceRoot = await extractSafeZip(bytes, stage)
        }
        const jobId = crypto.randomUUID()
        const job: PreparedJob = {
          jobId, rootDir: this.rootDir, dataDir: this.dataDir, stageRoot: sourceRoot,
          target: resolved.target, edition: this.policy.edition, expectedCurrent,
          currentVersion: info.version, currentDate: info.date, latest: resolved,
          oldPid: process.pid, port: this.runtime?.port ?? config.port,
          platform: this.platform, arch: this.arch,
          managedPaths: [...this.policy.managedPaths], protectedPaths: [...this.policy.protectedPaths], launcher: this.policy.launcher,
          statePath: this.statePath(), helperPath: helperCopy, createdAt: new Date(this.now()).toISOString(),
        }
        await this.saveJob(job)
        const ready: DesktopUpdateStatus = { phase: 'ready', edition: this.policy.edition, current: currentView(info), latest: resolved, jobId, progress: { stage: 'ready', percent: 100 }, message: 'Update is ready to install' }
        await this.saveState({ status: ready, job })
        return ready
      } catch (error) {
        return this.fail(info, error, resolved)
      }
    })
  }

  /** Start archive preparation without holding the HTTP request open. */
  startPrepare(request: DesktopUpdatePrepareRequest): DesktopUpdateStatus {
    if (this.operation) throw new DesktopUpdateError('Another desktop update operation is already running', 'busy', 409)
    const info = this.currentReader(this.rootDir)
    if (!this.policy.supportedPlatforms.includes(this.platform) || !this.policy.supportedArchitectures.includes(this.arch)) return this.unsupportedStatus(info)
    const target = typeof request?.target === 'string' ? request.target.trim() : ''
    if (!target || target.length > 160) throw new DesktopUpdateError('A valid update target is required', 'invalid-target', 400)
    const status: DesktopUpdateStatus = { phase: 'preparing', edition: this.policy.edition, current: currentView(info), progress: { stage: 'preparing', percent: 0 }, message: 'Preparing update' }
    this.state = { status }
    void this.prepare(request).catch(async (error) => { try { await this.fail(info, error) } catch { /* state journal best effort */ } })
    return status
  }

  async apply(jobId: string): Promise<DesktopUpdateStatus> {
    return this.exclusive(async () => {
      const info = this.currentReader(this.rootDir)
      const state = await this.loadState()
      if (!state?.job || state.job.jobId !== jobId || state.status.phase !== 'ready') throw new DesktopUpdateError('Update is not prepared or has expired', 'invalid-job', 409)
      if (!this.runtime) throw new DesktopUpdateError('Updater lifecycle is not ready', 'not-ready', 503)
      const helperToken = crypto.randomUUID()
      const helperJob: PreparedJob = { ...state.job, helperToken, helperPid: undefined, helperStartedAt: new Date(this.now()).toISOString() }
      const restarting: DesktopUpdateStatus = { ...state.status, phase: 'restarting', progress: { stage: 'stopping CanAI safely', percent: 0 }, message: 'CanAI is preparing to restart' }
      await this.saveState({ status: restarting, job: helperJob })
      // The detached child reads this file, so persist the token before spawn;
      // journaling it only in desktop-update.json creates an owner mismatch.
      await this.saveJob(helperJob)
      const helper = helperJob.helperPath ?? this.helperPath
      let child: ReturnType<typeof spawn>
      try {
        child = this.spawnProcess(process.execPath, [helper, this.jobPath()], { detached: true, stdio: 'ignore', windowsHide: true })
      } catch (error) {
        return this.fail(info, error, state.status.latest)
      }
      const runningJob: PreparedJob = { ...helperJob, helperPid: child.pid ?? undefined }
      await this.saveState({ status: restarting, job: runningJob })
      await this.saveJob(runningJob)
      child.once('error', (error) => { void this.fail(info, error, state.status.latest) })
      child.unref()
      try {
        await this.runtime.requestShutdown()
      } catch (error) {
        try { child.kill() } catch { /* best effort */ }
        return this.fail(info, error, state.status.latest)
      }
      return restarting
    })
  }

  private async fail(info: BuildInfo, error: unknown, latest?: DesktopUpdateRelease): Promise<DesktopUpdateStatus> {
    const code = error instanceof DesktopUpdateError ? error.code : 'update-error'
    const message = error instanceof Error ? error.message : 'Desktop update failed'
    const status: DesktopUpdateStatus = { phase: 'error', edition: this.policy.edition, current: currentView(info), ...(latest ? { latest } : {}), code, message }
    await this.saveState({ status })
    return status
  }
}

export function createDesktopUpdateService(options: DesktopUpdateServiceOptions = {}): DesktopUpdateService {
  return new DesktopUpdateService(options)
}

export { parseManifest as validateReleaseManifest, isSafeRelativePath }

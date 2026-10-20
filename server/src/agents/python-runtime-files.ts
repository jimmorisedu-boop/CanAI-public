import crypto from 'node:crypto'
import fsNative from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AgentPackageError } from './package-errors.js'

export const PORTABLE_PYTHON_VERSION = '3.13.16'
export const PORTABLE_PYTHON_ARCHIVE_URL = `https://www.python.org/ftp/python/${PORTABLE_PYTHON_VERSION}/python-${PORTABLE_PYTHON_VERSION}-embed-amd64.zip`
export const PORTABLE_PYTHON_ARCHIVE_SHA256 = '97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297'
export const PYTHON_RUNTIME_ARCHIVE_FILE = `python-${PORTABLE_PYTHON_VERSION}-embed-amd64.zip`
export const PYTHON_RUNTIME_RECEIPT_FILE = 'python-runtime.receipt.json'

export const MAX_RUNTIME_ARCHIVE_BYTES = 32 * 1024 * 1024
export const MAX_RUNTIME_FILE_BYTES = 64 * 1024 * 1024
export const MAX_RUNTIME_TOTAL_BYTES = 128 * 1024 * 1024
export const MAX_RUNTIME_FILES = 256

const SHA256_RE = /^[a-f0-9]{64}$/u
const ENVIRONMENT_ID_RE = /^[a-f0-9]{32}$/u

export interface PythonRuntimeMetadata {
  kind: 'python'
  version: string
  integrity: string
  environmentId: string
  executableRelative: string
  stdlibIntegrity: string
  treeSha: string
  archiveSha?: string
}

export interface PythonRuntimeReceipt {
  schemaVersion: 1
  sourceUrl: typeof PORTABLE_PYTHON_ARCHIVE_URL
  archiveSha: string
  runtime: PythonRuntimeMetadata
}

export interface PythonRuntimeTree {
  treeSha: string
  files: string[]
  byName: Map<string, string>
}

export interface RequiredPythonRuntimeFiles {
  executable: string
  stdlib: string
  dll: string
  pth: string
}

export function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function runtimeRoot(runtimeDir: string): string {
  if (typeof runtimeDir !== 'string' || !runtimeDir.trim()) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Portable runtime directory is not set', 422)
  return path.resolve(runtimeDir, `python-${PORTABLE_PYTHON_VERSION}`)
}

export function receiptPath(runtimeDir: string): string {
  if (typeof runtimeDir !== 'string' || !runtimeDir.trim()) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Portable runtime directory is not set', 422)
  return path.resolve(runtimeDir, PYTHON_RUNTIME_RECEIPT_FILE)
}

export function relativeSafe(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * A portable runtime must not be reachable through a junction/symlinked
 * ancestor.  Checking only the final directory is insufficient: lstat on the
 * final path follows an ancestor junction and makes two paths address the
 * same install tree while the in-memory single-flight key still differs.
 *
 * Missing descendants are allowed (the installer creates them), but every
 * existing component up to the requested path must be a real directory.  The
 * check is intentionally scoped to the requested portable-runtime path; it
 * does not reject unrelated files elsewhere in the user's temp/profile tree.
 */
export async function assertNoSymlinkAncestors(target: string): Promise<void> {
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  let current = parsed.root
  const parts = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await fs.lstat(current).catch((error: unknown) => {
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return null
      throw error
    })
    if (!stat) break
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Portable runtime path contains a symlink or is not a directory', 409)
  }
}

export async function hashPythonRuntimeTree(root: string): Promise<PythonRuntimeTree> {
  const rootStat = await fs.lstat(root).catch(() => null)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new AgentPackageError('RUNTIME_INTEGRITY_INVALID', 'Python runtime root is invalid', 409)

  const entries: Array<{ name: string; size: number; hash: string }> = []
  const names = new Set<string>()
  let total = 0
  let entryCount = 0

  async function walk(current: string, relative: string): Promise<void> {
    const directory = await fs.opendir(current)
    try {
      const children: string[] = []
      for await (const child of directory) children.push(child.name)
      children.sort((a, b) => a.localeCompare(b, 'en'))
      for (const name of children) {
        entryCount += 1
        if (entryCount > MAX_RUNTIME_FILES) throw new AgentPackageError('RUNTIME_TOO_LARGE', 'Python runtime contains too many files', 413)
        const next = relative ? `${relative}/${name}` : name
        const canonical = next.normalize('NFC').toLocaleLowerCase('en-US')
        if (names.has(canonical)) throw new AgentPackageError('RUNTIME_INTEGRITY_INVALID', 'Python runtime contains a case/unicode collision', 409)
        names.add(canonical)
        const absolute = path.join(current, name)
        const stat = await fs.lstat(absolute)
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new AgentPackageError('RUNTIME_INTEGRITY_INVALID', 'Python runtime contains a symlink/special file', 409)
        if (stat.isDirectory()) {
          await walk(absolute, next)
          continue
        }
        if (stat.size > MAX_RUNTIME_FILE_BYTES || (total += stat.size) > MAX_RUNTIME_TOTAL_BYTES) throw new AgentPackageError('RUNTIME_TOO_LARGE', 'Python runtime exceeds the size limit', 413)
        const bytes = await fs.readFile(absolute)
        const after = await fs.lstat(absolute)
        if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || bytes.length !== stat.size) throw new AgentPackageError('RUNTIME_INTEGRITY_INVALID', 'Python runtime changed during validation', 409)
        entries.push({ name: canonical, size: bytes.length, hash: sha256(bytes) })
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
  }

  await walk(root, '')
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  const lines = entries.map((entry) => `file\0${entry.name}\0${entry.size}\0${entry.hash}`)
  const byName = new Map(entries.map((entry) => [entry.name, entry.hash]))
  return { treeSha: sha256(lines.join('\n')), files: entries.map((entry) => entry.name), byName }
}

export function requiredPythonRuntimeFiles(files: string[]): RequiredPythonRuntimeFiles {
  const executable = files.find((file) => file === 'python.exe')
  const stdlib = files.find((file) => file === 'python313.zip')
  const dll = files.find((file) => file === 'python313.dll')
  const pth = files.find((file) => file === 'python313._pth')
  if (!executable || !stdlib || !dll || !pth) throw new AgentPackageError('RUNTIME_INTEGRITY_INVALID', 'Python embeddable runtime is missing python.exe, python313.zip, python313.dll, and python313._pth', 409)
  return { executable, stdlib, dll, pth }
}

export function metadataFromTree(tree: PythonRuntimeTree, files: RequiredPythonRuntimeFiles, version: string, archiveSha: string): PythonRuntimeMetadata {
  if (!/^\d+\.\d+\.\d+$/u.test(version) || !SHA256_RE.test(archiveSha)) throw new AgentPackageError('RUNTIME_BASELINE_INVALID', 'Python runtime baseline is invalid', 409)
  const stdlibIntegrity = tree.byName.get(files.stdlib)
  if (!stdlibIntegrity || !SHA256_RE.test(stdlibIntegrity)) throw new AgentPackageError('RUNTIME_INTEGRITY_INVALID', 'Python stdlib ZIP integrity is unavailable', 409)
  const environmentId = sha256(`python\0${version}\0${tree.treeSha}`).slice(0, 32)
  return { kind: 'python', version, integrity: tree.treeSha, environmentId, executableRelative: files.executable, stdlibIntegrity, treeSha: tree.treeSha, archiveSha }
}

export function samePythonRuntimeMetadata(left: PythonRuntimeMetadata, right: PythonRuntimeMetadata): boolean {
  return left.kind === 'python'
    && right.kind === 'python'
    && left.version === right.version
    && left.integrity === right.integrity
    && left.environmentId === right.environmentId
    && left.executableRelative === right.executableRelative
    && left.stdlibIntegrity === right.stdlibIntegrity
    && left.treeSha === right.treeSha
    && left.archiveSha === right.archiveSha
}

function invalidReceipt(message: string): AgentPackageError {
  return new AgentPackageError('RUNTIME_BASELINE_INVALID', message, 409)
}

function hardLinkUnsupported(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV' || code === 'EPERM' || code === 'EINVAL' || code === 'ENOSYS'
}

async function createExclusiveFile(temp: string, file: string): Promise<void> {
  try { await fs.link(temp, file) }
  catch (error) {
    if (!hardLinkUnsupported(error)) throw error
    await fs.copyFile(temp, file, fsNative.constants.COPYFILE_EXCL)
  }
}

function parseReceipt(raw: unknown): PythonRuntimeReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidReceipt('Python runtime receipt is invalid')
  const value = raw as Record<string, unknown>
  if (value.schemaVersion !== 1 || value.sourceUrl !== PORTABLE_PYTHON_ARCHIVE_URL || typeof value.archiveSha !== 'string' || !SHA256_RE.test(value.archiveSha)) throw invalidReceipt('Python runtime receipt does not verify the official archive')
  if (value.archiveSha !== PORTABLE_PYTHON_ARCHIVE_SHA256) throw invalidReceipt('Python runtime receipt has an unknown archive SHA-256')
  if (!value.runtime || typeof value.runtime !== 'object' || Array.isArray(value.runtime)) throw invalidReceipt('Python runtime receipt has no metadata')
  const metadata = value.runtime as Record<string, unknown>
  const fields = ['version', 'integrity', 'environmentId', 'executableRelative', 'stdlibIntegrity', 'treeSha', 'archiveSha']
  if (metadata.kind !== 'python' || fields.some((field) => typeof metadata[field] !== 'string')) throw invalidReceipt('Python runtime receipt has incomplete metadata')
  const runtime = metadata as unknown as PythonRuntimeMetadata
  if (runtime.version !== PORTABLE_PYTHON_VERSION || runtime.archiveSha !== value.archiveSha || runtime.integrity !== runtime.treeSha || runtime.executableRelative !== 'python.exe' || !SHA256_RE.test(runtime.integrity) || !SHA256_RE.test(runtime.stdlibIntegrity) || !ENVIRONMENT_ID_RE.test(runtime.environmentId)) throw invalidReceipt('Python runtime receipt metadata does not match the pinned baseline')
  return { schemaVersion: 1, sourceUrl: PORTABLE_PYTHON_ARCHIVE_URL, archiveSha: value.archiveSha, runtime }
}

export async function readPythonRuntimeReceipt(runtimeDir: string): Promise<PythonRuntimeReceipt | undefined> {
  const file = receiptPath(runtimeDir)
  const stat = await fs.lstat(file).catch((error: unknown) => {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return null
    throw error
  })
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw invalidReceipt('Python runtime receipt contains a symlink or is too large')
  try { return parseReceipt(JSON.parse(await fs.readFile(file, 'utf8')) as unknown) }
  catch (error) {
    if (error instanceof AgentPackageError) throw error
    throw invalidReceipt('Python runtime receipt is not JSON')
  }
}

export async function writePythonRuntimeReceipt(runtimeDir: string, runtime: PythonRuntimeMetadata): Promise<void> {
  if (runtime.archiveSha !== PORTABLE_PYTHON_ARCHIVE_SHA256) throw invalidReceipt('Cannot write a receipt for an unverified Python archive')
  const receipt = { schemaVersion: 1 as const, sourceUrl: PORTABLE_PYTHON_ARCHIVE_URL, archiveSha: PORTABLE_PYTHON_ARCHIVE_SHA256, runtime }
  const file = receiptPath(runtimeDir)
  const existing = await fs.lstat(file).catch(() => null)
  if (existing) throw new AgentPackageError('RUNTIME_TARGET_CONFLICT', 'Python runtime receipt already exists', 409)
  const temp = path.join(path.dirname(file), `.${PYTHON_RUNTIME_RECEIPT_FILE}.${crypto.randomUUID()}.tmp`)
  try {
    await fs.writeFile(temp, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 })
    // Exclusive create is the commit point: unlike check-then-rename, it
    // cannot replace a receipt another installer won between the lstat and
    // commit. Hard-link ownership is preferred, with COPYFILE_EXCL fallback
    // for FAT32/exFAT/mapped drives that do not support hard-links.
    await createExclusiveFile(temp, file)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined)
  }
}

/** Replace a receipt only after the caller has matched the live tree to an
 * authoritative verified distribution baseline.  This is recovery for a
 * crash/interruption after target+archive commit, not a general overwrite API.
 */
export async function repairPythonRuntimeReceipt(runtimeDir: string, runtime: PythonRuntimeMetadata): Promise<void> {
  if (runtime.archiveSha !== PORTABLE_PYTHON_ARCHIVE_SHA256) throw invalidReceipt('Cannot write a receipt for an unverified Python archive')
  const receipt = { schemaVersion: 1 as const, sourceUrl: PORTABLE_PYTHON_ARCHIVE_URL, archiveSha: PORTABLE_PYTHON_ARCHIVE_SHA256, runtime }
  const file = receiptPath(runtimeDir)
  const existing = await fs.lstat(file).catch((error: unknown) => {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return null
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw invalidReceipt('Python runtime receipt contains a symlink or special file')
  const temp = path.join(path.dirname(file), `.${PYTHON_RUNTIME_RECEIPT_FILE}.${crypto.randomUUID()}.repair.tmp`)
  try {
    await fs.writeFile(temp, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 })
    // rename replaces only the receipt file itself.  The runtime tree and the
    // authoritative archive were matched before this helper is called.
    await fs.rename(temp, file)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined)
  }
}

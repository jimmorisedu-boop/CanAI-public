import crypto from 'node:crypto'
import fsNative from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { extractPackageArchive } from './package-archive.js'
import { AgentPackageError } from './package-errors.js'
import {
  MAX_RUNTIME_ARCHIVE_BYTES,
  MAX_RUNTIME_FILE_BYTES,
  MAX_RUNTIME_FILES,
  MAX_RUNTIME_TOTAL_BYTES,
  PORTABLE_PYTHON_ARCHIVE_SHA256,
  PORTABLE_PYTHON_VERSION,
  PYTHON_RUNTIME_ARCHIVE_FILE,
  assertNoSymlinkAncestors,
  hashPythonRuntimeTree,
  metadataFromTree,
  repairPythonRuntimeReceipt,
  readPythonRuntimeReceipt,
  relativeSafe,
  requiredPythonRuntimeFiles,
  runtimeRoot,
  samePythonRuntimeMetadata,
  sha256,
  type PythonRuntimeMetadata,
  type PythonRuntimeReceipt,
} from './python-runtime-files.js'

export type PythonRuntimeBaseline = Pick<PythonRuntimeMetadata, 'version' | 'integrity' | 'environmentId' | 'stdlibIntegrity' | 'treeSha' | 'executableRelative' | 'archiveSha'>

export function baselineComplete(expected: PythonRuntimeBaseline): boolean {
  return expected.archiveSha === PORTABLE_PYTHON_ARCHIVE_SHA256
    && expected.version === PORTABLE_PYTHON_VERSION
    && expected.executableRelative === 'python.exe'
    && expected.integrity === expected.treeSha
    && /^[a-f0-9]{64}$/u.test(expected.integrity)
    && /^[a-f0-9]{64}$/u.test(expected.stdlibIntegrity)
    && /^[a-f0-9]{32}$/u.test(expected.environmentId)
}

export async function authoritativeRuntimeArchive(runtimeDir: string): Promise<Buffer | undefined> {
  await assertNoSymlinkAncestors(path.resolve(runtimeDir))
  const file = path.join(path.resolve(runtimeDir), PYTHON_RUNTIME_ARCHIVE_FILE)
  const stat = await fsp.lstat(file).catch((error: unknown) => {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return null
    throw error
  })
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RUNTIME_ARCHIVE_BYTES) throw new AgentPackageError('RUNTIME_BASELINE_INVALID', 'Verified Python distribution archive contains a symlink or exceeds the limit', 409)
  const bytes = await fsp.readFile(file)
  if (bytes.length !== stat.size || sha256(bytes) !== PORTABLE_PYTHON_ARCHIVE_SHA256) throw new AgentPackageError('RUNTIME_BASELINE_INVALID', 'Verified Python distribution archive SHA-256 does not match', 409)
  return bytes
}

export async function authoritativeRuntimeBaseline(runtimeDir: string): Promise<PythonRuntimeMetadata | undefined> {
  const archive = await authoritativeRuntimeArchive(runtimeDir)
  if (!archive) return undefined
  const parent = path.resolve(runtimeDir)
  const staging = path.join(parent, `.python-${PORTABLE_PYTHON_VERSION}.receipt-verify-${crypto.randomUUID()}`)
  try {
    await extractPackageArchive(archive, staging, undefined, { requireSingleTopLevel: false, maxArchiveBytes: MAX_RUNTIME_ARCHIVE_BYTES, maxFileBytes: MAX_RUNTIME_FILE_BYTES, maxTotalBytes: MAX_RUNTIME_TOTAL_BYTES, maxEntries: MAX_RUNTIME_FILES })
    const tree = await hashPythonRuntimeTree(staging)
    const files = requiredPythonRuntimeFiles(tree.files)
    return metadataFromTree(tree, files, PORTABLE_PYTHON_VERSION, PORTABLE_PYTHON_ARCHIVE_SHA256)
  } finally {
    if (relativeSafe(parent, staging)) await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Recover only the receipt part of an interrupted install. The authoritative
 * baseline must have been derived from the fixed-SHA official ZIP; this helper
 * hashes the current target and repairs a missing/invalid receipt only when
 * every byte-level metadata field matches that baseline. It never probes or
 * executes the runtime.
 */
export async function recoverPythonRuntimeReceipt(runtimeDir: string, authoritative: PythonRuntimeBaseline): Promise<PythonRuntimeMetadata | undefined> {
  if (!baselineComplete(authoritative)) throw new AgentPackageError('RUNTIME_BASELINE_INVALID', 'Python runtime recovery requires a verified baseline', 409)
  await assertNoSymlinkAncestors(path.resolve(runtimeDir))
  const root = runtimeRoot(runtimeDir)
  const rootStat = await fsp.lstat(root).catch((error: unknown) => {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return null
    throw error
  })
  if (!rootStat) return undefined
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AgentPackageError('RUNTIME_INTEGRITY_INVALID', 'Python runtime root is invalid', 409)
  const tree = await hashPythonRuntimeTree(root)
  const files = requiredPythonRuntimeFiles(tree.files)
  const actual = metadataFromTree(tree, files, authoritative.version, authoritative.archiveSha!)
  if (!samePythonRuntimeMetadata(actual, authoritative as PythonRuntimeMetadata)) return undefined

  let receipt: PythonRuntimeReceipt | undefined
  try {
    receipt = await readPythonRuntimeReceipt(runtimeDir)
  } catch (error) {
    if (!(error instanceof AgentPackageError) || error.code !== 'RUNTIME_BASELINE_INVALID') throw error
  }
  // A valid receipt that disagrees with the verified distribution is evidence
  // of a conflicting install, not a crash-window repair candidate.
  if (receipt) return undefined
  await repairPythonRuntimeReceipt(runtimeDir, actual)
  return actual
}

export type RuntimeArchiveCommit = { file: string; owner: string; hardLinkOwned: boolean }

export interface RuntimeArchiveCommitOptions {
  /** Test seam for deterministic unsupported-filesystem coverage. */
  linkImpl?: (existingPath: string, newPath: string) => Promise<void>
}

function hardLinkUnsupported(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV' || code === 'EPERM' || code === 'EINVAL' || code === 'ENOSYS'
}

export async function writeAuthoritativeRuntimeArchive(runtimeDir: string, bytes: Buffer, options: RuntimeArchiveCommitOptions = {}): Promise<RuntimeArchiveCommit> {
  const file = path.join(path.resolve(runtimeDir), PYTHON_RUNTIME_ARCHIVE_FILE)
  const temp = path.join(path.dirname(file), `.${PYTHON_RUNTIME_ARCHIVE_FILE}.${crypto.randomUUID()}.tmp`)
  let committed = false
  let hardLinkOwned = false
  try {
    await fsp.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
    // A hard-link create is the no-clobber commit point. A check followed by
    // rename could replace an archive won by a concurrent installer.
    try { await (options.linkImpl ?? fsp.link)(temp, file); hardLinkOwned = true }
    catch (error) {
      if (!hardLinkUnsupported(error)) throw error
      // Some portable media do not implement hard-links. COPYFILE_EXCL still
      // gives us an exclusive destination and never replaces a winner. If a
      // later transaction step fails, preserve this archive because this
      // fallback cannot prove which process owns the destination inode.
      await fsp.copyFile(temp, file, fsNative.constants.COPYFILE_EXCL)
    }
    committed = true
    return { file, owner: temp, hardLinkOwned }
  } finally {
    if (!committed) await fsp.rm(temp, { force: true }).catch(() => undefined)
  }
}

function sameFileIdentity(left: fsNative.Stats, right: fsNative.Stats): boolean {
  return left.ino !== 0 && right.ino !== 0 && left.dev === right.dev && left.ino === right.ino
}

export async function removeOwnedRuntimeArchive(commit: RuntimeArchiveCommit): Promise<void> {
  const [owner, file] = await Promise.all([
    fsp.lstat(commit.owner).catch(() => null),
    fsp.lstat(commit.file).catch(() => null),
  ])
  if (commit.hardLinkOwned && owner && file && sameFileIdentity(owner, file)) await fsp.rm(commit.file, { force: true }).catch(() => undefined)
  await fsp.rm(commit.owner, { force: true }).catch(() => undefined)
}

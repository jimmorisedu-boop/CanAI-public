import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { extractPackageArchive } from './package-archive.js'
import { AgentPackageError } from './package-errors.js'
import { downloadPythonRuntimeArchive } from './python-runtime-download.js'
import {
  MAX_RUNTIME_ARCHIVE_BYTES,
  MAX_RUNTIME_FILE_BYTES,
  MAX_RUNTIME_FILES,
  MAX_RUNTIME_TOTAL_BYTES,
  PORTABLE_PYTHON_ARCHIVE_SHA256,
  PORTABLE_PYTHON_ARCHIVE_URL,
  PORTABLE_PYTHON_VERSION,
  PYTHON_RUNTIME_ARCHIVE_FILE,
  PythonRuntimeMetadata,
  PythonRuntimeTree,
  PYTHON_RUNTIME_RECEIPT_FILE,
  RequiredPythonRuntimeFiles,
  assertNoSymlinkAncestors,
  hashPythonRuntimeTree,
  metadataFromTree,
  readPythonRuntimeReceipt,
  relativeSafe,
  requiredPythonRuntimeFiles,
  runtimeRoot,
  samePythonRuntimeMetadata,
  sha256,
  writePythonRuntimeReceipt,
} from './python-runtime-files.js'
import {
  authoritativeRuntimeBaseline,
  baselineComplete,
  recoverPythonRuntimeReceipt,
  removeOwnedRuntimeArchive,
  writeAuthoritativeRuntimeArchive,
  type RuntimeArchiveCommit,
} from './python-runtime-baseline.js'
import type { PythonRuntimeBaseline } from './python-runtime-baseline.js'
import { installKey } from './python-runtime-lock.js'

export {
  MAX_RUNTIME_ARCHIVE_BYTES,
  MAX_RUNTIME_FILE_BYTES,
  MAX_RUNTIME_FILES,
  MAX_RUNTIME_TOTAL_BYTES,
  PORTABLE_PYTHON_ARCHIVE_SHA256,
  PORTABLE_PYTHON_ARCHIVE_URL,
  PORTABLE_PYTHON_VERSION,
  PYTHON_RUNTIME_ARCHIVE_FILE,
  PYTHON_RUNTIME_RECEIPT_FILE,
  hashPythonRuntimeTree,
  requiredPythonRuntimeFiles,
  runtimeRoot,
  sha256,
}
export type { PythonRuntimeBaseline }
export type { PythonRuntimeMetadata, PythonRuntimeReceipt, PythonRuntimeTree, RequiredPythonRuntimeFiles } from './python-runtime-files.js'
export { pythonLaunch } from './python-runtime-launch.js'
export { downloadPythonRuntimeArchive } from './python-runtime-download.js'
export type { PythonArchiveDownloadOptions } from './python-runtime-download.js'

export interface PythonRuntimeStatus {
  supported: boolean
  ready: boolean
  version: string
  rootRelative: string
  reason?: string
  runtime?: PythonRuntimeMetadata
}

export interface PythonRuntimeInstallerOptions {
  runtimeDir: string
  fetchImpl?: typeof fetch
  platform?: NodeJS.Platform
  arch?: string
  timeoutMs?: number
  archiveUrl?: string
  /** Test transport injection. Production callers must use the pinned default. */
  archiveSha256?: string
  versionProbe?: PythonRuntimeVersionProbe
}

export interface PythonRuntimeVersionProbeRequest {
  executable: string
  cwd: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

export type PythonRuntimeVersionProbe = (request: PythonRuntimeVersionProbeRequest) => Promise<string>

export interface PythonRuntimeResolveOptions {
  platform?: NodeJS.Platform
  arch?: string
  versionProbe?: PythonRuntimeVersionProbe
}

const installFlights = new Map<string, Promise<PythonRuntimeMetadata>>()
const VERSION_SCRIPT = 'import sys; print("%d.%d.%d" % sys.version_info[:3])'

function supportedPlatform(platform: string, arch: string): boolean {
  return platform === 'win32' && arch === 'x64'
}

function portableEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
  env.PYTHONNOUSERSITE = '1'
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  return env
}

function defaultVersionProbe(request: PythonRuntimeVersionProbeRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: AgentPackageError, version?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(version ?? '')
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new AgentPackageError('RUNTIME_VERIFY_TIMEOUT', 'Python runtime check timed out', 504))
    }, request.timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { if (stdout.length < 512) stdout += String(chunk).slice(0, 512 - stdout.length) })
    child.stderr.on('data', (chunk) => { if (stderr.length < 512) stderr += String(chunk).slice(0, 512 - stderr.length) })
    child.once('error', () => finish(new AgentPackageError('RUNTIME_VERIFY_FAILED', 'Python runtime did not start', 409)))
    child.once('close', (code) => {
      const version = stdout.trim().split(/\r?\n/u)[0] ?? ''
      if (code !== 0 || !/^\d+\.\d+\.\d+$/u.test(version)) {
        finish(new AgentPackageError('RUNTIME_VERIFY_FAILED', `Python runtime failed validation${stderr ? `: ${stderr.trim()}` : ''}`, 409))
        return
      }
      finish(undefined, version)
    })
  })
}

function expectedMetadata(expected: PythonRuntimeBaseline, tree: PythonRuntimeTree, files: RequiredPythonRuntimeFiles): PythonRuntimeMetadata {
  if (!baselineComplete(expected)) throw new AgentPackageError('RUNTIME_BASELINE_INVALID', 'Python runtime baseline is missing or not verified by the official archive', 409)
  const actual = metadataFromTree(tree, files, expected.version, expected.archiveSha!)
  if (!samePythonRuntimeMetadata(actual, expected as PythonRuntimeMetadata)) throw new AgentPackageError('RUNTIME_PIN_MISMATCH', 'Python runtime changed since the install receipt', 409)
  return actual
}

function resolveOptions(value?: PythonRuntimeResolveOptions | PythonRuntimeVersionProbe): PythonRuntimeResolveOptions {
  if (!value) return {}
  return typeof value === 'function' ? { versionProbe: value } : value
}

/**
 * Resolve only a runtime backed by an install receipt. Static integrity is
 * checked before the version probe, so a changed exe/DLL/_pth/stdlib never runs.
 */
export async function resolvePythonRuntime(root: string, expected?: PythonRuntimeBaseline, optionsOrProbe?: PythonRuntimeResolveOptions | PythonRuntimeVersionProbe): Promise<PythonRuntimeMetadata> {
  const options = resolveOptions(optionsOrProbe)
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (!supportedPlatform(platform, arch)) throw new AgentPackageError('RUNTIME_UNSUPPORTED_PLATFORM', 'Portable Python runtime is supported only on Windows x64', 422)
  if (!expected) throw new AgentPackageError('RUNTIME_BASELINE_REQUIRED', 'Python runtime has no verified install receipt', 409)
  const absoluteRoot = path.resolve(root)
  await assertNoSymlinkAncestors(absoluteRoot)
  const tree = await hashPythonRuntimeTree(absoluteRoot)
  const files = requiredPythonRuntimeFiles(tree.files)
  const metadata = expectedMetadata(expected, tree, files)
  const executable = path.resolve(absoluteRoot, metadata.executableRelative)
  if (!relativeSafe(absoluteRoot, executable) || !fs.existsSync(executable)) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python executable is outside the runtime root', 409)
  const probe = options.versionProbe ?? defaultVersionProbe
  const version = await probe({
    executable,
    cwd: absoluteRoot,
    args: ['-I', '-S', '-B', '-u', '-X', 'utf8', '-c', VERSION_SCRIPT],
    env: portableEnvironment(),
    timeoutMs: 10_000,
  })
  if (version !== metadata.version) throw new AgentPackageError('RUNTIME_VERSION_UNSUPPORTED', `Expected Python ${metadata.version}, got ${version || 'unknown runtime'}`, 422)
  return metadata
}

export async function inspectPythonRuntime(runtimeDir: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch, options: Omit<PythonRuntimeResolveOptions, 'platform' | 'arch'> = {}): Promise<PythonRuntimeStatus> {
  const root = runtimeRoot(runtimeDir)
  const rootRelative = path.relative(path.dirname(path.resolve(runtimeDir)), root)
  if (!supportedPlatform(platform, arch)) return { supported: false, ready: false, version: PORTABLE_PYTHON_VERSION, rootRelative, reason: 'Windows x64 is required' }
  try {
    await assertNoSymlinkAncestors(path.resolve(runtimeDir))
    const runtimeDirStat = await fsp.lstat(path.resolve(runtimeDir)).catch(() => null)
    if (runtimeDirStat && (!runtimeDirStat.isDirectory() || runtimeDirStat.isSymbolicLink())) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Portable runtime directory contains a symlink', 409)
    const authoritative = await authoritativeRuntimeBaseline(runtimeDir)
    if (!authoritative) return { supported: true, ready: false, version: PORTABLE_PYTHON_VERSION, rootRelative, reason: 'RUNTIME_BASELINE_REQUIRED: verified distribution archive is missing' }
    const receipt = await readPythonRuntimeReceipt(runtimeDir)
    if (!receipt) return { supported: true, ready: false, version: PORTABLE_PYTHON_VERSION, rootRelative, reason: 'RUNTIME_BASELINE_REQUIRED: install receipt is missing' }
    if (!samePythonRuntimeMetadata(receipt.runtime, authoritative)) throw new AgentPackageError('RUNTIME_PIN_MISMATCH', 'Install receipt does not match the verified distribution archive', 409)
    const runtime = await resolvePythonRuntime(root, authoritative, { ...options, platform, arch })
    return { supported: true, ready: true, version: runtime.version, rootRelative, runtime }
  } catch (error) {
    return { supported: true, ready: false, version: PORTABLE_PYTHON_VERSION, rootRelative, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function installPythonRuntimeOnce(options: PythonRuntimeInstallerOptions): Promise<PythonRuntimeMetadata> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (!supportedPlatform(platform, arch)) throw new AgentPackageError('RUNTIME_UNSUPPORTED_PLATFORM', 'Portable Python runtime is supported only on Windows x64', 422)
  const runtimeDirectory = path.resolve(options.runtimeDir)
  await assertNoSymlinkAncestors(runtimeDirectory)
  await fsp.mkdir(runtimeDirectory, { recursive: true })
  await assertNoSymlinkAncestors(runtimeDirectory)
  const runtimeDirectoryStat = await fsp.lstat(runtimeDirectory)
  if (!runtimeDirectoryStat.isDirectory() || runtimeDirectoryStat.isSymbolicLink()) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Portable runtime directory contains a symlink', 409)
  const target = runtimeRoot(runtimeDirectory)
  const existing = await inspectPythonRuntime(runtimeDirectory, platform, arch, { versionProbe: options.versionProbe })
  if (existing.ready && existing.runtime) return existing.runtime
  const existingTarget = await fsp.lstat(target).catch(() => null)
  const existingReceipt = await fsp.lstat(path.join(runtimeDirectory, PYTHON_RUNTIME_RECEIPT_FILE)).catch(() => null)
  const existingArchive = await fsp.lstat(path.join(runtimeDirectory, PYTHON_RUNTIME_ARCHIVE_FILE)).catch(() => null)
  if (existingTarget || existingReceipt || existingArchive) {
    // A process can die after the immutable target and official archive commit
    // but before receipt commit. Recover only from the verified archive and an
    // exact static match; a probe is deliberately not part of this path.
    if (existingTarget && existingArchive) {
      const authoritative = await authoritativeRuntimeBaseline(runtimeDirectory)
      if (authoritative) {
        const recovered = await recoverPythonRuntimeReceipt(runtimeDirectory, authoritative)
        if (recovered) return recovered
      }
    }
    throw new AgentPackageError('RUNTIME_TARGET_CONFLICT', 'Python runtime folder already exists but failed validation; preserved without overwriting', 409)
  }
  const archive = await downloadPythonRuntimeArchive(options)
  const parent = path.dirname(target)
  await fsp.mkdir(parent, { recursive: true })
  await assertNoSymlinkAncestors(parent)
  const parentStat = await fsp.lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Portable runtime folder contains a symlink', 409)
  const staging = path.join(parent, `.python-${PORTABLE_PYTHON_VERSION}.stage-${crypto.randomUUID()}`)
  let archiveCommit: RuntimeArchiveCommit | undefined
  let targetCommitted = false
  try {
    await extractPackageArchive(archive.bytes, staging, undefined, { requireSingleTopLevel: false, maxArchiveBytes: MAX_RUNTIME_ARCHIVE_BYTES, maxFileBytes: MAX_RUNTIME_FILE_BYTES, maxTotalBytes: MAX_RUNTIME_TOTAL_BYTES, maxEntries: MAX_RUNTIME_FILES })
    const tree = await hashPythonRuntimeTree(staging)
    const files = requiredPythonRuntimeFiles(tree.files)
    const baseline = metadataFromTree(tree, files, PORTABLE_PYTHON_VERSION, archive.archiveSha)
    if (archive.archiveSha !== PORTABLE_PYTHON_ARCHIVE_SHA256) throw new AgentPackageError('RUNTIME_ARCHIVE_TAMPERED', 'Only the pinned SHA-256 of the official Python archive is allowed', 409)
    const runtime = await resolvePythonRuntime(staging, baseline, { platform, arch, versionProbe: options.versionProbe })
    archiveCommit = await writeAuthoritativeRuntimeArchive(runtimeDirectory, archive.bytes)
    const targetStat = await fsp.lstat(target).catch(() => null)
    if (targetStat) throw new AgentPackageError('RUNTIME_TARGET_CONFLICT', 'Python runtime folder appeared during installation', 409)
    await fsp.rename(staging, target)
    targetCommitted = true
    try {
      await writePythonRuntimeReceipt(runtimeDirectory, runtime)
    } catch (error) {
      // Do not remove a successfully installed immutable tree. A missing or
      // invalid receipt makes it untrusted on the next startup and preserves
      // the tree for forensic rollback instead of silently replacing it.
      throw error
    }
    return runtime
  } finally {
    if (!targetCommitted && archiveCommit) await removeOwnedRuntimeArchive(archiveCommit)
    else if (archiveCommit) await fsp.rm(archiveCommit.owner, { force: true }).catch(() => undefined)
    if (relativeSafe(parent, staging)) await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function installPythonRuntime(options: PythonRuntimeInstallerOptions): Promise<PythonRuntimeMetadata> {
  const key = await installKey(options.runtimeDir)
  const prior = installFlights.get(key)
  if (prior) return prior
  const flight = installPythonRuntimeOnce(options)
  installFlights.set(key, flight)
  try { return await flight }
  finally { if (installFlights.get(key) === flight) installFlights.delete(key) }
}

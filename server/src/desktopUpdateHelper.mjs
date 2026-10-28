#!/usr/bin/env node
/*
 * Detached updater process.  It is intentionally plain Node and imports no
 * application modules: the old server is already shutting down when this
 * file starts, and the helper must remain runnable while the TypeScript app is
 * being replaced.  The JSON job is the only input accepted from the server.
 */
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT = 60_000
const POLL_MS = 250
const HELPER_OWNER_FILE = 'desktop-update-helper.json'

function commitsEqual(left, right) {
  if (!left || !right) return false
  const a = String(left).toLowerCase()
  const b = String(right).toLowerCase()
  return a === b || (a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a)))
}

export class DesktopUpdateHelperError extends Error {
  constructor(message, code = 'update-helper-error') {
    super(message)
    this.name = 'DesktopUpdateHelperError'
    this.code = code
  }
}

function normalized(value) {
  return String(value ?? '').replaceAll('\\', '/')
}

function safeRelative(value) {
  const name = normalized(value)
  if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/u.test(name)) return false
  return name.split('/').every((part) => part && part !== '.' && part !== '..')
}

function protectedRelative(name, protectedPaths) {
  const value = normalized(name)
  const isProtectedEnvPart = (part) => part === '.env' || (part.startsWith('.env.') && part !== '.env.example')
  if (isProtectedEnvPart(value) || value.split('/').some(isProtectedEnvPart)) return true
  return protectedPaths.some((entry) => value === entry || value.startsWith(`${entry}/`))
}

async function listFiles(root, protectedPaths, relative = '', output = []) {
  const directory = path.join(root, relative)
  let entries
  try { entries = await fsp.readdir(directory, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return output
    throw error
  }
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    if (protectedRelative(rel, protectedPaths)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new DesktopUpdateHelperError(`Symlinks are not allowed: ${rel}`, 'invalid-tree')
    if (entry.isDirectory()) await listFiles(root, protectedPaths, rel, output)
    else if (entry.isFile()) output.push(rel)
  }
  return output
}

async function assertDestinationParents(root, target) {
  const base = path.resolve(root)
  const parent = path.dirname(path.resolve(target))
  if (!parent.startsWith(`${base}${path.sep}`) && parent !== base) throw new DesktopUpdateHelperError('Unsafe destination path', 'invalid-tree')
  const relative = path.relative(base, parent)
  let cursor = base
  for (const segment of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, segment)
    try {
      const stat = await fsp.lstat(cursor)
      if (stat.isSymbolicLink()) throw new DesktopUpdateHelperError(`Symlinked destination parent: ${segment}`, 'invalid-tree')
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
  }
}

/** Copy files from an extracted payload, without deleting user files. */
export async function copyManagedTree(sourceRoot, destinationRoot, managedPaths, protectedPaths) {
  let copied = 0
  for (const managedPath of managedPaths) {
    if (protectedRelative(managedPath, protectedPaths)) continue
    const source = path.join(sourceRoot, managedPath)
    let stat
    try { stat = await fsp.lstat(source) } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink()) throw new DesktopUpdateHelperError(`Symlinks are not allowed: ${managedPath}`, 'invalid-tree')
    const files = stat.isDirectory() ? await listFiles(sourceRoot, protectedPaths, managedPath) : [managedPath]
    for (const relative of files) {
      if (!safeRelative(relative) || protectedRelative(relative, protectedPaths)) continue
      const input = path.resolve(sourceRoot, relative)
      const output = path.resolve(destinationRoot, relative)
      const root = path.resolve(destinationRoot)
      if (!output.startsWith(`${root}${path.sep}`)) throw new DesktopUpdateHelperError(`Unsafe destination path: ${relative}`, 'invalid-tree')
      const inputStat = await fsp.lstat(input)
      if (inputStat.isSymbolicLink() || !inputStat.isFile()) throw new DesktopUpdateHelperError(`Invalid update entry: ${relative}`, 'invalid-tree')
      await assertDestinationParents(root, output)
      await fsp.mkdir(path.dirname(output), { recursive: true })
      await fsp.copyFile(input, output)
      try { await fsp.chmod(output, inputStat.mode & 0o777) } catch { /* read-only destination is handled by copyFile */ }
      copied++
    }
  }
  return copied
}

async function removeFiles(root, files) {
  for (const relative of files) {
    const target = path.resolve(root, relative)
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) continue
    try { await fsp.rm(target, { force: true }) } catch { /* rollback is best effort */ }
  }
}

async function command(file, args, cwd, options = {}) {
  const executable = file === 'git' && process.env.CANAI_GIT_EXECUTABLE ? process.env.CANAI_GIT_EXECUTABLE : file
  const result = await execFileAsync(executable, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options })
  return String(result.stdout ?? '').trim()
}

async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

export async function waitForProcessExit(pid, timeoutMs = DEFAULT_TIMEOUT, sleep = delay) {
  const until = Date.now() + timeoutMs
  while (await pidAlive(pid)) {
    if (Date.now() >= until) throw new DesktopUpdateHelperError('Previous CanAI process did not stop', 'shutdown-timeout')
    await sleep(POLL_MS)
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function cleanupStage(job) {
  const parent = path.dirname(job.stageRoot)
  if (path.resolve(parent) !== path.resolve(job.rootDir) && path.basename(parent).startsWith('desktop-update-')) await fsp.rm(parent, { recursive: true, force: true })
  else await fsp.rm(job.stageRoot, { recursive: true, force: true })
}

async function copyBackup(sourceRoot, backupRoot, managedPaths, protectedPaths) {
  await fsp.mkdir(backupRoot, { recursive: true })
  return copyManagedTree(sourceRoot, backupRoot, managedPaths, protectedPaths)
}

async function verifyGitCheckout(job, deps = {}) {
  if (job.edition !== 'full' || !job.expectedCurrent) return
  const run = deps.command ?? command
  const branch = await run('git', ['branch', '--show-current'], job.rootDir)
  if (branch !== 'main') throw new DesktopUpdateHelperError('Checkout is no longer on main', 'checkout-changed')
  const head = await run('git', ['rev-parse', 'HEAD'], job.rootDir)
  if (head !== job.expectedCurrent && !head.startsWith(job.expectedCurrent)) throw new DesktopUpdateHelperError('Checkout changed while the update was prepared', 'checkout-changed')
  const dirty = await run('git', ['status', '--porcelain', '--untracked-files=all'], job.rootDir)
  if (dirty) throw new DesktopUpdateHelperError('Checkout changed while the update was prepared', 'checkout-changed')
  await run('git', ['merge-base', '--is-ancestor', 'HEAD', job.target], job.rootDir)
  // A full-edition fast-forward changes every tracked path in the commit.  The
  // updater must never allow a release commit to replace user-owned files,
  // even when an old repository accidentally tracked one of these paths.
  const changed = await run('git', ['diff', '--name-only', 'HEAD', job.target], job.rootDir)
  const protectedChange = changed.split(/\r?\n/u).find((entry) => entry && protectedRelative(entry, job.protectedPaths ?? []))
  if (protectedChange) throw new DesktopUpdateHelperError(`Release changes protected path: ${protectedChange}`, 'protected-path')
}

async function applyGitFastForward(job, verify = true, deps = {}) {
  if (job.edition !== 'full' || !job.expectedCurrent) return false
  const run = deps.command ?? command
  if (verify) await verifyGitCheckout(job, deps)
  await run('git', ['merge', '--ff-only', job.target], job.rootDir)
  return true
}

async function rollbackGitFastForward(job, deps = {}) {
  if (job.edition !== 'full' || !job.expectedCurrent) return
  const run = deps.command ?? command
  // Only files introduced by the release are candidates for removal after
  // reset.  Modified tracked files already exist in the old commit and must
  // remain with their restored contents.
  const added = await run('git', ['diff', '--name-only', '--diff-filter=A', job.expectedCurrent, 'HEAD'], job.rootDir).catch(() => '')
  await run('git', ['reset', '--hard', job.expectedCurrent], job.rootDir)
  const removable = added.split(/\r?\n/u).filter((entry) => entry && safeRelative(entry) && !protectedRelative(entry, job.protectedPaths))
  await removeFiles(job.rootDir, removable)
}

async function writeBuildInfo(job) {
  if (!job.latest?.commit) return
  const target = path.join(job.rootDir, 'build-info.json')
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  const payload = `${JSON.stringify({ commit: job.latest.commit, date: job.latest.date ?? null })}\n`
  await fsp.writeFile(temporary, payload, { mode: 0o644 })
  await fsp.rename(temporary, target)
}

function requestJson(url, options = {}) {
  const parsed = new URL(url)
  const transport = parsed.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = transport.request(parsed, { method: options.method ?? 'GET', headers: options.headers ?? {}, timeout: 2_000 }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        let parsedBody = null
        try { parsedBody = body ? JSON.parse(body) : null } catch { /* status endpoint can still be judged by HTTP */ }
        resolve({ statusCode: res.statusCode ?? 0, body: parsedBody })
      })
    })
    req.on('timeout', () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    req.end(options.body)
  })
}

async function readRuntimeControl(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return null }
}

async function stopRuntime(job, deps) {
  const control = await readRuntimeControl(path.join(job.dataDir, 'runtime-control.json'))
  const port = Number(control?.port ?? job.port)
  const token = typeof control?.shutdownToken === 'string' ? control.shutdownToken : null
  if (token) {
    try { await deps.requestJson(`http://127.0.0.1:${port}/api/lifecycle/shutdown`, { method: 'POST', headers: { 'x-canai-shutdown-token': token } }) } catch { /* process may already be gone */ }
  }
  // Never kill an arbitrary process just because a stale control file contains
  // its PID.  The lifecycle token is the identity check; absence of a token
  // means the helper leaves the process untouched for manual recovery.
  if (token && control?.pid) {
    const until = Date.now() + DEFAULT_TIMEOUT
    while (await deps.pidAlive(control.pid) && Date.now() < until) await deps.sleep(POLL_MS)
    if (await deps.pidAlive(control.pid)) throw new DesktopUpdateHelperError('Previous CanAI process did not stop', 'shutdown-timeout')
  }
}

function launcherFor(job) {
  if (job.platform === 'win32') return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(job.rootDir, job.launcher.windows), '--unattended', '--no-browser'] }
  return { file: 'zsh', args: [path.join(job.rootDir, job.launcher.macos), '--unattended', '--no-browser'] }
}

async function launchRuntime(job, deps) {
  if (deps.launch) return deps.launch(job)
  const launcher = launcherFor(job)
  const child = deps.spawn(launcher.file, launcher.args, {
    cwd: job.rootDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CANAI_NO_BROWSER: '1', CANAI_UNATTENDED: '1', PORT: String(job.port), CANAI_DATA_DIR: job.dataDir },
  })
  child.unref?.()
  return child
}

async function waitHealthy(job, deps, expectedCommit, timeoutMs = DEFAULT_TIMEOUT, oldControl = null) {
  if (deps.health) return { body: await deps.health(job, expectedCommit), port: job.port }
  const until = Date.now() + timeoutMs
  let probePort = job.port
  while (Date.now() < until) {
    try {
      const control = await readRuntimeControl(path.join(job.dataDir, 'runtime-control.json'))
      const controlPort = Number(control?.port)
      const controlChanged = Boolean(control && Number.isInteger(controlPort) && controlPort > 0 &&
        (!oldControl || control.instanceId !== oldControl.instanceId || control.pid !== oldControl.pid))
      if (controlChanged) probePort = controlPort
      const result = await deps.requestJson(`http://127.0.0.1:${probePort}/api/status`)
      const build = result.body?.build
      // If a control document is present, it must belong to the restarted
      // process.  This prevents accepting an unrelated listener (or the old
      // server) that happens to report the same build.
      const identityReady = !control || (controlChanged && Number.isInteger(control.pid) && control.pid !== job.oldPid && typeof control.instanceId === 'string' && control.instanceId.length > 0)
      if (result.statusCode >= 200 && result.statusCode < 300 && build &&
        identityReady &&
        ((expectedCommit && typeof build.commit === 'string' && commitsEqual(build.commit, expectedCommit)) ||
          (!expectedCommit && typeof build.version === 'string' && build.version === job.latest.version))) return { body: result.body, port: probePort }
    } catch { /* server is still starting */ }
    await deps.sleep(POLL_MS)
  }
  throw new DesktopUpdateHelperError('Updated CanAI did not become ready', 'readiness-timeout')
}

async function openFallbackBrowser(job, port, deps) {
  if (port === job.port) return
  if (deps.openBrowser) return deps.openBrowser(`http://127.0.0.1:${port}`, job)
  const url = `http://127.0.0.1:${port}`
  const file = job.platform === 'win32' ? 'cmd.exe' : 'open'
  const args = job.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { await execFileAsync(file, args, { windowsHide: true }) } catch { /* browser opening must not roll back a healthy update */ }
}

async function writeState(statePath, record) {
  const temporary = `${statePath}.tmp-${process.pid}-${Date.now()}`
  await fsp.mkdir(path.dirname(statePath), { recursive: true })
  await fsp.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  await fsp.rename(temporary, statePath)
}

/** Apply a prepared job. Dependencies make rollback/readiness deterministic in fixtures. */
export async function applyUpdate(job, overrides = {}) {
  const deps = {
    sleep: delay,
    pidAlive,
    requestJson,
    spawn,
    ...overrides,
  }
  const protectedPaths = Array.isArray(job.protectedPaths) ? job.protectedPaths : []
  const managedPaths = Array.isArray(job.managedPaths) ? job.managedPaths : []
  const beforeFiles = await listFiles(job.rootDir, protectedPaths)
  const backupBase = path.join(job.rootDir, 'artifacts', '.tmp')
  await fsp.mkdir(backupBase, { recursive: true })
  const backupParent = await fsp.mkdtemp(path.join(backupBase, 'desktop-backup-'))
  const backupRoot = path.join(backupParent, 'root')
  let usedGitFastForward = false
  let mutationStarted = false
  let restored = false
  let oldControl = null
  try {
    oldControl = await readRuntimeControl(path.join(job.dataDir, 'runtime-control.json'))
    if (deps.waitForExit) await deps.waitForExit(job.oldPid)
    else await waitForProcessExit(job.oldPid, DEFAULT_TIMEOUT, deps.sleep)
    await verifyGitCheckout(job, deps)
    await copyBackup(job.rootDir, backupRoot, managedPaths, protectedPaths)
    mutationStarted = true
    usedGitFastForward = await applyGitFastForward(job, false, deps)
    if (!usedGitFastForward) await copyManagedTree(job.stageRoot, job.rootDir, managedPaths, protectedPaths)
    // readBuildInfo deliberately prefers this ignored file over Git.  Update
    // it before launching so readiness observes the new commit, and let the
    // existing backup/rollback path restore the previous value on failure.
    await writeBuildInfo(job)
    await launchRuntime(job, deps)
    const healthy = await waitHealthy(job, deps, job.latest?.commit ?? job.target, DEFAULT_TIMEOUT, oldControl)
    await openFallbackBrowser(job, healthy.port, deps)
    const restartUrl = healthy.port === job.port ? undefined : `http://127.0.0.1:${healthy.port}`
    await writeState(job.statePath, { status: { phase: 'complete', edition: job.edition, current: { version: job.latest.version, commit: job.latest.commit, date: job.latest.date ?? null }, latest: job.latest, jobId: job.jobId, port: healthy.port, ...(restartUrl ? { restartUrl } : {}), message: 'CanAI updated successfully' }, job })
    await fsp.rm(backupParent, { recursive: true, force: true })
    await cleanupStage(job).catch(() => {})
    return { rolledBack: false }
  } catch (error) {
    try { await stopRuntime(job, deps) } catch { /* continue to restore */ }
    if (mutationStarted) {
      try {
        if (usedGitFastForward) {
          await rollbackGitFastForward(job, deps)
          await copyManagedTree(backupRoot, job.rootDir, managedPaths, protectedPaths)
        } else await copyManagedTree(backupRoot, job.rootDir, managedPaths, protectedPaths)
        const afterFiles = await listFiles(job.rootDir, protectedPaths)
        const before = new Set(beforeFiles)
        await removeFiles(job.rootDir, afterFiles.filter((relative) => !before.has(relative) && managedPaths.some((entry) => relative === entry || relative.startsWith(`${entry}/`))))
        await launchRuntime(job, deps)
        await waitHealthy(job, deps, job.expectedCurrent ?? null, DEFAULT_TIMEOUT, oldControl)
        restored = true
      } catch { /* retain the backup for manual recovery */ }
    } else {
      // Validation failed before any managed path was changed.  There is no
      // rollback to perform, and an empty backup is not useful recovery data.
      restored = true
    }
    const message = error instanceof Error ? error.message : 'Desktop update failed'
    const recoveryMessage = !mutationStarted ? message : restored ? `${message}; previous version restored` : `${message}; automatic rollback failed, backup retained at ${backupParent}`
    await writeState(job.statePath, { status: { phase: 'error', edition: job.edition, current: { version: job.currentVersion, commit: job.expectedCurrent, date: job.currentDate }, latest: job.latest, jobId: job.jobId, code: restored ? (error?.code ?? 'update-error') : 'rollback-failed', message: recoveryMessage }, job })
    if (restored) {
      await fsp.rm(backupParent, { recursive: true, force: true })
      await cleanupStage(job).catch(() => {})
    }
    throw error
  }
}

export async function run(jobFile) {
  const job = JSON.parse(await fsp.readFile(jobFile, 'utf8'))
  if (!job || !job.rootDir || !job.stageRoot || !job.statePath) throw new DesktopUpdateHelperError('Invalid update job', 'invalid-job')
  const ownerPath = path.join(job.dataDir, HELPER_OWNER_FILE)
  const owner = { jobId: job.jobId, helperToken: job.helperToken ?? null, pid: process.pid, startedAt: new Date().toISOString() }
  await fsp.mkdir(path.dirname(ownerPath), { recursive: true })
  await fsp.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 })
  try { return await applyUpdate(job) } finally {
    try {
      const current = JSON.parse(await fsp.readFile(ownerPath, 'utf8'))
      if (current?.pid === process.pid && current?.jobId === owner.jobId && current?.helperToken === owner.helperToken) await fsp.rm(ownerPath, { force: true })
    } catch { /* killed helper leaves the owner journal for recovery */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv[2]).catch(async (error) => {
    console.error(`[CanAI updater] ${error?.message ?? error}`)
    process.exitCode = 1
  })
}

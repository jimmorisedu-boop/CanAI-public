#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_LAUNCHER_FLAGS = Object.freeze(['--unattended', '--no-browser', '--fresh-install'])
const INSTALLED_PACKAGE_PARTS = Object.freeze(['server'])
// Do not ask the OS for an ephemeral port here. On Windows that can return a
// port from the outbound dynamic range; a follow-up `main + 2` bind has failed
// with EACCES in the release-package smoke. The exact OS reservation cause is unknown.
// The user-port range
// below is below the common Windows, macOS, and Linux dynamic ranges. We still
// probe every candidate because another process may legitimately own one, and
// draw each candidate at random: Windows can exclude a whole 100-port block.
export const SMOKE_PORT_RANGE = Object.freeze({ start: 20_000, end: 30_000 })
const SMOKE_PORT_ATTEMPTS = 100
const EXPECTED_BIND_ERROR_CODES = new Set(['EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EPERM'])
const HTML_RE = /<!doctype\s+html|<html(?:\s|>)/iu
const SECRET_ENV_RE = /(?:key|token|secret|password|credential|cookie)/iu
// The launcher treats "build-info.json present, .git absent" as a shipped
// build that must never be rebuilt. The commit rule mirrors the server's own
// reader (server/src/buildInfo.ts): a file it rejects means "build unknown".
const PACKAGE_BUILD_FILE = 'build-info.json'
const BUILD_COMMIT_RE = /^[0-9a-f]{7,40}$/u
// Dependencies only an interface build needs. A release-package start must never
// install them: their appearance means the shipped UI was treated as stale.
const BUILD_ONLY_MODULES = Object.freeze(['node_modules', 'client/node_modules'])
const BUILT_PAGES = Object.freeze(['client/dist/index.html', 'client/dist/tablet/tablet.html'])
// Schemas the server reads from docs/agents at runtime. The unit test keeps
// this list equal to the names in server/src/agents/validation.ts.
const AGENT_SCHEMA_READER = 'server/src/agents/validation.ts'
export const RUNTIME_AGENT_SCHEMAS = Object.freeze(['protocol.schema.json', 'canai.agent.schema.json'])
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' })

export { DEFAULT_LAUNCHER_FLAGS }

// A condition that waiting cannot fix (demo mode, a configured key, a tablet
// listener that failed to bind). waitFor() rethrows it at once instead of
// polling until the cycle timeout.
export class SmokeFatalError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'SmokeFatalError'
  }
}

function usage() {
  return [
    'Usage: node scripts/smoke-distribution.mjs <unpacked-release-dir> [options]',
    '',
    'Options:',
    '  --installed             use release-package server/node_modules already installed by CI',
    '  --platform windows|macos launcher shell to exercise (default: host)',
    '  --launcher <path>       launcher inside the release package',
    `  --timeout-ms <n>        timeout per start/readiness cycle (default: ${DEFAULT_TIMEOUT_MS})`,
    '  --port <n>              requested main port (default: a random probed port in 20000–30000)',
    '  --remote-port <n>       requested tablet port (default: main port + 2)',
    '  --help                  show this help',
  ].join('\n')
}

function platformName(value) {
  if (value === 'windows' || value === 'macos') return value
  if (value === 'win32') return 'windows'
  if (value === 'darwin') return 'macos'
  return null
}

function parseInteger(value, name, { min = 1, max = 65535 } = {}) {
  if (!/^[0-9]+$/u.test(String(value))) throw new Error(`${name} must be an integer`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return number
}

export function parseArgs(argv, hostPlatform = process.platform) {
  let packageArg = null
  let installed = false
  let platform = platformName(hostPlatform)
  let launcher = null
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let port
  let remotePort

  const valueAfter = (index, option) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
    return value
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--installed') {
      installed = true
      continue
    }
    if (arg === '--platform') {
      const value = valueAfter(index, arg)
      index += 1
      platform = platformName(value)
      if (!platform) throw new Error('--platform must be windows or macos')
      continue
    }
    if (arg === '--launcher') {
      const value = valueAfter(index, arg)
      index += 1
      launcher = path.resolve(value)
      continue
    }
    if (arg === '--timeout-ms') {
      timeoutMs = parseInteger(valueAfter(index, arg), arg, { min: 1_000, max: 900_000 })
      index += 1
      continue
    }
    if (arg === '--port') {
      port = parseInteger(valueAfter(index, arg), arg, { min: 1, max: 65_535 })
      index += 1
      continue
    }
    if (arg === '--remote-port') {
      remotePort = parseInteger(valueAfter(index, arg), arg)
      index += 1
      continue
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`)
    if (packageArg !== null) throw new Error('only one release package directory may be supplied')
    packageArg = arg
  }

  if (!platform) {
    throw new Error('unsupported host platform; use --platform windows or --platform macos')
  }
  if (packageArg === null) throw new Error(`release package directory is required\n\n${usage()}`)
  if (port !== undefined && remotePort === undefined && port > 65_533) {
    throw new Error('--port must be at most 65533 when --remote-port is omitted')
  }
  if (port !== undefined && remotePort !== undefined && port === remotePort) {
    throw new Error('--port and --remote-port must be different')
  }

  return {
    packageDir: path.resolve(packageArg),
    installed,
    platform,
    launcher,
    timeoutMs,
    port,
    remotePort,
    launcherFlags: [
      ...(installed ? DEFAULT_LAUNCHER_FLAGS.filter((flag) => flag !== '--fresh-install') : DEFAULT_LAUNCHER_FLAGS),
      ...(installed ? ['--installed'] : []),
    ],
  }
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function windowsWrapperSource(launcherPath, launcherFlags) {
  const command = [quotePowerShell(launcherPath), ...launcherFlags.map(quotePowerShell)].join(' ')
  return [
    '$ErrorActionPreference = \'Stop\'',
    '# The current launcher starts a browser watcher through Start-Job. Keep the smoke run headless.',
    'function Start-Job { param([scriptblock]$ScriptBlock, [object[]]$ArgumentList) return $null }',
    'function Stop-Job { param([object]$Job) }',
    'function Remove-Job { param([object]$Job, [switch]$Force) }',
    '# A clean package cannot take the already-running-server branch; refuse any unexpected browser launch.',
    'function Start-Process { param([Parameter(Position=0)][string]$FilePath) if ($FilePath -match \'^https?://\') { return $null }; throw "smoke-distribution blocked unexpected Start-Process: $FilePath" }',
    `& ${command}`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n')
}

export function buildLauncherInvocation({ platform, launcherPath, wrapperPath, launcherFlags }) {
  if (platform === 'windows') {
    if (!wrapperPath) throw new Error('Windows launcher invocation requires a wrapper path')
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath],
      wrapper: windowsWrapperSource(launcherPath, launcherFlags),
    }
  }
  if (platform === 'macos') {
    return { command: 'zsh', args: [launcherPath, ...launcherFlags] }
  }
  throw new Error(`unsupported launcher platform: ${platform}`)
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function requireDirectory(target, label) {
  const stat = await lstatOrNull(target)
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is missing or is not a real directory: ${target}`)
  }
}

async function requireFile(target, label) {
  const stat = await lstatOrNull(target)
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`${label} is missing or empty: ${target}`)
  }
}

async function requireHtmlFile(target, label) {
  await requireFile(target, label)
  const body = await fs.readFile(target, 'utf8')
  if (!HTML_RE.test(body)) throw new Error(`${label} is not HTML: ${target}`)
}

async function requireAbsent(target, label) {
  const stat = await lstatOrNull(target)
  if (stat) throw new Error(`clean release package contains ${label}: ${target}`)
}

async function checkNoEnvEntries(root) {
  for (const relative of ['', 'server', 'client']) {
    const directory = path.join(root, relative)
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.env' || entry.name.startsWith('.env.')) {
        throw new Error(`release package contains environment file: ${path.join(relative, entry.name)}`)
      }
    }
  }
}

export async function readPackageBuild(root) {
  const file = path.join(root, PACKAGE_BUILD_FILE)
  await requireFile(file, `${PACKAGE_BUILD_FILE} (the mark of a shipped build)`)
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    throw new Error(`${PACKAGE_BUILD_FILE} is not valid JSON: ${file}`)
  }
  const commit = typeof parsed?.commit === 'string' && BUILD_COMMIT_RE.test(parsed.commit) ? parsed.commit : null
  if (!commit) throw new Error(`${PACKAGE_BUILD_FILE} has no commit the server accepts (7-40 hex characters): ${file}`)
  return { commit, date: typeof parsed.date === 'string' ? parsed.date : null }
}

async function requireAgentSchemas(root) {
  // Only packages whose server loads the schemas need them; the reader module
  // is the same file that would crash at runtime without them.
  if (!(await lstatOrNull(path.join(root, AGENT_SCHEMA_READER)))) return false
  for (const name of RUNTIME_AGENT_SCHEMAS) {
    const file = path.join(root, 'docs', 'agents', name)
    await requireFile(file, `agent schema docs/agents/${name}`)
    try {
      JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      throw new Error(`agent schema docs/agents/${name} is not valid JSON: ${file}`)
    }
  }
  return true
}

export async function assertBuyerPackageShape(packageDir, { platform, installed = false, repoRoot = REPO_ROOT } = {}) {
  const root = path.resolve(packageDir)
  if (root === path.resolve(repoRoot)) {
    throw new Error('refusing to smoke the repository itself; pass an unpacked release package')
  }
  await requireDirectory(root, 'release package')
  // A real distribution, not a working copy: with .git present (or without
  // build-info.json) the launcher decides by file dates and may rebuild the UI.
  await readPackageBuild(root)
  await requireAbsent(path.join(root, '.git'), '.git')
  await requireAgentSchemas(root)
  await requireDirectory(path.join(root, 'server'), 'server directory')
  await requireDirectory(path.join(root, 'client'), 'client directory')
  await requireFile(path.join(root, 'package.json'), 'root package.json')
  await requireFile(path.join(root, 'package-lock.json'), 'root package-lock.json')
  await requireFile(path.join(root, 'server', 'package.json'), 'server package.json')
  await requireFile(path.join(root, 'server', 'package-lock.json'), 'server package-lock.json')
  await requireFile(path.join(root, 'client', 'package.json'), 'client package.json')
  await requireFile(path.join(root, 'client', 'package-lock.json'), 'client package-lock.json')
  await requireHtmlFile(path.join(root, 'client', 'dist', 'index.html'), 'desktop UI')
  await requireHtmlFile(path.join(root, 'client', 'dist', 'tablet', 'tablet.html'), 'tablet UI')
  await requireFile(path.join(root, platform === 'windows' ? 'start.ps1' : 'start.command'), 'start launcher')
  await requireFile(path.join(root, platform === 'windows' ? 'stop.ps1' : 'stop.command'), 'stop launcher')

  await checkNoEnvEntries(root)
  for (const relative of ['.env', '.npmrc', 'data', 'server/data', 'client/data', 'server/.env']) {
    await requireAbsent(path.join(root, relative), relative)
  }
  if (!installed) {
    for (const relative of ['node_modules', 'server/node_modules', 'client/node_modules', 'runtime/node', 'runtime/node-unpack', 'runtime/node.tar.gz']) {
      await requireAbsent(path.join(root, relative), relative)
    }
  } else {
    // The shipped UI is already built. The launcher only runs the server and
    // therefore only needs server/node_modules; root/client dependencies are
    // optional build-time inputs and are intentionally absent from release ZIPs.
    for (const relative of INSTALLED_PACKAGE_PARTS.map((part) => path.join(part, 'node_modules'))) {
      await requireDirectory(path.join(root, relative), relative)
    }
  }
  return root
}

function isCredentialEnvName(name) {
  return name.startsWith('CANAI_')
    || name.startsWith('FAL_')
    || /^npm_config_.*auth/iu.test(name)
    || SECRET_ENV_RE.test(name)
    || /(?:AWS|AZURE|GOOGLE|OPENAI|ANTHROPIC|CLOUD|PROVIDER)/iu.test(name)
}

export function prepareLauncherEnvironment({ baseEnv = process.env, dataDir, envFile, port, remotePort, freshInstall }) {
  const env = { ...baseEnv }
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === 'psmodulepath' || isCredentialEnvName(name)) delete env[name]
  }
  env.CANAI_DATA_DIR = dataDir
  env.CANAI_ENV_FILE = envFile
  env.PORT = String(port)
  env.CANAI_REMOTE_PORT = String(remotePort)
  env.CANAI_UNATTENDED = '1'
  env.CANAI_NO_BROWSER = '1'
  env.CANAI_FRESH_INSTALL = freshInstall ? '1' : '0'
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  delete env.NODE_ENV
  delete env.NODE_OPTIONS
  delete env.NPM_CONFIG_USERCONFIG
  delete env.npm_config_userconfig
  return env
}

async function sha256File(file) {
  const hash = createHash('sha256')
  hash.update(await fs.readFile(file))
  return hash.digest('hex')
}

export async function prepareInstalledMarkers(root) {
  for (const relative of INSTALLED_PACKAGE_PARTS) {
    const packageRoot = path.join(root, relative)
    const modules = path.join(packageRoot, 'node_modules')
    const lock = path.join(packageRoot, 'package-lock.json')
    const marker = path.join(modules, '.canai-lock.sha256')
    await fs.writeFile(marker, `${await sha256File(lock)}\n`, 'ascii')
  }
}

export async function verifyInstalledMarkers(root) {
  for (const relative of INSTALLED_PACKAGE_PARTS) {
    const packageRoot = path.join(root, relative)
    const marker = path.join(packageRoot, 'node_modules', '.canai-lock.sha256')
    const expected = await sha256File(path.join(packageRoot, 'package-lock.json'))
    const actual = (await fs.readFile(marker, 'utf8')).trim()
    if (actual !== expected) throw new Error(`lock marker mismatch after install: ${marker}`)
  }
}

async function fileStamp(file) {
  const stat = await fs.stat(file)
  return `${stat.size}:${stat.mtimeMs}:${await sha256File(file)}`
}

// Taken before the first start. assertInterfaceNotRebuilt() compares against
// it after every start to catch a launcher that rebuilt the shipped UI.
export async function snapshotInterface(root) {
  const modules = {}
  for (const relative of BUILD_ONLY_MODULES) {
    modules[relative] = Boolean(await lstatOrNull(path.join(root, relative)))
  }
  const pages = {}
  for (const relative of BUILT_PAGES) pages[relative] = await fileStamp(path.join(root, relative))
  return { modules, pages }
}

export async function assertInterfaceNotRebuilt(root, before) {
  for (const [relative, existed] of Object.entries(before.modules)) {
    if (!existed && (await lstatOrNull(path.join(root, relative)))) {
      throw new Error(`launcher installed build-only dependencies (${relative}): the shipped interface was treated as stale`)
    }
  }
  for (const [relative, stamp] of Object.entries(before.pages)) {
    const now = await fileStamp(path.join(root, relative)).catch(() => 'missing')
    if (now !== stamp) throw new Error(`launcher rewrote ${relative}: the shipped interface was rebuilt`)
  }
  await requireDirectory(path.join(root, 'server', 'node_modules'), 'server/node_modules after start')
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function closeServer(server) {
  if (!server.listening) return
  await new Promise((resolve) => server.close(resolve))
}

function bindErrorDetails(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
    message: typeof error?.message === 'string' ? error.message : String(error),
  }
}

async function probePort(port) {
  const server = createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    return { available: true, server }
  } catch (error) {
    await closeServer(server)
    const details = bindErrorDetails(error)
    if (!EXPECTED_BIND_ERROR_CODES.has(details.code)) {
      throw new Error(`unable to probe smoke port ${port} (${details.code}): ${details.message}`, { cause: error })
    }
    return { available: false, ...details }
  }
}

async function probePair(mainPort, remotePort) {
  const main = await probePort(mainPort)
  if (!main.available) return { available: false, failedPort: mainPort, ...main }

  let remote
  try {
    remote = await probePort(remotePort)
  } catch (error) {
    await closeServer(main.server)
    throw error
  }
  if (!remote.available) {
    await closeServer(main.server)
    return { available: false, failedPort: remotePort, ...remote }
  }

  // Keep both sockets open while the pair is checked so a listener cannot
  // appear between the main and tablet probes. The launcher gets the ports
  // after this short reservation and remains responsible for handling a real
  // race with a foreign process.
  await closeServer(remote.server)
  await closeServer(main.server)
  return { available: true }
}

function formatPortFailure(result) {
  return `${result.failedPort} (${result.code}: ${result.message})`
}

function randomMainPort(random) {
  // Leave room for the default tablet port (main + 2) inside the range.
  const count = SMOKE_PORT_RANGE.end - 2 - SMOKE_PORT_RANGE.start + 1
  return SMOKE_PORT_RANGE.start + Math.min(count - 1, Math.floor(random() * count))
}

export async function choosePorts(
  requestedPort,
  requestedRemotePort,
  { random = Math.random, probe = probePair, attempts = SMOKE_PORT_ATTEMPTS } = {},
) {
  if (requestedPort !== undefined) {
    const remote = requestedRemotePort ?? requestedPort + 2
    if (remote > 65_535 || requestedPort === remote) throw new Error('requested main/tablet ports are invalid')
    const result = await probe(requestedPort, remote)
    if (!result.available) {
      const role = result.failedPort === requestedPort ? 'main' : 'tablet'
      throw new Error(`requested ${role} port cannot be reserved: ${formatPortFailure(result)}`)
    }
    return { requestedPort, requestedRemotePort: remote }
  }

  // Every attempt draws a fresh candidate. Windows excludes whole 100-port
  // blocks: a sequential walk that starts at the head of such a block spends
  // all its attempts inside it.
  const failures = []
  const tried = new Set()
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let main = randomMainPort(random)
    for (let redraw = 0; tried.has(main) && redraw < 8; redraw += 1) main = randomMainPort(random)
    tried.add(main)
    const remote = requestedRemotePort ?? main + 2
    if (remote === main) continue
    const result = await probe(main, remote)
    if (result.available) return { requestedPort: main, requestedRemotePort: remote }
    // A pinned tablet port that cannot be bound fails for every main candidate.
    if (requestedRemotePort !== undefined && result.failedPort === requestedRemotePort) {
      throw new Error(`requested tablet port cannot be reserved: ${formatPortFailure(result)}`)
    }
    failures.push(formatPortFailure(result))
  }
  const details = failures.length > 0
    ? `; bind failures: ${failures.slice(-8).join(', ')}`
    : ''
  throw new Error(
    `could not reserve free smoke ports in safe range ${SMOKE_PORT_RANGE.start}-${SMOKE_PORT_RANGE.end}`
      + (requestedRemotePort === undefined ? '' : ` with requested tablet port ${requestedRemotePort}`)
      + ` after ${attempts} random attempts${details}`,
  )
}

function appendOutput(state, field, chunk) {
  const text = String(chunk)
  state[field] = `${state[field]}${text}`.slice(-20_000)
}

function redactOutput(value) {
  return String(value)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/((?:key|token|secret|password|credential)\s*[=:]\s*)[^\s,;]+/giu, '$1[redacted]')
}

function commandOutput(state) {
  const stdout = redactOutput(state.stdout).trim()
  const stderr = redactOutput(state.stderr).trim()
  return [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join('\n')
}

export function spawnTracked(context, label, command, args, options) {
  const state = { label, stdout: '', stderr: '' }
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Windows PowerShell 5.1 can silently exit with Node 22 when detached and
    // windowsHide are combined. taskkill /T still owns its child tree without
    // detached; Unix needs a separate process group for cleanup.
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  state.child = child
  child.stdout?.on('data', (chunk) => appendOutput(state, 'stdout', chunk))
  child.stderr?.on('data', (chunk) => appendOutput(state, 'stderr', chunk))
  child.on('error', (error) => appendOutput(state, 'stderr', error.stack ?? error.message))
  context.children.add(state)
  return state
}

function isRunning(state) {
  return state.child.exitCode === null && state.child.signalCode === null
}

async function waitForChild(state, timeoutMs) {
  if (!isRunning(state)) return state.child.exitCode ?? 1
  const result = await Promise.race([
    new Promise((resolve) => state.child.once('close', (code) => resolve(code ?? 1))),
    sleep(timeoutMs).then(() => null),
  ])
  if (result === null) throw new Error(`${state.label} did not exit within ${timeoutMs}ms\n${commandOutput(state)}`)
  return result
}

async function terminateTree(state) {
  if (!isRunning(state)) return
  const pid = state.child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    await new Promise((resolve) => killer.once('close', resolve))
  } else {
    try { process.kill(-pid, 'SIGTERM') } catch (error) { if (error?.code !== 'ESRCH') throw error }
  }
  await Promise.race([new Promise((resolve) => state.child.once('close', resolve)), sleep(10_000)])
  if (isRunning(state)) {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      await new Promise((resolve) => killer.once('close', resolve))
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error?.code !== 'ESRCH') throw error }
    }
  }
}

async function createBrowserShim(runDir) {
  const shimDir = path.join(runDir, 'bin')
  await fs.mkdir(shimDir, { recursive: true })
  const shim = path.join(shimDir, 'open')
  await fs.writeFile(shim, '#!/bin/sh\n# smoke-distribution browser suppression\nexit 0\n', { mode: 0o755 })
  return shimDir
}

async function readControl(controlPath) {
  try {
    const raw = await fs.readFile(controlPath, 'utf8')
    const value = JSON.parse(raw)
    if (value?.version !== 1 || !Number.isInteger(value.port) || !Number.isInteger(value.pid) || !value.instanceId) return null
    return value
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

async function httpRequest(url, { method = 'GET', headers, body, timeoutMs = 2_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' })
    return { response, body: await response.text() }
  } finally {
    clearTimeout(timer)
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function snippet(text) {
  return redactOutput(String(text)).replace(/\s+/gu, ' ').trim().slice(0, 200)
}

async function portListening(port) {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

function launcherOutput(state) {
  const output = state ? commandOutput(state) : ''
  return output ? `\n${output}` : ''
}

// check() returns false/undefined while the condition is not met yet. An
// ordinary exception is remembered and retried; a SmokeFatalError ends the
// wait at once, because no amount of polling can fix it.
export async function waitFor(label, check, timeoutMs, state, { intervalMs = 250, timeoutHint = '' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    if (state && !isRunning(state)) {
      throw new Error(`${state.label} exited before ${label} (exit=${state.child.exitCode}, signal=${state.child.signalCode})\n${commandOutput(state)}`)
    }
    try {
      const result = await check()
      if (result !== undefined && result !== false) return result
    } catch (error) {
      if (error instanceof SmokeFatalError) {
        throw new SmokeFatalError(`${error.message}${launcherOutput(state)}`, { cause: error })
      }
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`
      + `${timeoutHint ? ` (${timeoutHint})` : ''}${launcherOutput(state)}`,
  )
}

// One readiness probe. Returns false while the server is still starting and
// throws SmokeFatalError for a state that will not change by waiting.
export async function checkReadiness({ control, requestedPort, requestedRemotePort, expectedCommit, request = httpRequest }) {
  if (!control) return false
  const mainPort = control.port
  const mainBase = `http://127.0.0.1:${mainPort}`
  const remoteBase = `http://127.0.0.1:${requestedRemotePort}`
  const statusResult = await request(`${mainBase}/api/status`)
  if (!statusResult.response.ok) return false
  const status = parseJson(statusResult.body)
  if (!status?.instanceId || status.instanceId !== control.instanceId || typeof status.mockMode !== 'boolean') return false
  if (status.mockMode) {
    throw new SmokeFatalError('the server started in mock (demo) mode; a release package must start production')
  }
  if (status.falConfigured !== false) {
    throw new SmokeFatalError(
      `the server reports a configured fal.ai key (falConfigured=${JSON.stringify(status.falConfigured)}); a release package must start without credentials`,
    )
  }
  if (expectedCommit && status.build?.commit !== expectedCommit) {
    throw new SmokeFatalError(
      `the server reports build ${status.build?.commit ?? 'unknown'}, but ${PACKAGE_BUILD_FILE} of the package says ${expectedCommit}`,
    )
  }

  const desktop = await request(`${mainBase}/`)
  if (desktop.response.status !== 200 || !HTML_RE.test(desktop.body)) return false

  // A failed tablet bind is not fatal for the server: it keeps running and
  // only records the reason. Without this check the smoke would wait for
  // /health until the cycle timeout and report nothing useful.
  const access = await request(`${mainBase}/api/remote-access`)
  if (access.response.status === 404) {
    throw new SmokeFatalError('the server has no /api/remote-access: the tablet listener state cannot be verified')
  }
  if (access.response.status !== 200) throw new Error(`/api/remote-access returned HTTP ${access.response.status}`)
  const listener = parseJson(access.body)?.server
  if (!listener || typeof listener !== 'object') throw new Error('/api/remote-access has no tablet listener state')
  if (listener.error) {
    throw new SmokeFatalError(`the tablet listener could not bind port ${listener.port}: ${listener.error}`)
  }
  if (listener.port !== requestedRemotePort) {
    throw new SmokeFatalError(`the tablet listener uses port ${listener.port}, but the smoke requested ${requestedRemotePort}`)
  }
  if (listener.running !== true) return false

  const health = await request(`${remoteBase}/health`)
  if (health.response.status !== 200 || parseJson(health.body)?.ok !== true) return false
  const tablet = await request(`${remoteBase}/`)
  if (tablet.response.status !== 200 || !HTML_RE.test(tablet.body)) return false

  return {
    mainPort,
    tabletPort: requestedRemotePort,
    requestedMainPort: requestedPort,
    instanceId: control.instanceId,
    pid: control.pid,
    build: status.build?.commit ?? null,
  }
}

async function waitForReadiness({ state, dataDir, requestedPort, requestedRemotePort, expectedCommit, timeoutMs }) {
  const controlPath = path.join(dataDir, 'runtime-control.json')
  return await waitFor('desktop and tablet HTTP readiness', async () => checkReadiness({
    control: await readControl(controlPath),
    requestedPort,
    requestedRemotePort,
    expectedCommit,
  }), timeoutMs, state, {
    // A clean start runs npm ci first; the launcher output below shows how far it got.
    timeoutHint: 'a first install over a slow network may need a larger --timeout-ms, up to 900000',
  })
}

// The health identity ties the tablet listener to the desktop lifecycle without
// turning LAN access on. A disabled tablet door must not issue a login session.
export async function confirmTabletInstance({ mainPort, tabletPort, instanceId, request = httpRequest }) {
  const mainBase = `http://127.0.0.1:${mainPort}`
  const remoteBase = `http://127.0.0.1:${tabletPort}`
  const access = await request(`${mainBase}/api/remote-access`)
  if (access.response.status !== 200) throw new Error(`cannot verify closed tablet access: HTTP ${access.response.status}`)
  const state = parseJson(access.body)
  if (state?.enabled !== false || state?.server?.lan !== false) {
    throw new SmokeFatalError('tablet LAN access is enabled; distribution smoke must keep LAN access switched off')
  }
  const seen = await request(`${remoteBase}/health`, { timeoutMs: 10_000 })
  if (seen.response.status !== 200) {
    throw new Error(`the tablet health check returned HTTP ${seen.response.status}`)
  }
  const health = parseJson(seen.body)
  if (health?.ok !== true || health.instanceId !== instanceId) {
    throw new SmokeFatalError(
      `tablet port ${tabletPort} is served by another instance (${health?.instanceId ?? 'unknown'}), expected ${instanceId}`,
    )
  }
  const login = await request(`${remoteBase}/api/remote/login`, {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ pin: '12345678', device: 'smoke-distribution' }), timeoutMs: 10_000,
  })
  if (login.response.status !== 401 || login.response.headers.get('set-cookie')) {
    throw new SmokeFatalError(`disabled tablet access must reject login without a cookie: HTTP ${login.response.status}`)
  }
  const session = await request(`${remoteBase}/api/remote/session`)
  const sessionState = parseJson(session.body)
  if (session.response.status !== 200 || sessionState?.authorized !== false || sessionState.csrf != null) {
    throw new SmokeFatalError('disabled tablet access still authorizes a session')
  }
  return true
}

// The server names its own Node in the diagnostics bundle (no network, nothing
// is sent). "bundled" follows the launcher rule: runtime/node wins when present.
export async function readServerNode({ mainPort, packageDir, platform, request = httpRequest }) {
  let version = null
  try {
    const bundle = await request(`http://127.0.0.1:${mainPort}/api/diagnostics/report`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode: 'bundle', description: 'smoke-distribution' }),
      timeoutMs: 10_000,
    })
    const node = bundle.response.status === 200 ? parseJson(bundle.body)?.report?.server?.info?.node : null
    if (typeof node === 'string' && /^v\d+\.\d+\.\d+/u.test(node)) version = node
  } catch {
    // Informational only: an unknown version is printed as unknown.
  }
  const binary = platform === 'windows' ? 'node.exe' : path.join('bin', 'node')
  const bundled = await lstatOrNull(path.join(packageDir, 'runtime', 'node', binary))
  return { version, origin: bundled ? 'bundled' : 'system' }
}

// Version the launcher downloads when the machine has no suitable Node.
export async function readPinnedNode(launcherPath) {
  const source = await fs.readFile(launcherPath, 'utf8').catch(() => '')
  return /node_?version\s*=\s*['"]?(v\d+\.\d+\.\d+)/iu.exec(source)?.[1] ?? null
}

export function describeNode({ version, origin, pinned }) {
  const shown = version ?? 'unknown version'
  if (origin === 'bundled') return `${shown} (portable Node in runtime/node, the launcher pins ${pinned ?? 'an unknown version'})`
  return `${shown} (system Node from PATH; the pinned ${pinned ?? 'portable'} download was not exercised)`
}

// The final line says what the run proved and, just as plainly, what it did not.
export function formatPassLine({ mode, ports, build, node, agentSchemas, cycles }) {
  const proven = [
    `shipped build ${build.commit} without .git, .env or data`,
    mode === 'clean' ? 'first-run install of server dependencies only' : 'start on preinstalled server dependencies',
    'interface not rebuilt (no build dependencies installed in root/client, client/dist untouched)',
    'production status of this build without mock mode or a fal.ai key',
    'desktop and tablet pages',
    'tablet listener bound by this instance (same instanceId through health; LAN off; login denied)',
    ...(agentSchemas ? ['agent schemas present in docs/agents'] : []),
    ...(node.origin === 'bundled' ? [`portable Node ${node.version ?? ''} from runtime/node`.replace(/\s+/gu, ' ')] : []),
    `${cycles} start/stop cycles`,
  ]
  const notProven = [
    ...(node.origin === 'bundled' ? [] : [`pinned Node ${node.pinned ?? ''} download (the server ran on system Node ${node.version ?? 'of unknown version'})`.replace(/\s+/gu, ' ')]),
    ...(mode === 'clean' ? ['registry availability of every dependency (npm may have served them from its local cache)'] : ['clean first install (--installed)']),
    'generation, agents and model catalog at runtime',
    'tablet access from the LAN',
    'browser auto-open and OS download prompts',
  ]
  return `[smoke] PASS: release package restarted cleanly on main/tablet ports ${ports.mainPort}/${ports.tabletPort}`
    + ` | proven: ${proven.join('; ')}`
    + ` | NOT proven: ${notProven.join('; ')}`
}

async function waitForPortsClosed(ports, timeoutMs) {
  await waitFor('main and tablet ports to close', async () => {
    if (await portListening(ports.mainPort)) return false
    if (await portListening(ports.tabletPort)) return false
    return true
  }, timeoutMs)
}

async function waitForControlGone(controlPath, timeoutMs) {
  await waitFor('runtime control file to clear', async () => {
    return (await lstatOrNull(controlPath)) === null
  }, timeoutMs)
}

function resolveLauncherPath(args) {
  const defaultName = args.platform === 'windows' ? 'start.ps1' : 'start.command'
  return args.launcher ?? path.join(args.packageDir, defaultName)
}

function resolveStopPath(args) {
  return path.join(args.packageDir, args.platform === 'windows' ? 'stop.ps1' : 'stop.command')
}

function stopInvocation(args, stopPath) {
  return args.platform === 'windows'
    ? { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopPath] }
    : { command: 'zsh', args: [stopPath] }
}

async function runStopLauncher(context, args, env, timeoutMs) {
  const stopPath = resolveStopPath(args)
  await requireFile(stopPath, 'configured stop launcher')
  const invocation = stopInvocation(args, stopPath)
  const state = spawnTracked(context, 'stop launcher', invocation.command, invocation.args, {
    cwd: args.packageDir,
    env,
  })
  const code = await waitForChild(state, Math.min(timeoutMs, 45_000))
  if (code !== 0) throw new Error(`stop launcher exited with code ${code}\n${commandOutput(state)}`)
}

export async function stopOrphan(
  context,
  args,
  env,
  dataDir,
  timeoutMs,
  { runStop = runStopLauncher, waitPorts = waitForPortsClosed, waitControl = waitForControlGone } = {},
) {
  const controlPath = path.join(dataDir, 'runtime-control.json')
  const control = await readControl(controlPath)
  if (!control) {
    if (await lstatOrNull(controlPath)) throw new Error('runtime-control.json exists but is invalid; preserving smoke diagnostics')
    return false
  }
  const tabletPort = Number(env.CANAI_REMOTE_PORT)
  if (!Number.isInteger(tabletPort) || tabletPort < 1 || tabletPort > 65_535) {
    throw new Error('private smoke environment has no valid tablet port for orphan cleanup')
  }
  await runStop(context, args, env, timeoutMs)
  await waitPorts({ mainPort: control.port, tabletPort }, Math.min(timeoutMs, 45_000))
  await waitControl(controlPath, Math.min(timeoutMs, 45_000))
  return true
}

async function startCycle(context, args, runDir, ports, dataDir, env, cycle, expectedCommit) {
  const launcherPath = resolveLauncherPath(args)
  await requireFile(launcherPath, 'configured start launcher')
  const launcherFlags = cycle === 0
    ? args.launcherFlags
    : args.launcherFlags.filter((flag) => flag !== '--fresh-install')
  const wrapperPath = args.platform === 'windows'
    ? path.join(runDir, `launcher-wrapper-${cycle}.ps1`)
    : undefined
  const invocation = buildLauncherInvocation({
    platform: args.platform,
    launcherPath,
    wrapperPath,
    launcherFlags,
  })
  if (invocation.wrapper) await fs.writeFile(wrapperPath, invocation.wrapper, 'utf8')
  const state = spawnTracked(context, `start cycle ${cycle + 1}`, invocation.command, invocation.args, {
    cwd: args.packageDir,
    env,
  })
  const ready = await waitForReadiness({
    state,
    dataDir,
    requestedPort: ports.requestedPort,
    requestedRemotePort: ports.requestedRemotePort,
    expectedCommit,
    timeoutMs: args.timeoutMs,
  })
  console.log(`[smoke] cycle ${cycle + 1}: desktop ${ready.mainPort}, tablet ${ready.tabletPort}, build ${ready.build}`)
  return { state, ready }
}

async function stopCycle(context, args, env, active, timeoutMs) {
  if (!active) return
  await runStopLauncher(context, args, env, timeoutMs)
  await waitForPortsClosed(active.ready, Math.min(timeoutMs, 45_000))
  await waitForControlGone(path.join(env.CANAI_DATA_DIR, 'runtime-control.json'), Math.min(timeoutMs, 45_000))
  if (isRunning(active.state)) {
    await waitForChild(active.state, Math.min(timeoutMs, 15_000)).catch(async () => {
      await terminateTree(active.state)
    })
  }
}

async function assertDataIsolation(root) {
  for (const relative of ['.env', '.npmrc', 'data', 'server/data', 'client/data', 'server/.env']) {
    await requireAbsent(path.join(root, relative), relative)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  await assertBuyerPackageShape(args.packageDir, { platform: args.platform, installed: args.installed })
  const build = await readPackageBuild(args.packageDir)
  const agentSchemas = Boolean(await lstatOrNull(path.join(args.packageDir, AGENT_SCHEMA_READER)))
  const interfaceBefore = await snapshotInterface(args.packageDir)
  if (args.installed) await prepareInstalledMarkers(args.packageDir)
  // Before the private directory exists: a port failure leaves nothing behind.
  const ports = await choosePorts(args.port, args.remotePort)

  const temporaryRoot = await fs.realpath(os.tmpdir())
  const runDir = await fs.mkdtemp(path.join(temporaryRoot, 'canai-distribution-smoke-'))
  const ownedRunDir = await fs.realpath(runDir)
  const dataDir = path.join(runDir, 'data')
  const envFile = path.join(runDir, 'missing.env')
  await fs.mkdir(dataDir, { recursive: true })
  console.log(
    `[smoke] build ${build.commit}, ${args.installed ? 'installed' : 'clean'} mode;`
      + ` requested main/tablet ports ${ports.requestedPort}/${ports.requestedRemotePort}; private data in ${runDir}`,
  )
  const env = prepareLauncherEnvironment({
    dataDir,
    envFile,
    port: ports.requestedPort,
    remotePort: ports.requestedRemotePort,
    freshInstall: !args.installed,
  })
  const npmrc = path.join(runDir, 'empty.npmrc')
  await fs.writeFile(npmrc, '# smoke-distribution intentionally has no user registry credentials\n', 'utf8')
  env.NPM_CONFIG_USERCONFIG = npmrc
  env.npm_config_userconfig = npmrc
  const context = { children: new Set() }
  let active = null
  let lastReady = null
  let node = null
  const cycles = 2
  try {
    if (args.platform === 'macos') {
      const shimDir = await createBrowserShim(runDir)
      env.PATH = `${shimDir}${path.delimiter}${env.PATH ?? ''}`
    }
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      active = await startCycle(context, args, runDir, ports, dataDir, env, cycle, build.commit)
      lastReady = active.ready
      await assertDataIsolation(args.packageDir)
      if (cycle === 0) await verifyInstalledMarkers(args.packageDir)
      await assertInterfaceNotRebuilt(args.packageDir, interfaceBefore)
      // The tablet listener starts asynchronously after the desktop listener.
      await waitFor('the tablet door to answer for this instance', () => confirmTabletInstance({
        mainPort: lastReady.mainPort,
        tabletPort: lastReady.tabletPort,
        instanceId: lastReady.instanceId,
      }), 30_000, active.state, { intervalMs: 1_000 })
      if (cycle === 0) {
        node = {
          ...(await readServerNode({ mainPort: lastReady.mainPort, packageDir: args.packageDir, platform: args.platform })),
          pinned: await readPinnedNode(resolveLauncherPath(args)),
        }
        console.log(`[smoke] Node.js that ran the server: ${describeNode(node)}`)
      }
      await stopCycle(context, args, env, active, args.timeoutMs)
      active = null
      await assertDataIsolation(args.packageDir)
    }
    await assertInterfaceNotRebuilt(args.packageDir, interfaceBefore)
    console.log(formatPassLine({
      mode: args.installed ? 'installed' : 'clean',
      ports: lastReady,
      build,
      node,
      agentSchemas,
      cycles,
    }))
  } finally {
    let cleanupFailure = null
    if (active) {
      try { await stopCycle(context, args, env, active, 15_000) } catch (error) { cleanupFailure = error }
      active = null
    }
    try {
      await stopOrphan(context, args, env, dataDir, 15_000)
    } catch (error) {
      cleanupFailure = cleanupFailure ?? error
    }
    for (const state of context.children) {
      try { await terminateTree(state) } catch (error) { cleanupFailure = cleanupFailure ?? error }
    }
    if (cleanupFailure) {
      console.error(`[smoke] cleanup failed; preserving diagnostics in ${runDir}: ${cleanupFailure.message}`)
      throw cleanupFailure
    }
    const resolved = await fs.realpath(runDir)
    const relative = path.relative(temporaryRoot, resolved)
    if (resolved !== ownedRunDir || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('refusing to remove a changed smoke temporary directory')
    }
    await fs.rm(resolved, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH
if (isMain) {
  main().catch((error) => {
    console.error(`[smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_LAUNCHER_FLAGS,
  RUNTIME_AGENT_SCHEMAS,
  SMOKE_PORT_RANGE,
  SmokeFatalError,
  assertBuyerPackageShape,
  assertInterfaceNotRebuilt,
  buildLauncherInvocation,
  checkReadiness,
  choosePorts,
  confirmTabletInstance,
  describeNode,
  formatPassLine,
  parseArgs,
  prepareInstalledMarkers,
  prepareLauncherEnvironment,
  readPackageBuild,
  readPinnedNode,
  readServerNode,
  snapshotInterface,
  stopOrphan,
  spawnTracked,
  verifyInstalledMarkers,
  waitFor,
} from './smoke-distribution.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_COMMIT = '0123456789ab'

test('hidden Windows PowerShell actually executes the tracked command', { skip: process.platform !== 'win32' }, async () => {
  const context = { children: new Set() }
  const state = spawnTracked(context, 'PowerShell probe', 'powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', "Write-Output 'canai-smoke-probe'; exit 7",
  ], { env: process.env })
  const code = await new Promise((resolve, reject) => {
    state.child.once('error', reject)
    state.child.once('close', resolve)
  })
  assert.equal(code, 7)
  assert.match(state.stdout, /canai-smoke-probe/)
})

async function buyerFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-distribution-fixture-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'client', 'dist', 'tablet'), { recursive: true })
  await fs.mkdir(path.join(root, 'server', 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'client', 'dist', 'index.html'), '<!doctype html><html></html>')
  await fs.writeFile(path.join(root, 'client', 'dist', 'tablet', 'tablet.html'), '<!doctype html><html></html>')
  await fs.writeFile(path.join(root, 'client', 'package.json'), '{}')
  await fs.writeFile(path.join(root, 'client', 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }))
  await fs.writeFile(path.join(root, 'server', 'package.json'), '{}')
  await fs.writeFile(path.join(root, 'server', 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }))
  await fs.writeFile(path.join(root, 'package.json'), '{}')
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }))
  await fs.writeFile(
    path.join(root, 'build-info.json'),
    JSON.stringify({ commit: FIXTURE_COMMIT, date: '2026-10-05T12:00:00+03:00' }),
  )
  await fs.writeFile(path.join(root, 'start.ps1'), '# launcher')
  await fs.writeFile(path.join(root, 'start.command'), '#!/bin/zsh\n')
  await fs.writeFile(path.join(root, 'stop.ps1'), '# stop')
  await fs.writeFile(path.join(root, 'stop.command'), '#!/bin/zsh\n')
  return root
}

test('parseArgs exposes the CI contract and launcher flags', () => {
  const parsed = parseArgs([
    'buyer',
    '--installed',
    '--platform', 'macos',
    '--launcher', 'custom.command',
    '--timeout-ms', '12000',
    '--port', '19001',
    '--remote-port', '19003',
  ])
  assert.equal(parsed.packageDir, path.resolve('buyer'))
  assert.equal(parsed.installed, true)
  assert.equal(parsed.platform, 'macos')
  assert.equal(parsed.launcher, path.resolve('custom.command'))
  assert.equal(parsed.timeoutMs, 12000)
  assert.equal(parsed.port, 19001)
  assert.equal(parsed.remotePort, 19003)
  assert.deepEqual(parsed.launcherFlags, ['--unattended', '--no-browser', '--installed'])
})

test('launcher invocation uses the native shell and unattended flags', () => {
  const windows = buildLauncherInvocation({
    platform: 'windows',
    launcherPath: 'C:\\buyer\\start.ps1',
    wrapperPath: 'C:\\temp\\smoke-wrapper.ps1',
    launcherFlags: DEFAULT_LAUNCHER_FLAGS,
  })
  assert.equal(windows.command, 'powershell.exe')
  assert.deepEqual(windows.args, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\temp\\smoke-wrapper.ps1',
  ])
  assert.match(windows.wrapper, /--unattended/u)
  assert.match(windows.wrapper, /--no-browser/u)
  assert.match(windows.wrapper, /--fresh-install/u)

  const macos = buildLauncherInvocation({
    platform: 'macos',
    launcherPath: '/buyer/start.command',
    launcherFlags: DEFAULT_LAUNCHER_FLAGS,
  })
  assert.equal(macos.command, 'zsh')
  assert.deepEqual(macos.args, ['/buyer/start.command', ...DEFAULT_LAUNCHER_FLAGS])
})

test('buyer preflight rejects env, data, and node_modules in a clean package', async (t) => {
  const root = await buyerFixture(t)
  await assertBuyerPackageShape(root, { platform: 'windows', installed: false })

  await fs.mkdir(path.join(root, 'server', 'data'))
  await assert.rejects(
    () => assertBuyerPackageShape(root, { platform: 'windows', installed: false }),
    /server[\\/]data/u,
  )
  await fs.rm(path.join(root, 'server', 'data'), { recursive: true })

  await fs.writeFile(path.join(root, 'server', '.env'), 'FAL_KEY=must-not-be-read')
  await assert.rejects(
    () => assertBuyerPackageShape(root, { platform: 'windows', installed: false }),
    /server[\\/]\.env/u,
  )
  await fs.rm(path.join(root, 'server', '.env'))

  await fs.mkdir(path.join(root, 'node_modules'))
  await assert.rejects(
    () => assertBuyerPackageShape(root, { platform: 'windows', installed: false }),
    /node_modules/u,
  )
})

test('installed mode requires buyer modules and prepares only buyer lock markers', async (t) => {
  const root = await buyerFixture(t)
  await fs.mkdir(path.join(root, 'server', 'node_modules'), { recursive: true })
  await assertBuyerPackageShape(root, { platform: 'macos', installed: true })
  await prepareInstalledMarkers(root)
  await verifyInstalledMarkers(root)
  await assert.rejects(() => fs.access(path.join(root, 'node_modules')), { code: 'ENOENT' })
  await assert.rejects(() => fs.access(path.join(root, 'client', 'node_modules')), { code: 'ENOENT' })

  const env = prepareLauncherEnvironment({
    baseEnv: {
      FAL_KEY: 'must-not-pass',
      FAL_BILLING_TOKEN: 'must-not-pass',
      CANAI_DATA_DIR: 'wrong',
      CANAI_SHARE_TOKEN: 'must-not-pass',
      OPENAI_API_KEY: 'must-not-pass',
      GITHUB_TOKEN: 'must-not-pass',
      pSmOdUlEpAtH: 'must-not-pass',
      NODE_ENV: 'must-not-pass',
      NODE_OPTIONS: '--require=must-not-pass',
      PATH: 'path',
    },
    dataDir: path.join(os.tmpdir(), 'smoke-data'),
    envFile: path.join(os.tmpdir(), 'smoke-env-does-not-exist'),
    port: 19001,
    remotePort: 19003,
    freshInstall: false,
  })
  assert.equal(env.FAL_KEY, undefined)
  assert.equal(env.FAL_BILLING_TOKEN, undefined)
  assert.equal(env.CANAI_SHARE_TOKEN, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.pSmOdUlEpAtH, undefined)
  assert.equal(env.NODE_ENV, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.CANAI_DATA_DIR, path.join(os.tmpdir(), 'smoke-data'))
  assert.equal(env.CANAI_ENV_FILE, path.join(os.tmpdir(), 'smoke-env-does-not-exist'))
  assert.equal(env.PORT, '19001')
  assert.equal(env.CANAI_REMOTE_PORT, '19003')
  assert.equal(env.CANAI_FRESH_INSTALL, '0')
})

test('default smoke ports stay in the user-port range and keep the tablet offset', async () => {
  const ports = await choosePorts()
  assert.equal(ports.requestedRemotePort, ports.requestedPort + 2)
  assert.ok(ports.requestedPort >= SMOKE_PORT_RANGE.start)
  assert.ok(ports.requestedRemotePort <= SMOKE_PORT_RANGE.end)
})

test('requested port failures include the bind cause without touching the listener', async (t) => {
  const blocker = createServer()
  await new Promise((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => blocker.close())
  const blockedPort = blocker.address().port
  // The OS may hand out 65534 or 65535: the tablet port must stay a valid one.
  const tabletPort = blockedPort <= 65_533 ? blockedPort + 2 : blockedPort - 2
  await assert.rejects(
    () => choosePorts(blockedPort, tabletPort),
    new RegExp(`requested main port cannot be reserved: ${blockedPort} \\(EADDRINUSE:`),
  )
  assert.equal(blocker.listening, true)
})

test('a requested main port at the top of the range keeps the pair valid', async () => {
  const probed = []
  const probe = async (main, remote) => {
    probed.push([main, remote])
    return { available: true }
  }
  assert.deepEqual(await choosePorts(65_535, 65_533, { probe }), { requestedPort: 65_535, requestedRemotePort: 65_533 })
  assert.deepEqual(probed, [[65_535, 65_533]])
  await assert.rejects(() => choosePorts(65_534, undefined, { probe }), /requested main\/tablet ports are invalid/u)
})

function randomFor(...ports) {
  // Math.random() values that land exactly on the given main ports.
  const count = SMOKE_PORT_RANGE.end - 2 - SMOKE_PORT_RANGE.start + 1
  const queue = ports.map((port) => (port - SMOKE_PORT_RANGE.start + 0.5) / count)
  return () => {
    if (queue.length === 0) throw new Error('the port draw was asked for more candidates than the test planned')
    return queue.shift()
  }
}

test('every attempt draws a fresh random candidate instead of walking a blocked 100-port range', async () => {
  // Windows excludes whole 100-port blocks. Landing on the head of one must
  // not spend the remaining attempts on its neighbours.
  const excluded = (port) => port >= 24_300 && port <= 24_399
  const probed = []
  const probe = async (main, remote) => {
    probed.push(main)
    const failedPort = [main, remote].find(excluded)
    return failedPort === undefined
      ? { available: true }
      : { available: false, failedPort, code: 'EACCES', message: 'listen EACCES: permission denied' }
  }
  const ports = await choosePorts(undefined, undefined, { probe, random: randomFor(24_300, 24_398, 27_011) })
  assert.deepEqual(ports, { requestedPort: 27_011, requestedRemotePort: 27_013 })
  assert.deepEqual(probed, [24_300, 24_398, 27_011])
})

test('a repeated draw is replaced and exhausted attempts report the bind causes', async () => {
  const probed = []
  const probe = async (main) => {
    probed.push(main)
    return { available: false, failedPort: main, code: 'EADDRINUSE', message: 'address already in use' }
  }
  await assert.rejects(
    () => choosePorts(undefined, undefined, { probe, attempts: 3, random: randomFor(21_000, 21_000, 22_000, 23_000) }),
    /could not reserve free smoke ports in safe range 20000-30000 after 3 random attempts; bind failures: 21000 \(EADDRINUSE: address already in use\), 22000 .*23000 /u,
  )
  assert.deepEqual(probed, [21_000, 22_000, 23_000])
})

test('a pinned tablet port that cannot be bound fails at once with its cause', async () => {
  let probes = 0
  const probe = async (_main, remote) => {
    probes += 1
    return { available: false, failedPort: remote, code: 'EACCES', message: 'permission denied' }
  }
  await assert.rejects(
    () => choosePorts(undefined, 25_002, { probe }),
    /requested tablet port cannot be reserved: 25002 \(EACCES: permission denied\)/u,
  )
  assert.equal(probes, 1)
  await assert.rejects(
    () => choosePorts(21_000, 21_002, { probe }),
    /requested tablet port cannot be reserved: 21002 \(EACCES/u,
  )
})

test('waitFor stops at once on a fatal condition and keeps retrying ordinary errors', async () => {
  let fatalChecks = 0
  const started = Date.now()
  await assert.rejects(
    () => waitFor('readiness', async () => {
      fatalChecks += 1
      throw new SmokeFatalError('the server started in mock (demo) mode')
    }, 20_000),
    (error) => error instanceof SmokeFatalError && /mock \(demo\) mode/u.test(error.message),
  )
  assert.equal(fatalChecks, 1)
  assert.ok(Date.now() - started < 5_000, 'a fatal condition must not wait for the timeout')

  let attempts = 0
  const value = await waitFor('recovery', async () => {
    attempts += 1
    if (attempts < 3) throw new Error('connection refused')
    return { ready: true }
  }, 5_000, undefined, { intervalMs: 5 })
  assert.deepEqual(value, { ready: true })
  assert.equal(attempts, 3)

  await assert.rejects(
    () => waitFor('never', async () => { throw new Error('connection refused') }, 40, undefined, { intervalMs: 5 }),
    (error) => !(error instanceof SmokeFatalError) && /timed out after 40ms waiting for never: connection refused/u.test(error.message),
  )
  await assert.rejects(
    () => waitFor('install', async () => false, 30, undefined, { intervalMs: 5, timeoutHint: 'raise --timeout-ms' }),
    /timed out after 30ms waiting for install \(raise --timeout-ms\)$/u,
  )
})

const MAIN_PORT = 21_000
const TABLET_PORT = 21_002
const PAGE = '<!doctype html><html></html>'

function fakeInstance(overrides = {}) {
  const state = {
    status: { instanceId: 'instance-1', mockMode: false, falConfigured: false, build: { commit: FIXTURE_COMMIT } },
    access: { enabled: false, pinSet: false, server: { running: true, lan: false, port: TABLET_PORT, error: null } },
    ...overrides,
  }
  const calls = []
  const reply = (status, body) => ({
    response: { status, ok: status >= 200 && status < 300, headers: new Headers() },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const request = async (url) => {
    const { port, pathname } = new URL(url)
    calls.push(`${port}${pathname}`)
    if (Number(port) === MAIN_PORT) {
      if (pathname === '/api/status') return reply(200, state.status)
      if (pathname === '/api/remote-access') return state.access ? reply(200, state.access) : reply(404, { error: 'нет' })
      if (pathname === '/') return reply(200, PAGE)
    }
    if (Number(port) === TABLET_PORT) {
      if (pathname === '/health') return reply(200, { ok: true })
      if (pathname === '/') return reply(200, PAGE)
    }
    return reply(404, 'not found')
  }
  const probe = () => checkReadiness({
    control: { version: 1, port: MAIN_PORT, pid: 4242, instanceId: 'instance-1' },
    requestedPort: MAIN_PORT,
    requestedRemotePort: TABLET_PORT,
    expectedCommit: FIXTURE_COMMIT,
    request,
  })
  return { state, calls, probe }
}

function fatal(pattern) {
  return (error) => error instanceof SmokeFatalError && pattern.test(error.message)
}

test('readiness passes for a production instance that owns its tablet listener', async () => {
  const ready = await fakeInstance().probe()
  assert.deepEqual(ready, {
    mainPort: MAIN_PORT,
    tabletPort: TABLET_PORT,
    requestedMainPort: MAIN_PORT,
    instanceId: 'instance-1',
    pid: 4242,
    build: FIXTURE_COMMIT,
  })
  assert.equal(await checkReadiness({ control: null, requestedRemotePort: TABLET_PORT }), false)
})

test('mock mode, a configured key and a foreign build are fatal instead of a silent wait', async () => {
  const mock = fakeInstance()
  mock.state.status.mockMode = true
  await assert.rejects(mock.probe, fatal(/mock \(demo\) mode/u))

  const keyed = fakeInstance()
  keyed.state.status.falConfigured = true
  await assert.rejects(keyed.probe, fatal(/configured fal\.ai key/u))

  const foreign = fakeInstance()
  foreign.state.status.build = { commit: 'ffffffffffff' }
  await assert.rejects(foreign.probe, fatal(/reports build ffffffffffff, but build-info\.json of the package says 0123456789ab/u))

  const stale = fakeInstance()
  stale.state.status.instanceId = 'previous-instance'
  assert.equal(await stale.probe(), false)
})

test('a tablet listener that failed to bind fails fast with the server reason', async () => {
  const blocked = fakeInstance()
  blocked.state.access.server = { running: false, lan: false, port: TABLET_PORT, error: `Порт ${TABLET_PORT} занят другой программой` }
  const started = Date.now()
  await assert.rejects(
    () => waitFor('desktop and tablet HTTP readiness', blocked.probe, 20_000),
    fatal(new RegExp(`tablet listener could not bind port ${TABLET_PORT}: Порт ${TABLET_PORT} занят`, 'u')),
  )
  assert.ok(Date.now() - started < 5_000, 'the bind failure must not wait for the cycle timeout')
  assert.ok(!blocked.calls.some((call) => call.startsWith(`${TABLET_PORT}/`)), 'the tablet port is not polled after a bind failure')

  const starting = fakeInstance()
  starting.state.access.server = { running: false, lan: false, port: TABLET_PORT, error: null }
  assert.equal(await starting.probe(), false)

  const moved = fakeInstance()
  moved.state.access.server.port = 8789
  await assert.rejects(moved.probe, fatal(/uses port 8789, but the smoke requested 21002/u))

  const silent = fakeInstance({ access: null })
  await assert.rejects(silent.probe, fatal(/no \/api\/remote-access/u))
})

async function listen(t, handler) {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const send = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(body))
      }
      handler({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null }, send)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  }))
  return server.address().port
}

async function tabletPair(t, { tabletInstance = 'instance-1', knowsHealth = true, lan = false, loginAccepted = false, sessionAuthorized = false } = {}) {
  const seen = { pin: null, device: null }
  const mainPort = await listen(t, (req, send) => {
    if (req.method === 'GET' && req.url === '/api/remote-access') {
      return send(200, { enabled: lan, server: { lan } })
    }
    send(404, { error: 'not found' })
  })
  const tabletPort = await listen(t, (req, send) => {
    if (knowsHealth && req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, instanceId: tabletInstance })
    }
    if (req.method === 'POST' && req.url === '/api/remote/login') {
      seen.device = req.body.device
      return loginAccepted
        ? send(200, { ok: true }, { 'set-cookie': 'canai_remote=session-token; Path=/; HttpOnly; SameSite=Strict' })
        : send(401, { error: 'Tablet access is turned off' })
    }
    if (req.method === 'GET' && req.url === '/api/remote/session') {
      return send(200, { authorized: sessionAuthorized, csrf: sessionAuthorized ? 'test-csrf' : null })
    }
    send(404, { error: 'not found' })
  })
  return { mainPort, tabletPort, seen }
}

test('the tablet port is tied to the instance while LAN access and login remain disabled', async (t) => {
  const own = await tabletPair(t)
  assert.equal(await confirmTabletInstance({ ...own, instanceId: 'instance-1' }), true)
  assert.equal(own.seen.pin, null, 'closed smoke must not create credentials')
  assert.equal(own.seen.device, 'smoke-distribution')

  const other = await tabletPair(t, { tabletInstance: 'instance-2' })
  await assert.rejects(
    () => confirmTabletInstance({ ...other, instanceId: 'instance-1' }),
    fatal(/served by another instance \(instance-2\), expected instance-1/u),
  )

  // A foreign HTTP server on the tablet port is retried, then reported.
  const foreign = await tabletPair(t, { knowsHealth: false })
  await assert.rejects(
    () => confirmTabletInstance({ ...foreign, instanceId: 'instance-1' }),
    (error) => !(error instanceof SmokeFatalError) && /tablet health check returned HTTP 404/u.test(error.message),
  )

  for (const [options, message] of [
    [{ lan: true }, /LAN access is enabled/u],
    [{ loginAccepted: true }, /must reject login/u],
    [{ sessionAuthorized: true }, /still authorizes a session/u],
  ]) {
    const unsafe = await tabletPair(t, options)
    await assert.rejects(() => confirmTabletInstance({ ...unsafe, instanceId: 'instance-1' }), fatal(message))
  }
})

test('a shipped build is required: build-info.json the server accepts and no .git', async (t) => {
  const root = await buyerFixture(t)
  const options = { platform: 'windows', installed: false }
  assert.deepEqual(await readPackageBuild(root), { commit: FIXTURE_COMMIT, date: '2026-10-05T12:00:00+03:00' })

  const buildFile = path.join(root, 'build-info.json')
  const shipped = await fs.readFile(buildFile, 'utf8')
  await fs.rm(buildFile)
  await assert.rejects(() => assertBuyerPackageShape(root, options), /build-info\.json .* is missing or empty/u)
  await fs.writeFile(buildFile, '{"commit":"fixture"}')
  await assert.rejects(() => assertBuyerPackageShape(root, options), /no commit the server accepts/u)
  await fs.writeFile(buildFile, '{commit')
  await assert.rejects(() => assertBuyerPackageShape(root, options), /build-info\.json is not valid JSON/u)
  await fs.writeFile(buildFile, shipped)
  await assertBuyerPackageShape(root, options)

  // A worktree keeps .git as a file, a clone as a directory: both are a working copy.
  await fs.writeFile(path.join(root, '.git'), 'gitdir: elsewhere')
  await assert.rejects(() => assertBuyerPackageShape(root, options), /contains \.git/u)
  await fs.rm(path.join(root, '.git'))
  await fs.mkdir(path.join(root, '.git'))
  await assert.rejects(() => assertBuyerPackageShape(root, { platform: 'macos', installed: false }), /contains \.git/u)
})

test('agent schemas are required as soon as the package server reads them', async (t) => {
  const root = await buyerFixture(t)
  const options = { platform: 'windows', installed: false }
  await fs.mkdir(path.join(root, 'server', 'src', 'agents'), { recursive: true })
  await fs.mkdir(path.join(root, 'docs', 'agents'), { recursive: true })
  await assertBuyerPackageShape(root, options)

  await fs.writeFile(path.join(root, 'server', 'src', 'agents', 'validation.ts'), '// reads docs/agents')
  await assert.rejects(() => assertBuyerPackageShape(root, options), /agent schema docs\/agents\/protocol\.schema\.json is missing/u)
  await fs.writeFile(path.join(root, 'docs', 'agents', 'protocol.schema.json'), '{"$id":"urn:test:protocol"}')
  await assert.rejects(() => assertBuyerPackageShape(root, options), /agent schema docs\/agents\/canai\.agent\.schema\.json is missing/u)
  await fs.writeFile(path.join(root, 'docs', 'agents', 'canai.agent.schema.json'), '{"$id"')
  await assert.rejects(() => assertBuyerPackageShape(root, options), /canai\.agent\.schema\.json is not valid JSON/u)
  await fs.writeFile(path.join(root, 'docs', 'agents', 'canai.agent.schema.json'), '{"$id":"urn:test:manifest"}')
  await assertBuyerPackageShape(root, options)
})

test('the schema list follows what the server validation module reads', async () => {
  const source = await fs.readFile(path.join(REPO_ROOT, 'server', 'src', 'agents', 'validation.ts'), 'utf8')
  const read = new Set([...source.matchAll(/['"`]([\w.-]+\.schema\.json)['"`]/gu)].map((match) => match[1]))
  assert.deepEqual([...read].sort(), [...RUNTIME_AGENT_SCHEMAS].sort())
})

test('a start that installs build dependencies or rewrites the shipped pages is a rebuild', async (t) => {
  const root = await buyerFixture(t)
  const before = await snapshotInterface(root)
  await assert.rejects(() => assertInterfaceNotRebuilt(root, before), /server\/node_modules after start is missing/u)
  await fs.mkdir(path.join(root, 'server', 'node_modules'))
  await assertInterfaceNotRebuilt(root, before)

  await fs.mkdir(path.join(root, 'client', 'node_modules'))
  await assert.rejects(() => assertInterfaceNotRebuilt(root, before), /build-only dependencies \(client\/node_modules\)/u)
  await fs.rm(path.join(root, 'client', 'node_modules'), { recursive: true })
  await fs.mkdir(path.join(root, 'node_modules'))
  await assert.rejects(() => assertInterfaceNotRebuilt(root, before), /build-only dependencies \(node_modules\)/u)

  // Dependencies that were there before the start (--installed) are not the launcher's doing.
  await assertInterfaceNotRebuilt(root, await snapshotInterface(root))
  await fs.rm(path.join(root, 'node_modules'), { recursive: true })

  // Same bytes written again: a rebuild is caught by the file time alone.
  const tablet = path.join(root, 'client', 'dist', 'tablet', 'tablet.html')
  const later = new Date(Date.now() + 60_000)
  await fs.utimes(tablet, later, later)
  await assert.rejects(() => assertInterfaceNotRebuilt(root, before), /rewrote client\/dist\/tablet\/tablet\.html/u)
  await fs.rm(path.join(root, 'client', 'dist', 'index.html'))
  await assert.rejects(() => assertInterfaceNotRebuilt(root, before), /rewrote client\/dist\/index\.html/u)
})

test('the Node that ran the server is read from the server and classified by the launcher rule', async (t) => {
  const root = await buyerFixture(t)
  const requests = []
  const request = async (url, options) => {
    requests.push({ url, ...options })
    return {
      response: { status: 200, ok: true, headers: new Headers() },
      body: JSON.stringify({ report: { server: { info: { node: 'v25.2.1' } } } }),
    }
  }
  assert.deepEqual(
    await readServerNode({ mainPort: MAIN_PORT, packageDir: root, platform: 'windows', request }),
    { version: 'v25.2.1', origin: 'system' },
  )
  assert.equal(requests[0].url, `http://127.0.0.1:${MAIN_PORT}/api/diagnostics/report`)
  assert.equal(requests[0].method, 'POST')
  assert.equal(JSON.parse(requests[0].body).mode, 'bundle', 'the report is only assembled, never sent')

  await fs.mkdir(path.join(root, 'runtime', 'node', 'bin'), { recursive: true })
  await fs.writeFile(path.join(root, 'runtime', 'node', 'node.exe'), 'binary')
  await fs.writeFile(path.join(root, 'runtime', 'node', 'bin', 'node'), 'binary')
  assert.equal((await readServerNode({ mainPort: MAIN_PORT, packageDir: root, platform: 'windows', request })).origin, 'bundled')
  assert.equal((await readServerNode({ mainPort: MAIN_PORT, packageDir: root, platform: 'macos', request })).origin, 'bundled')

  const unknown = async () => { throw new Error('connection refused') }
  assert.deepEqual(
    await readServerNode({ mainPort: MAIN_PORT, packageDir: root, platform: 'windows', request: unknown }),
    { version: null, origin: 'bundled' },
  )
})

test('both launchers name the pinned Node in a form the smoke can read', async () => {
  for (const launcher of ['start.ps1', 'start.command']) {
    assert.match(await readPinnedNode(path.join(REPO_ROOT, launcher)) ?? '', /^v\d+\.\d+\.\d+$/u, launcher)
  }
  assert.equal(await readPinnedNode(path.join(REPO_ROOT, 'no-such-launcher')), null)
})

test('the PASS line says what was proven and what was not', () => {
  const base = {
    ports: { mainPort: 24_304, tabletPort: 24_306 },
    build: { commit: FIXTURE_COMMIT },
    agentSchemas: true,
    cycles: 2,
  }
  const system = { version: 'v25.2.1', origin: 'system', pinned: 'v22.23.1' }
  const clean = formatPassLine({ ...base, mode: 'clean', node: system })
  assert.match(clean, /^\[smoke\] PASS: release package restarted cleanly on main\/tablet ports 24304\/24306 \| proven: /u)
  const [, proven, notProven] = clean.split(' | ')
  assert.match(proven, /shipped build 0123456789ab/u)
  assert.match(proven, /first-run install of server dependencies only/u)
  assert.match(proven, /interface not rebuilt/u)
  assert.match(proven, /same instanceId through health; LAN off; login denied/u)
  assert.match(proven, /agent schemas present/u)
  assert.doesNotMatch(proven, /Node/u)
  assert.match(notProven, /^NOT proven: pinned Node v22\.23\.1 download \(the server ran on system Node v25\.2\.1\)/u)
  assert.match(notProven, /registry availability/u)
  assert.equal(clean.includes('\n'), false)

  const bundled = { version: 'v22.23.1', origin: 'bundled', pinned: 'v22.23.1' }
  const installed = formatPassLine({ ...base, mode: 'installed', node: bundled, agentSchemas: false })
  const [, provenInstalled, notProvenInstalled] = installed.split(' | ')
  assert.match(provenInstalled, /portable Node v22\.23\.1 from runtime\/node/u)
  assert.match(provenInstalled, /start on preinstalled server dependencies/u)
  assert.doesNotMatch(provenInstalled, /agent schemas/u)
  assert.match(notProvenInstalled, /clean first install \(--installed\)/u)
  assert.doesNotMatch(notProvenInstalled, /pinned Node/u)

  assert.equal(
    describeNode(system),
    'v25.2.1 (system Node from PATH; the pinned v22.23.1 download was not exercised)',
  )
  assert.match(describeNode({ version: null, origin: 'system', pinned: null }), /^unknown version \(system Node/u)
  assert.match(describeNode(bundled), /^v22\.23\.1 \(portable Node in runtime\/node/u)
})

test('orphan cleanup uses the private control port after launcher parent exit', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-orphan-control-'))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const controlPath = path.join(dataDir, 'runtime-control.json')
  await fs.writeFile(controlPath, JSON.stringify({
    version: 1,
    port: 19101,
    pid: 4242,
    instanceId: 'orphan-instance',
    shutdownToken: 'private-token',
  }))

  let stopCalled = false
  let closedPorts
  let clearedControl
  await stopOrphan(
    { children: new Set() },
    { packageDir: 'buyer', platform: 'windows' },
    { CANAI_REMOTE_PORT: '19103' },
    dataDir,
    1000,
    {
      runStop: async () => { stopCalled = true },
      waitPorts: async (ports) => { closedPorts = ports },
      waitControl: async (control) => { clearedControl = control },
    },
  )
  assert.equal(stopCalled, true)
  assert.deepEqual(closedPorts, { mainPort: 19101, tabletPort: 19103 })
  assert.equal(clearedControl, controlPath)
})

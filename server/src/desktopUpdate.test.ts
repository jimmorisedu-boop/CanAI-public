import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyUpdate } from './desktopUpdateHelper.mjs'
import { createDesktopUpdateService, extractSafeZip, validateReleaseManifest } from './desktopUpdate.js'
import { desktopUpdatePolicy, type DesktopUpdatePolicy } from './desktopUpdatePolicy.js'
import { isAllowedRemoteApi } from './remoteAllowlist.js'

// The public/local export replaces desktopUpdatePolicy.ts with a release
// policy, while this test file is retained for both editions.  Keep the
// full-edition fixtures explicit so they continue to exercise the private
// Git/ff-only path after export.
const fullUpdatePolicy: DesktopUpdatePolicy = {
  ...desktopUpdatePolicy,
  edition: 'full',
  source: { kind: 'git', owner: 'jimmorisedu-boop', repository: 'CanAI', branch: 'main' },
}

const GIT = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git'

function git(cwd: string, args: string[]): string {
  return execFileSync(GIT, args, { cwd, encoding: 'utf8' }).trim()
}

async function fixture(t: test.TestContext): Promise<string> {
  const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../artifacts/.tmp')
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(path.join(parent, 'desktop-update-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}))
  return root
}

function zipEntry(name: string, content: Buffer, offset: number, directory = false, symlink = false): Buffer {
  const nameBytes = Buffer.from(name)
  const data = directory ? Buffer.alloc(0) : content
  const local = Buffer.alloc(30 + nameBytes.length + data.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(0, 10)
  local.writeUInt32LE(0, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  local.writeUInt16LE(0, 28)
  nameBytes.copy(local, 30)
  data.copy(local, 30 + nameBytes.length)
  const central = Buffer.alloc(46 + nameBytes.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(symlink ? ((3 << 8) | 20) : 20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(0, 12)
  central.writeUInt32LE(0, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(symlink ? (0o120777 << 16) >>> 0 : 0, 38)
  central.writeUInt32LE(offset, 42)
  nameBytes.copy(central, 46)
  return Buffer.concat([local, central])
}

function zip(entries: Array<{ name: string; data?: string; directory?: boolean; symlink?: boolean }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const localAndCentral = zipEntry(entry.name, Buffer.from(entry.data ?? ''), offset, entry.directory, entry.symlink)
    const localLength = 30 + Buffer.byteLength(entry.name) + (entry.directory ? 0 : Buffer.byteLength(entry.data ?? ''))
    locals.push(localAndCentral.subarray(0, localLength))
    centrals.push(localAndCentral.subarray(localLength))
    offset += localLength
  }
  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, eocd])
}

test('desktop release manifest stays pinned to local verified assets', () => {
  const manifest = validateReleaseManifest({
    format: 'canai-desktop-update', schemaVersion: 1, edition: 'local', version: '1.2.3', commit: 'a'.repeat(40),
    platforms: [{ platform: 'win32', arch: 'x64', file: 'CanAI.zip', sha256: 'b'.repeat(64), size: 123 }],
  })
  assert.equal(manifest.platforms[0]?.file, 'CanAI.zip')
  assert.throws(() => validateReleaseManifest({ ...manifest, platforms: [{ ...manifest.platforms[0], file: '../escape.zip' }] }), /invalid|archive descriptor/u)
})

test('safe ZIP accepts directory records and rejects traversal', async (t) => {
  const root = await fixture(t)
  const extracted = path.join(root, 'good')
  const archive = zip([{ name: 'CanAI/', directory: true }, { name: 'CanAI/package.json', data: '{"version":"1.0.0"}' }])
  const packageRoot = await extractSafeZip(archive, extracted)
  assert.equal(packageRoot, path.join(extracted, 'CanAI'))
  await assert.rejects(() => extractSafeZip(zip([{ name: '../escape.txt', data: 'x' }]), path.join(root, 'bad')), /Unsafe archive path/u)
  await assert.rejects(() => extractSafeZip(zip([{ name: 'CanAI/link', data: 'target', symlink: true }]), path.join(root, 'symlink')), /Symlinks are not allowed/u)
})

test('isolated helper installs a local payload, proves HTTP readiness, and preserves protected files', async (t) => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'server', 'data'), { recursive: true })
  await fs.mkdir(path.join(root, 'runtime'), { recursive: true })
  await fs.writeFile(path.join(root, 'server', 'app.txt'), 'old')
  await fs.writeFile(path.join(root, '.env'), 'keep-secret')
  await fs.writeFile(path.join(root, 'server', 'data', 'sentinel'), 'keep-data')
  const stage = path.join(root, 'stage')
  await fs.mkdir(path.join(stage, 'server'), { recursive: true })
  await fs.writeFile(path.join(stage, 'server', 'app.txt'), 'new')
  const script = path.join(root, 'readiness-server.mjs')
  await fs.writeFile(script, "import http from 'node:http'; const s=http.createServer((req,res)=>{if(req.url==='/api/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({build:{commit:process.env.CANAI_COMMIT,version:'1.1.0'}}));}else{res.statusCode=404;res.end();}}); s.listen(Number(process.env.PORT),'127.0.0.1');")
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const address = probe.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const dataDir = path.join(root, 'server', 'data')
  const job = {
    rootDir: root, dataDir, stageRoot: stage, statePath: path.join(dataDir, 'desktop-update.json'),
    target: 'b'.repeat(40), edition: 'local', expectedCurrent: null, currentVersion: '1.0.0', currentDate: null,
    latest: { version: '1.1.0', commit: 'b'.repeat(40), date: null, notes: [], target: 'b'.repeat(40) }, oldPid: 0, port,
    platform: 'win32', arch: 'x64', managedPaths: ['server'], protectedPaths: ['.env', 'server/data', 'runtime'], launcher: { windows: 'start.ps1', macos: 'start.command' },
  }
  let child: ReturnType<typeof spawn> | null = null
  t.after(() => { child?.kill() })
  await applyUpdate(job, {
    waitForExit: async () => {},
    launch: async () => {
      child = spawn(process.execPath, [script], { env: { ...process.env, PORT: String(port), CANAI_COMMIT: job.latest.commit }, stdio: 'ignore', windowsHide: true })
      return child
    },
  })
  assert.equal(await fs.readFile(path.join(root, 'server', 'app.txt'), 'utf8'), 'new')
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'keep-secret')
  assert.equal(await fs.readFile(path.join(dataDir, 'sentinel'), 'utf8'), 'keep-data')
  const state = JSON.parse(await fs.readFile(job.statePath, 'utf8')) as { status?: { phase?: string } }
  assert.equal(state.status?.phase, 'complete')
})

test('helper follows a launcher fallback port and journals a reconnect URL', async (t) => {
  const root = await fixture(t)
  const dataDir = path.join(root, 'server', 'data')
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(path.join(root, 'server', 'app.txt'), 'old')
  const stage = path.join(root, 'stage')
  await fs.mkdir(path.join(stage, 'server'), { recursive: true })
  await fs.writeFile(path.join(stage, 'server', 'app.txt'), 'new')
  const requested = http.createServer()
  const fallback = http.createServer()
  await Promise.all([
    new Promise<void>((resolve) => requested.listen(0, '127.0.0.1', () => resolve())),
    new Promise<void>((resolve) => fallback.listen(0, '127.0.0.1', () => resolve())),
  ])
  const requestedAddress = requested.address()
  const fallbackAddress = fallback.address()
  assert.ok(requestedAddress && typeof requestedAddress !== 'string')
  assert.ok(fallbackAddress && typeof fallbackAddress !== 'string')
  const requestedPort = requestedAddress.port
  const fallbackPort = fallbackAddress.port
  assert.notEqual(requestedPort, fallbackPort)
  await Promise.all([
    new Promise<void>((resolve, reject) => requested.close((error) => error ? reject(error) : resolve())),
    new Promise<void>((resolve, reject) => fallback.close((error) => error ? reject(error) : resolve())),
  ])
  await fs.writeFile(path.join(dataDir, 'runtime-control.json'), JSON.stringify({ version: 1, pid: 999999, port: requestedPort, instanceId: 'old-instance', shutdownToken: 'old-token' }))
  const script = path.join(root, 'fallback-readiness-server.mjs')
  await fs.writeFile(script, "import http from 'node:http'; import fs from 'node:fs'; const port=Number(process.env.FALLBACK_PORT); const dir=process.env.CANAI_DATA_DIR; fs.writeFileSync(dir+'/runtime-control.json', JSON.stringify({version:1,pid:process.pid,port,instanceId:'new-instance',shutdownToken:'new-token'})); const s=http.createServer((req,res)=>{if(req.url==='/api/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({build:{commit:process.env.CANAI_COMMIT,version:'1.1.0'}}));}else{res.statusCode=404;res.end();}}); s.listen(port,'127.0.0.1');")
  const job = {
    rootDir: root, dataDir, stageRoot: stage, statePath: path.join(dataDir, 'desktop-update.json'),
    target: 'c'.repeat(40), edition: 'local', expectedCurrent: null, currentVersion: '1.0.0', currentDate: null,
    latest: { version: '1.1.0', commit: 'c'.repeat(40), date: null, notes: [], target: 'c'.repeat(40) }, oldPid: 0, port: requestedPort,
    platform: 'win32', arch: 'x64', managedPaths: ['server'], protectedPaths: ['.env', 'server/data', 'runtime'], launcher: { windows: 'start.ps1', macos: 'start.command' },
  }
  let child: ReturnType<typeof spawn> | null = null
  const opened: string[] = []
  t.after(() => { child?.kill() })
  await applyUpdate(job, {
    waitForExit: async () => {},
    launch: async () => {
      child = spawn(process.execPath, [script], { env: { ...process.env, CANAI_DATA_DIR: dataDir, FALLBACK_PORT: String(fallbackPort), CANAI_COMMIT: job.latest.commit }, stdio: 'ignore', windowsHide: true })
      return child
    },
    openBrowser: async (url: string) => { opened.push(url) },
  })
  const state = JSON.parse(await fs.readFile(job.statePath, 'utf8')) as { status?: { port?: number; restartUrl?: string } }
  assert.equal(state.status?.port, fallbackPort)
  assert.equal(state.status?.restartUrl, `http://127.0.0.1:${fallbackPort}`)
  assert.deepEqual(opened, [`http://127.0.0.1:${fallbackPort}`])
})

test('full edition helper performs a real ff-only update and retains protected files', async (t) => {
  const root = await fixture(t)
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.name', 'CanAI test'])
  git(root, ['config', 'user.email', 'test@canai.invalid'])
  await fs.mkdir(path.join(root, 'server', 'data'), { recursive: true })
  await fs.writeFile(path.join(root, 'server', 'app.txt'), 'v1')
  await fs.writeFile(path.join(root, '.env'), 'keep-secret')
  await fs.writeFile(path.join(root, 'server', 'data', 'sentinel'), 'keep-data')
  await fs.writeFile(path.join(root, '.gitignore'), '.env\nserver/data/\nbuild-info.json\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'v1'])
  const oldCommit = git(root, ['rev-parse', 'HEAD'])
  await fs.writeFile(path.join(root, 'server', 'app.txt'), 'v2')
  await fs.writeFile(path.join(root, 'server', 'new.txt'), 'new-file')
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'v2'])
  const newCommit = git(root, ['rev-parse', 'HEAD'])
  git(root, ['reset', '--hard', '-q', oldCommit])
  const dataDir = path.join(root, 'server', 'data')
  await fs.writeFile(path.join(root, 'build-info.json'), JSON.stringify({ commit: oldCommit, date: null }) + '\n')
  const job = {
    rootDir: root, dataDir, stageRoot: path.join(root, 'unused-stage'), statePath: path.join(dataDir, 'desktop-update.json'),
    target: newCommit, edition: 'full', expectedCurrent: oldCommit, currentVersion: '1.0.0', currentDate: null,
    latest: { version: '1.1.0', commit: newCommit, date: null, notes: [], target: newCommit }, oldPid: 0, port: 1,
    platform: 'win32', arch: 'x64', managedPaths: ['server', 'build-info.json'], protectedPaths: ['.env', 'server/data', 'runtime'], launcher: { windows: 'start.ps1', macos: 'start.command' },
  }
  await applyUpdate(job, { waitForExit: async () => {}, command: async (_file: string, args: string[], cwd: string) => git(cwd, args), launch: async () => {}, health: async () => ({}) })
  assert.equal(git(root, ['rev-parse', 'HEAD']), newCommit)
  assert.equal(await fs.readFile(path.join(root, 'server', 'app.txt'), 'utf8'), 'v2')
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'keep-secret')
  assert.equal(await fs.readFile(path.join(dataDir, 'sentinel'), 'utf8'), 'keep-data')
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'build-info.json'), 'utf8')).commit, newCommit)
})

test('apply journals the helper token before detached spawn and keeps its owner matched', async (t) => {
  const root = await fixture(t)
  const dataDir = path.join(root, 'server', 'data')
  await fs.mkdir(dataDir, { recursive: true })
  const oldCommit = '1'.repeat(40)
  const target = '2'.repeat(40)
  const statePath = path.join(dataDir, 'desktop-update.json')
  const job = {
    jobId: 'token-job', rootDir: root, dataDir, stageRoot: path.join(root, 'artifacts', '.tmp', 'desktop-update-token', 'payload'), statePath,
    target, edition: 'full', expectedCurrent: oldCommit, currentVersion: '1.0.0', currentDate: null,
    latest: { version: '1.1.0', commit: target, date: null, notes: [], target }, oldPid: 0, port: 8787,
    platform: 'win32', arch: 'x64', managedPaths: ['server'], protectedPaths: ['.env', 'server/data', 'runtime'], launcher: { windows: 'start.ps1', macos: 'start.command' },
    createdAt: '2025-01-01T00:00:00.000Z',
  }
  await fs.writeFile(statePath, `${JSON.stringify({ status: { phase: 'ready', edition: 'full', current: { version: '1.0.0', commit: oldCommit, date: null }, latest: job.latest, jobId: job.jobId }, job })}\n`)
  let serializedToken: unknown = null
  const fakeChild = { pid: process.pid, once() { return this }, unref() {} } as unknown as ReturnType<typeof spawn>
  const spawnProcess = ((_file: string, args: readonly string[]) => {
    const serialized = JSON.parse(readFileSync(String(args[1]), 'utf8')) as Record<string, unknown>
    serializedToken = serialized.helperToken
    writeFileSync(path.join(dataDir, 'desktop-update-helper.json'), `${JSON.stringify({ jobId: serialized.jobId, helperToken: serializedToken, pid: process.pid })}\n`)
    return fakeChild
  }) as unknown as typeof spawn
  const service = createDesktopUpdateService({
    rootDir: root, dataDir, policy: fullUpdatePolicy, platform: 'win32', arch: 'x64',
    current: () => ({ version: '1.0.0', commit: oldCommit, date: null }),
    now: () => Date.parse('2025-01-01T00:00:00.000Z'), spawnProcess,
  })
  service.attachRuntime({ port: job.port, requestShutdown: async () => {} })
  const result = await service.apply(job.jobId)
  assert.equal(result.phase, 'restarting')
  assert.equal(typeof serializedToken, 'string')
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'desktop-update-job.json'), 'utf8')) as Record<string, unknown>
  assert.equal(persisted.helperToken, serializedToken)
  assert.equal(persisted.helperPid, process.pid)
  const owner = JSON.parse(await fs.readFile(path.join(dataDir, 'desktop-update-helper.json'), 'utf8')) as Record<string, unknown>
  assert.equal(owner.helperToken, serializedToken)
  const status = await service.status()
  assert.equal(status.phase, 'restarting')
})

test('full ff-only rollback restores build-info and existing tracked files', async (t) => {
  const root = await fixture(t)
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.name', 'CanAI test'])
  git(root, ['config', 'user.email', 'test@canai.invalid'])
  await fs.mkdir(path.join(root, 'server', 'data'), { recursive: true })
  await fs.writeFile(path.join(root, 'server', 'app.txt'), 'old\n')
  await fs.writeFile(path.join(root, '.env'), 'keep-secret')
  await fs.writeFile(path.join(root, 'server', 'data', 'sentinel'), 'keep-data')
  await fs.writeFile(path.join(root, '.gitignore'), '.env\nserver/data/\nbuild-info.json\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'v1'])
  const oldCommit = git(root, ['rev-parse', 'HEAD'])
  await fs.writeFile(path.join(root, 'server', 'app.txt'), 'new\n')
  await fs.writeFile(path.join(root, 'server', 'added.txt'), 'new-file\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'v2'])
  const target = git(root, ['rev-parse', 'HEAD'])
  git(root, ['reset', '--hard', '-q', oldCommit])
  await fs.writeFile(path.join(root, 'build-info.json'), `${JSON.stringify({ commit: oldCommit, date: null })}\n`)
  const dataDir = path.join(root, 'server', 'data')
  const job = {
    jobId: 'rollback-build-info', rootDir: root, dataDir, stageRoot: path.join(root, 'unused-stage'), statePath: path.join(dataDir, 'desktop-update.json'),
    target, edition: 'full', expectedCurrent: oldCommit, currentVersion: '1.0.0', currentDate: null,
    latest: { version: '1.1.0', commit: target, date: null, notes: [], target }, oldPid: 0, port: 1,
    platform: 'win32', arch: 'x64', managedPaths: ['server', 'build-info.json'], protectedPaths: ['.env', 'server/data', 'runtime'], launcher: { windows: 'start.ps1', macos: 'start.command' },
  }
  let healthCalls = 0
  await assert.rejects(() => applyUpdate(job, {
    waitForExit: async () => {},
    command: async (_file: string, args: string[], cwd: string) => git(cwd, args),
    launch: async () => {},
    health: async () => {
      healthCalls += 1
      if (healthCalls === 1) throw new Error('new server failed readiness')
      return {}
    },
  }), /new server failed readiness/u)
  assert.equal(healthCalls, 2)
  assert.equal(git(root, ['rev-parse', 'HEAD']), oldCommit)
  assert.equal((await fs.readFile(path.join(root, 'server', 'app.txt'), 'utf8')).replace(/\r\n/gu, '\n'), 'old\n')
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'build-info.json'), 'utf8')).commit, oldCommit)
  await assert.rejects(() => fs.access(path.join(root, 'server', 'added.txt')))
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'keep-secret')
  assert.equal(await fs.readFile(path.join(dataDir, 'sentinel'), 'utf8'), 'keep-data')
})

test('full packaged ZIP bootstraps a filtered trusted Git checkout before ff-only update', async (t) => {
  const root = await fixture(t)
  const seed = path.join(root, 'seed')
  const remote = path.join(root, 'remote.git')
  const packaged = path.join(root, 'packaged')
  await fs.mkdir(seed, { recursive: true })
  await fs.mkdir(packaged, { recursive: true })
  git(seed, ['init', '-q', '-b', 'main'])
  git(seed, ['config', 'user.name', 'CanAI test'])
  git(seed, ['config', 'user.email', 'test@canai.invalid'])
  await fs.mkdir(path.join(seed, 'server'), { recursive: true })
  await fs.mkdir(path.join(seed, 'packages'), { recursive: true })
  await fs.mkdir(path.join(seed, 'scripts'), { recursive: true })
  await fs.writeFile(path.join(seed, 'package.json'), '{"version":"1.0.0"}\n')
  await fs.writeFile(path.join(seed, '.gitignore'), '.env\nserver/data/\nartifacts/\nbuild-info.json\ndist/\n')
  await fs.writeFile(path.join(seed, 'server', 'app.txt'), 'v1\n')
  await fs.writeFile(path.join(seed, 'server', '.env.example'), 'CANAI_KEY=\n')
  await fs.writeFile(path.join(seed, 'packages', 'protocol.txt'), 'v1\n')
  await fs.writeFile(path.join(seed, 'scripts', 'release.txt'), 'v1\n')
  await fs.writeFile(path.join(seed, 'THIRD-PARTY-LICENSES.txt'), 'tracked license inventory\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '-qm', 'v1'])
  const oldCommit = git(seed, ['rev-parse', 'HEAD'])
  await fs.writeFile(path.join(seed, 'package.json'), '{"version":"1.1.0"}\n')
  await fs.writeFile(path.join(seed, 'server', 'app.txt'), 'v2\n')
  await fs.writeFile(path.join(seed, 'scripts', 'release.txt'), 'v2\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '-qm', 'v2'])
  const target = git(seed, ['rev-parse', 'HEAD'])
  git(path.dirname(remote), ['init', '--bare', '-q', remote])
  git(seed, ['remote', 'add', 'origin', remote])
  git(seed, ['push', '-q', 'origin', 'main'])

  await fs.mkdir(path.join(packaged, 'server', 'data'), { recursive: true })
  await fs.mkdir(path.join(packaged, 'client', 'dist'), { recursive: true })
  await fs.writeFile(path.join(packaged, 'package.json'), '{"version":"1.0.0"}\n')
  await fs.writeFile(path.join(packaged, 'server', 'app.txt'), 'v1\n')
  await fs.writeFile(path.join(packaged, 'server', 'data', 'sentinel'), 'keep-data')
  await fs.writeFile(path.join(packaged, '.env'), 'keep-secret')
  await fs.writeFile(path.join(packaged, 'build-info.json'), JSON.stringify({ commit: oldCommit.slice(0, 12), date: new Date().toISOString() }))
  await fs.writeFile(path.join(packaged, 'client', 'dist', 'index.html'), '<!-- generated -->')
  await fs.writeFile(path.join(packaged, 'THIRD-PARTY-LICENSES.txt'), [
    'CanAI — third-party production dependency licenses',
    'Generated by scripts/generate-third-party.mjs from installed production packages.',
    'Do not edit this file manually.',
    '',
    'Packages: 1',
    '',
    '='.repeat(80),
    'PACKAGE: example@1.0.0',
    'DECLARED LICENSE: MIT',
    'SOURCE: https://example.invalid',
    '--- LICENSE ---',
    'MIT',
    '',
  ].join('\n'))

  let localPromisorFetch = false
  const localGit = async (args: readonly string[], cwd: string): Promise<string> => {
    const mapped = [...args]
    if (mapped[0] === 'fetch' && mapped.some((entry) => entry.includes('desktop-update-git-'))) {
      localPromisorFetch = true
      throw new Error('local promisor fetch is forbidden')
    }
    if (mapped[0] === 'fetch' || mapped[0] === 'push') {
      const originIndex = mapped.indexOf('origin')
      if (originIndex >= 0) mapped[originIndex] = remote
      const filterIndex = mapped.indexOf('--filter=blob:none')
      if (filterIndex >= 0) {
        mapped.splice(filterIndex, 1)
        // Model the config written by a real partial clone while keeping the
        // fixture's local bare remote compatible with older Git builds.
        const result = git(cwd, mapped)
        git(cwd, ['config', 'extensions.partialClone', 'origin'])
        git(cwd, ['config', 'remote.origin.promisor', 'true'])
        git(cwd, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
        return result
      }
    }
    if (mapped[0] === 'ls-remote') return `${target}\trefs/heads/main`
    return git(cwd, mapped)
  }
  const service = createDesktopUpdateService({
    rootDir: packaged,
    dataDir: path.join(packaged, 'server', 'data'),
    policy: fullUpdatePolicy,
    platform: 'win32',
    arch: 'x64',
    git: localGit,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  })
  const checked = await service.check()
  assert.equal(checked.phase, 'available')
  assert.equal(checked.latest?.target, target)
  assert.equal(await fs.stat(path.join(packaged, '.git')).then(() => true).catch(() => false), false)
  const ready = await service.prepare({ target })
  assert.equal(ready.phase, 'ready')
  assert.equal(localPromisorFetch, false)
  assert.equal(git(packaged, ['remote', 'get-url', 'origin']), 'https://github.com/jimmorisedu-boop/CanAI.git')
  assert.equal(git(packaged, ['config', '--get', 'extensions.partialClone']), 'origin')
  assert.equal(git(packaged, ['config', '--get', 'remote.origin.promisor']), 'true')
  assert.equal(git(packaged, ['config', '--get', 'remote.origin.partialclonefilter']), 'blob:none')
  assert.equal(git(packaged, ['rev-parse', '--verify', 'HEAD']), oldCommit)
  assert.equal(await fs.readFile(path.join(packaged, '.env'), 'utf8'), 'keep-secret')
  assert.equal(await fs.readFile(path.join(packaged, 'server', 'data', 'sentinel'), 'utf8'), 'keep-data')
  assert.equal((await fs.readFile(path.join(packaged, 'THIRD-PARTY-LICENSES.txt'), 'utf8')).replace(/\r\n/gu, '\n'), 'tracked license inventory\n')
  const overlayFiles = await fs.readdir(path.join(packaged, 'artifacts', '.tmp'))
  const overlay = overlayFiles.find((name) => name.startsWith('desktop-update-license-overlay-'))
  assert.ok(overlay)
  assert.match(await fs.readFile(path.join(packaged, 'artifacts', '.tmp', overlay!), 'utf8'), /^CanAI — third-party production dependency licenses/u)
  const job = JSON.parse(await fs.readFile(path.join(packaged, 'server', 'data', 'desktop-update-job.json'), 'utf8')) as Record<string, unknown>
  await applyUpdate(job, { waitForExit: async () => {}, command: async (_file: string, args: string[], cwd: string) => git(cwd, args), launch: async () => {}, health: async () => ({}) })
  assert.equal(git(packaged, ['rev-parse', 'HEAD']), target)
  assert.equal((await fs.readFile(path.join(packaged, 'server', 'app.txt'), 'utf8')).replace(/\r\n/gu, '\n'), 'v2\n')
  assert.equal((await fs.readFile(path.join(packaged, 'server', '.env.example'), 'utf8')).replace(/\r\n/gu, '\n'), 'CANAI_KEY=\n')
  assert.equal((await fs.readFile(path.join(packaged, 'scripts', 'release.txt'), 'utf8')).replace(/\r\n/gu, '\n'), 'v2\n')
})

test('full packaged bootstrap refuses edited source before creating Git metadata', async (t) => {
  const root = await fixture(t)
  const seed = path.join(root, 'seed')
  const remote = path.join(root, 'remote.git')
  const packaged = path.join(root, 'packaged')
  await fs.mkdir(seed, { recursive: true })
  await fs.mkdir(packaged, { recursive: true })
  git(seed, ['init', '-q', '-b', 'main'])
  git(seed, ['config', 'user.name', 'CanAI test'])
  git(seed, ['config', 'user.email', 'test@canai.invalid'])
  await fs.mkdir(path.join(seed, 'server'), { recursive: true })
  await fs.writeFile(path.join(seed, 'package.json'), '{"version":"1.0.0"}\n')
  await fs.writeFile(path.join(seed, '.gitignore'), '.env\nserver/data/\nartifacts/\nbuild-info.json\ndist/\n')
  await fs.writeFile(path.join(seed, 'server', 'app.txt'), 'trusted\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '-qm', 'v1'])
  const oldCommit = git(seed, ['rev-parse', 'HEAD'])
  await fs.writeFile(path.join(seed, 'server', 'app.txt'), 'new\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '-qm', 'v2'])
  const target = git(seed, ['rev-parse', 'HEAD'])
  git(path.dirname(remote), ['init', '--bare', '-q', remote])
  git(seed, ['remote', 'add', 'origin', remote])
  git(seed, ['push', '-q', 'origin', 'main'])
  await fs.mkdir(path.join(packaged, 'server'), { recursive: true })
  await fs.writeFile(path.join(packaged, 'package.json'), '{"version":"1.0.0"}\n')
  await fs.writeFile(path.join(packaged, 'server', 'app.txt'), 'tampered\n')
  await fs.writeFile(path.join(packaged, 'build-info.json'), JSON.stringify({ commit: oldCommit.slice(0, 12) }))
  const localGit = async (args: readonly string[], cwd: string): Promise<string> => {
    const mapped = [...args]
    if (mapped[0] === 'fetch') {
      const originIndex = mapped.indexOf('origin')
      if (originIndex >= 0) mapped[originIndex] = remote
      const filterIndex = mapped.indexOf('--filter=blob:none')
      if (filterIndex >= 0) mapped.splice(filterIndex, 1)
    }
    if (mapped[0] === 'ls-remote') return `${target}\trefs/heads/main`
    return git(cwd, mapped)
  }
  const service = createDesktopUpdateService({ rootDir: packaged, dataDir: path.join(packaged, 'server', 'data'), policy: fullUpdatePolicy, platform: 'win32', arch: 'x64', git: localGit })
  const checked = await service.check()
  assert.equal(checked.phase, 'available')
  const status = await service.prepare({ target })
  assert.equal(status.phase, 'error')
  assert.equal(status.code, 'packaged-source-changed')
  await assert.rejects(() => fs.stat(path.join(packaged, '.git')))
  assert.equal(await fs.readFile(path.join(packaged, 'server', 'app.txt'), 'utf8'), 'tampered\n')
})

test('full packaged update reports missing build-info without touching the ZIP root', async (t) => {
  const root = await fixture(t)
  const packaged = path.join(root, 'packaged')
  await fs.mkdir(packaged, { recursive: true })
  await fs.writeFile(path.join(packaged, 'package.json'), '{"version":"1.0.0"}\n')
  const service = createDesktopUpdateService({
    rootDir: packaged,
    dataDir: path.join(packaged, 'server', 'data'),
    policy: fullUpdatePolicy,
    platform: 'win32',
    arch: 'x64',
    current: () => ({ version: '1.0.0', commit: null, date: null }),
    git: async () => { throw new Error('network must not be touched') },
  })
  const status = await service.check()
  assert.equal(status.phase, 'error')
  assert.equal(status.code, 'missing-build-info')
  await assert.rejects(() => fs.stat(path.join(packaged, '.git')))
})

test('full edition rejects a release commit that changes a protected tracked path', async (t) => {
  const root = await fixture(t)
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.name', 'CanAI test'])
  git(root, ['config', 'user.email', 'test@canai.invalid'])
  await fs.mkdir(path.join(root, 'server', 'data'), { recursive: true })
  await fs.writeFile(path.join(root, 'server', 'data', 'tracked'), 'old')
  await fs.writeFile(path.join(root, 'server', 'app.txt'), 'v1')
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'v1'])
  const oldCommit = git(root, ['rev-parse', 'HEAD'])
  await fs.writeFile(path.join(root, 'server', 'data', 'tracked'), 'new')
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'bad protected update'])
  const newCommit = git(root, ['rev-parse', 'HEAD'])
  git(root, ['reset', '--hard', '-q', oldCommit])
  const dataDir = path.join(root, 'server', 'data')
  const job = {
    rootDir: root, dataDir, stageRoot: path.join(root, 'unused-stage'), statePath: path.join(dataDir, 'desktop-update.json'),
    target: newCommit, edition: 'full', expectedCurrent: oldCommit, currentVersion: '1.0.0', currentDate: null,
    latest: { version: '1.1.0', commit: newCommit, date: null, notes: [], target: newCommit }, oldPid: 0, port: 1,
    platform: 'win32', arch: 'x64', managedPaths: ['server'], protectedPaths: ['.env', 'server/data', 'runtime'], launcher: { windows: 'start.ps1', macos: 'start.command' },
  }
  await assert.rejects(() => applyUpdate(job, { waitForExit: async () => {}, command: async (_file: string, args: string[], cwd: string) => git(cwd, args), launch: async () => {}, health: async () => ({}) }), /protected path/u)
  assert.equal(git(root, ['rev-parse', 'HEAD']), oldCommit)
  assert.equal(await fs.readFile(path.join(dataDir, 'tracked'), 'utf8'), 'old')
})

test('failed rollback keeps its recovery backup and honest journal', async (t) => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'server', 'data'), { recursive: true })
  await fs.writeFile(path.join(root, 'server', 'app.txt'), 'old')
  const stage = path.join(root, 'stage')
  await fs.mkdir(path.join(stage, 'server'), { recursive: true })
  await fs.writeFile(path.join(stage, 'server', 'app.txt'), 'new')
  const dataDir = path.join(root, 'server', 'data')
  const job = {
    jobId: 'rollback-job', rootDir: root, dataDir, stageRoot: stage, statePath: path.join(dataDir, 'desktop-update.json'),
    target: 'b'.repeat(40), edition: 'local', expectedCurrent: null, currentVersion: '1.0.0', currentDate: null,
    latest: { version: '1.1.0', commit: 'b'.repeat(40), date: null, notes: [], target: 'b'.repeat(40) }, oldPid: 0, port: 1,
    platform: 'win32', arch: 'x64', managedPaths: ['server'], protectedPaths: ['server/data'], launcher: { windows: 'start.ps1', macos: 'start.command' },
  }
  await assert.rejects(() => applyUpdate(job, { waitForExit: async () => {}, launch: async () => {}, health: async () => { throw new Error('probe remains unavailable') } }))
  const state = JSON.parse(await fs.readFile(job.statePath, 'utf8')) as { status?: { code?: string; message?: string } }
  assert.equal(state.status?.code, 'rollback-failed')
  const match = state.status?.message?.match(/backup retained at (.+)$/u)
  assert.ok(match?.[1])
  await fs.access(match![1])
})

test('desktop update routes stay desktop-only for tablet requests', () => {
  assert.equal(isAllowedRemoteApi('GET', '/desktop-updates'), false)
  assert.equal(isAllowedRemoteApi('POST', '/desktop-updates/check'), false)
  assert.equal(isAllowedRemoteApi('POST', '/desktop-updates/prepare'), false)
  assert.equal(isAllowedRemoteApi('POST', '/desktop-updates/apply'), false)
})

test('service reconciles a dead restarting helper instead of polling forever', async (t) => {
  const root = await fixture(t)
  const dataDir = path.join(root, 'server', 'data')
  await fs.mkdir(dataDir, { recursive: true })
  const stageRoot = path.join(root, 'artifacts', '.tmp', 'desktop-update-interrupted', 'payload')
  const statePath = path.join(dataDir, 'desktop-update.json')
  const oldCommit = '1'.repeat(40)
  const target = '2'.repeat(40)
  const job = {
    jobId: 'interrupted-job', rootDir: root, dataDir, stageRoot, target, edition: 'full', expectedCurrent: oldCommit,
    currentVersion: '1.0.0', currentDate: null, latest: { version: '1.1.0', commit: target, date: null, notes: [], target },
    oldPid: 12345, helperToken: 'helper-token', helperPid: 0, helperStartedAt: '2000-01-01T00:00:00.000Z', port: 8787,
    platform: 'win32', arch: 'x64', managedPaths: ['server'], protectedPaths: ['.env', 'server/data', 'runtime'],
    launcher: { windows: 'start.ps1', macos: 'start.command' }, statePath, createdAt: '2000-01-01T00:00:00.000Z',
  }
  await fs.writeFile(statePath, `${JSON.stringify({ status: { phase: 'restarting', edition: 'full', current: { version: '1.0.0', commit: oldCommit, date: null }, latest: job.latest, jobId: job.jobId }, job })}\n`)
  const service = createDesktopUpdateService({ rootDir: root, dataDir, policy: fullUpdatePolicy, platform: 'win32', arch: 'x64', current: () => ({ version: '1.0.0', commit: oldCommit, date: null }), now: () => Date.parse('2025-01-01T00:00:00.000Z') })
  const status = await service.status()
  assert.equal(status.phase, 'error')
  assert.equal(status.code, 'update-interrupted')
  assert.equal(status.jobId, job.jobId)
  assert.match(status.message ?? '', /recovery journal were retained/u)
  const saved = JSON.parse(await fs.readFile(statePath, 'utf8')) as { status?: { phase?: string; code?: string } }
  assert.equal(saved.status?.phase, 'error')
  assert.equal(saved.status?.code, 'update-interrupted')
})

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createOnboardingRepository } from './onboarding.js'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function freePort(): Promise<number> {
  const reservation = net.createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('ОС не выдала тестовый порт')
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const gracefulExit = once(child, 'exit')
  child.kill('SIGTERM')
  const exited = await Promise.race([
    gracefulExit.then(() => true),
    sleep(2_000).then(() => false),
  ])
  if (exited || child.exitCode !== null || child.signalCode !== null) return
  const forcedExit = once(child, 'exit')
  child.kill('SIGKILL')
  await forcedExit
}

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-onboarding-'))
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return directory
}

test('new installation starts expanded and existing installation starts collapsed', async (t) => {
  const temp = await temporaryDirectory(t)
  const fresh = createOnboardingRepository({ file: path.join(temp, 'new.json'), now: () => 100 })
  const existing = createOnboardingRepository({ file: path.join(temp, 'existing.json'), now: () => 100 })

  assert.equal((await fresh.load(false)).view, 'expanded')
  assert.equal((await existing.load(true)).view, 'collapsed')
})

test('dismissed view persists without clearing progress and reset reopens onboarding', async (t) => {
  const temp = await temporaryDirectory(t)
  const api = createOnboardingRepository({ file: path.join(temp, 'dismissed.json'), now: () => 100 })

  await api.patch({ step: { id: 'first-generation', state: 'done' } }, false)
  const dismissed = await api.patch({ view: 'dismissed' }, false)

  assert.equal(dismissed.view, 'dismissed')
  assert.equal(dismissed.steps['first-generation'], 'done')
  assert.equal((await api.load(false)).view, 'dismissed')

  const reset = await api.patch({ reset: true }, false)
  assert.equal(reset.view, 'expanded')
  assert.equal(reset.steps['first-generation'], 'pending')
})

test('repeated and parallel step writes preserve every success', async (t) => {
  const temp = await temporaryDirectory(t)
  const api = createOnboardingRepository({ file: path.join(temp, 'parallel.json'), now: () => 100 })

  await Promise.all([
    api.patch({ step: { id: 'first-generation', state: 'done' } }, false),
    api.patch({ step: { id: 'reference-generation', state: 'done' } }, false),
    api.patch({ step: { id: 'first-generation', state: 'done' } }, false),
  ])

  const document = await api.load(false)
  assert.equal(document.steps['first-generation'], 'done')
  assert.equal(document.steps['reference-generation'], 'done')
})

test('a completed step cannot be overwritten as skipped', async (t) => {
  const temp = await temporaryDirectory(t)
  const api = createOnboardingRepository({ file: path.join(temp, 'done-terminal.json'), now: () => 100 })

  await api.patch({ step: { id: 'first-generation', state: 'done' } }, false)
  const repeated = await api.patch({ step: { id: 'first-generation', state: 'skipped' } }, false)

  assert.equal(repeated.steps['first-generation'], 'done')
})

test('a skipped step cannot be overwritten as completed', async (t) => {
  const temp = await temporaryDirectory(t)
  const api = createOnboardingRepository({ file: path.join(temp, 'skipped-terminal.json'), now: () => 100 })

  await api.patch({ step: { id: 'first-generation', state: 'skipped' } }, false)
  const repeated = await api.patch({ step: { id: 'first-generation', state: 'done' } }, false)

  assert.equal(repeated.steps['first-generation'], 'skipped')
})

test('concurrent terminal writes keep the first serialized state', async (t) => {
  const temp = await temporaryDirectory(t)
  const api = createOnboardingRepository({ file: path.join(temp, 'terminal-race.json'), now: () => 100 })

  const [first, second] = await Promise.all([
    api.patch({ step: { id: 'first-generation', state: 'done' } }, false),
    api.patch({ step: { id: 'first-generation', state: 'skipped' } }, false),
  ])

  assert.equal(first.steps['first-generation'], 'done')
  assert.equal(second.steps['first-generation'], 'done')
  assert.equal((await api.load(false)).steps['first-generation'], 'done')
})

test('done and skipped finish the checklist and reset affects onboarding only', async (t) => {
  const temp = await temporaryDirectory(t)
  const api = createOnboardingRepository({ file: path.join(temp, 'finish.json'), now: () => 100 })

  await api.patch({ step: { id: 'first-generation', state: 'done' } }, false)
  await api.patch({ step: { id: 'reference-generation', state: 'skipped' } }, false)
  await api.patch({ step: { id: 'recovery', state: 'done' } }, false)
  await api.patch({ step: { id: 'save-for-later', state: 'skipped' } }, false)
  const completed = await api.patch({ step: { id: 'export', state: 'done' } }, false)

  assert.equal(typeof completed.completedAt, 'number')
  assert.equal(completed.completedAt, 100)

  const reset = await api.patch({ reset: true }, false)
  assert.deepEqual(reset.steps, {
    'first-generation': 'pending',
    'reference-generation': 'pending',
    recovery: 'pending',
    'save-for-later': 'pending',
    export: 'pending',
  })
  assert.equal(reset.completedAt, null)
  assert.equal(reset.view, 'expanded')
})

test('a corrupt onboarding file fails repeatedly and is not overwritten', async (t) => {
  const temp = await temporaryDirectory(t)
  const file = path.join(temp, 'corrupt.json')
  const invalid = '{invalid json'
  await fs.writeFile(file, invalid, 'utf8')
  const api = createOnboardingRepository({ file, now: () => 100 })

  await assert.rejects(() => api.load(false))
  await assert.rejects(() => api.load(false))
  await assert.rejects(() => api.patch({ view: 'compact' }, false))
  assert.equal(await fs.readFile(file, 'utf8'), invalid)
})

test('invalid patches are rejected before they change storage', async (t) => {
  const temp = await temporaryDirectory(t)
  const file = path.join(temp, 'invalid-patch.json')
  const api = createOnboardingRepository({ file, now: () => 100 })

  await assert.rejects(() => api.patch({ reset: true, view: 'collapsed' }, false), TypeError)
  await assert.rejects(() => fs.access(file))
})

async function startServer(t: test.TestContext, dataDir: string): Promise<string> {
  const port = await freePort()
  const sharePort = await freePort()
  const remotePort = await freePort()
  const base = `http://127.0.0.1:${port}`
  const tsxCli = path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const child: ChildProcess = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(port),
      CANAI_SHARE_PORT: String(sharePort),
      CANAI_REMOTE_PORT: String(remotePort),
      CANAI_DATA_DIR: dataDir,
      CANAI_MOCK: '1',
    },
    stdio: 'ignore',
  })
  t.after(async () => {
    await stopChild(child)
  })

  // Полный Windows-прогон параллельно грузит два Vite/tsx-графа и нативные
  // secure-storage bindings; 10 секунд давали ложный отказ на здоровом старте.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) return base
    } catch {}
    await sleep(100)
  }
  throw new Error('Сервер не запустился вовремя')
}

test('startup collapses legacy installation and expands a genuinely empty installation', async (t) => {
  const legacyDir = await temporaryDirectory(t)
  const emptyDir = await temporaryDirectory(t)
  await fs.writeFile(
    path.join(legacyDir, 'project.json'),
    JSON.stringify({ version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }),
  )

  const legacy = await startServer(t, legacyDir)
  const empty = await startServer(t, emptyDir)
  const legacyOnboarding = await fetch(`${legacy}/api/onboarding`).then((response) => response.json()) as {
    onboarding: { view: string }
  }
  const emptyOnboarding = await fetch(`${empty}/api/onboarding`).then((response) => response.json()) as {
    onboarding: { view: string }
  }

  assert.equal(legacyOnboarding.onboarding.view, 'collapsed')
  assert.equal(emptyOnboarding.onboarding.view, 'expanded')
})

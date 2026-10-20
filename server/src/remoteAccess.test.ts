import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-remote-access-'))
const previousDataDir = process.env.CANAI_DATA_DIR
const previousEnvFile = process.env.CANAI_ENV_FILE
process.env.CANAI_DATA_DIR = dataDir
process.env.CANAI_ENV_FILE = path.join(dataDir, '.env')

const {
  remoteLogin,
  remoteSession,
  resetRemoteAccessCache,
  setRemoteEnabled,
  setRemotePin,
} = await import('./remoteAccess.js')
const { createRemoteApp } = await import('./remoteApp.js')
const { attachLifecycle } = await import('./routes.js')
const { LifecycleManager } = await import('./lifecycle.js')

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('test server did not expose a port'))
      resolve(address.port)
    })
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function login(base: string, device: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${base}/api/remote/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '4821', device }),
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { csrf: string }
  const setCookie = response.headers.get('set-cookie')
  const cookie = setCookie?.split(';', 1)[0]
  if (!cookie) throw new Error('remote login did not return a cookie')
  return { cookie, csrf: body.csrf }
}

test('remote logout revokes one device, disabling access revokes all, and TTL still expires', async (t) => {
  const lifecycle = new LifecycleManager(path.join(dataDir, 'runtime-control.json'), 0)
  attachLifecycle(lifecycle, async () => {})
  resetRemoteAccessCache()
  await setRemotePin('4821')
  await setRemoteEnabled(true)
  const server = http.createServer(createRemoteApp())
  const port = await listen(server)
  t.after(async () => {
    await close(server)
    if (previousDataDir === undefined) delete process.env.CANAI_DATA_DIR
    else process.env.CANAI_DATA_DIR = previousDataDir
    if (previousEnvFile === undefined) delete process.env.CANAI_ENV_FILE
    else process.env.CANAI_ENV_FILE = previousEnvFile
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  })
  const base = `http://127.0.0.1:${port}`
  const health = await fetch(`${base}/health`)
  assert.deepEqual(await health.json(), { ok: true, instanceId: lifecycle.instanceId }, 'health exposes identity without lifecycle credentials')
  const first = await login(base, 'first-device')
  const second = await login(base, 'second-device')

  const logout = await fetch(`${base}/api/remote/logout`, {
    method: 'POST',
    headers: { cookie: first.cookie },
  })
  assert.equal(logout.status, 200)
  const firstAfterLogout = await fetch(`${base}/api/remote/session`, { headers: { cookie: first.cookie } })
  const secondAfterLogout = await fetch(`${base}/api/remote/session`, { headers: { cookie: second.cookie } })
  assert.equal((await firstAfterLogout.json() as { authorized: boolean }).authorized, false)
  assert.equal((await secondAfterLogout.json() as { authorized: boolean }).authorized, true)

  await setRemoteEnabled(false)
  const disabled = await fetch(`${base}/api/remote/session`, { headers: { cookie: second.cookie } })
  assert.equal((await disabled.json() as { authorized: boolean }).authorized, false)
  await assert.rejects(remoteLogin('4821', 'disabled-device', 'disabled-client'), /turned off/u)

  await setRemoteEnabled(true)
  const afterReenable = await fetch(`${base}/api/remote/session`, { headers: { cookie: second.cookie } })
  assert.equal((await afterReenable.json() as { authorized: boolean }).authorized, false)

  const now = Date.now()
  const ttl = await remoteLogin('4821', 'ttl-device', 'ttl-client', now)
  assert.ok(await remoteSession(ttl.session.token, now))
  assert.equal(await remoteSession(ttl.session.token, now + 30 * 24 * 60 * 60 * 1000 + 1), null)
})

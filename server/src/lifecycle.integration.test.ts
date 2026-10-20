import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function reserveFreeMainWithOccupiedGuest(): Promise<{ mainPort: number; guestPort: number; blocker: net.Server }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const mainPort = 20_000 + ((process.pid * 97 + attempt * 2) % 9_998)
    const mainReservation = net.createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        mainReservation.once('error', reject)
        mainReservation.listen(mainPort, '127.0.0.1', resolve)
      })
    } catch {
      continue
    }
    const guestPort = mainPort + 1

    const blocker = net.createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(guestPort, '127.0.0.1', resolve)
      })
    } catch {
      await new Promise<void>((resolve) => mainReservation.close(() => resolve()))
      continue
    }
    await new Promise<void>((resolve, reject) => mainReservation.close((error) => error ? reject(error) : resolve()))
    return { mainPort, guestPort, blocker }
  }
  throw new Error('не удалось зарезервировать соседние main/guest порты')
}

async function waitForStatus(base: string, timeoutMs = 20_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/status`)
      if (response.ok) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(100)
  }
  throw lastError instanceof Error ? lastError : new Error('сервер не поднялся')
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('сервер не завершился вовремя')), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
}

test('lifecycle скрывает токен, отклоняет чужой shutdown и штатно завершает сервер', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-lifecycle-api-'))
  const { mainPort: port, guestPort, blocker: guestReservation } = await reserveFreeMainWithOccupiedGuest()
  await new Promise<void>((resolve, reject) => guestReservation.close((error) => error ? reject(error) : resolve()))
  const base = `http://127.0.0.1:${port}`
  const tsxCli = path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(port),
      CANAI_SHARE_PORT: String(guestPort),
      CANAI_DATA_DIR: dataDir,
      CANAI_ENV_FILE: path.join(dataDir, 'missing.env'),
      CANAI_MOCK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await sleep(200)
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  })

  let statusResponse: Response
  try {
    statusResponse = await waitForStatus(base)
  } catch (error) {
    throw new Error(`не дождались /api/status: ${error instanceof Error ? error.message : error}\n${stderr}`)
  }

  const status = (await statusResponse.json()) as Record<string, unknown>
  assert.equal(status.mockMode, true)
  assert.equal(typeof status.instanceId, 'string')
  assert.equal(status.shuttingDown, false)
  assert.equal('shutdownToken' in status, false)
  assert.equal('pid' in status, false)

  const controlPath = path.join(dataDir, 'runtime-control.json')
  // HTTP начинает отвечать после bind, а control-файл публикуется следующим
  // асинхронным шагом. Дожидаемся обоих сигналов готовности, даже под нагрузкой.
  const controlDeadline = Date.now() + 5_000
  while (true) {
    try { await fs.access(controlPath); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= controlDeadline) throw error
      await sleep(25)
    }
  }
  const control = JSON.parse(await fs.readFile(controlPath, 'utf8')) as {
    instanceId: string
    shutdownToken: string
  }
  assert.equal(control.instanceId, status.instanceId)

  const missingToken = await fetch(`${base}/api/lifecycle/shutdown`, { method: 'POST' })
  assert.equal(missingToken.status, 403)
  assert.equal((await fetch(`${base}/api/status`)).status, 200)

  const generated = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'text', prompt: 'lifecycle persistence check', refs: [], model: 'qwen' }),
  })
  assert.equal(generated.status, 200)

  const accepted = await fetch(`${base}/api/lifecycle/shutdown`, {
    method: 'POST',
    headers: { 'x-canai-shutdown-token': control.shutdownToken },
  })
  assert.equal(accepted.status, 202)
  assert.deepEqual(await accepted.json(), { shuttingDown: true })
  assert.equal(await waitForExit(child), 0, stderr)
  await assert.rejects(fs.access(controlPath))

  const jobs = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8')) as {
    version: number
    jobs: unknown[]
  }
  assert.equal(jobs.version, 1)
  assert.ok(jobs.jobs.length >= 1)
})

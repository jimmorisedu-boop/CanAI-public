import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Условие теста не наступило вовремя')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('активная mock-job удерживает shutdown до durable завершения', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-runner-shutdown-'))
  t.after(() => fs.rm(dataDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  }).catch(() => {}))
  process.env.CANAI_DATA_DIR = dataDir
  process.env.CANAI_ENV_FILE = path.join(dataDir, 'missing.env')
  process.env.CANAI_MOCK = '1'

  const [{ generationGate }, { jobs }, { runJob }] = await Promise.all([
    import('./generationGate.js'),
    import('./jobs.js'),
    import('./runner.js'),
  ])
  const job = jobs.create('text', 'Проверить безопасный mock shutdown', [], 'gemini', {})
  const running = runJob(job)
  await waitUntil(() => job.progressText?.startsWith('mock-mode') === true)

  let shutdownFinished = false
  const shutdown = generationGate.closeAndWait().then(() => {
    shutdownFinished = true
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(shutdownFinished, false)

  await running
  await shutdown
  assert.equal(shutdownFinished, true)
  assert.equal(job.status, 'done')

  const stored = JSON.parse(
    await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'),
  ) as { jobs: Array<{ id: string; status: string }> }
  assert.equal(stored.jobs.find((item) => item.id === job.id)?.status, 'done')
})

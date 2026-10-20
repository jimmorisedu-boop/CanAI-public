import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import test from 'node:test'
import { generationGate } from './generationGate.js'
import { LifecycleManager } from './lifecycle.js'
import { apiRouter, attachLifecycle } from './routes.js'

test('shutdown единообразно закрывает canvas и prompt-chat admission', async (t) => {
  const lifecycle = new LifecycleManager('unused', 0)
  attachLifecycle(lifecycle, async () => {})
  const app = express()
  app.use(express.json())
  app.use('/api', apiRouter)
  const server = http.createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`

  const shutdown = await fetch(`${base}/api/lifecycle/shutdown`, {
    method: 'POST',
    headers: { 'x-canai-shutdown-token': lifecycle.shutdownToken },
  })
  assert.equal(shutdown.status, 202)
  assert.equal(generationGate.shuttingDown, true)

  const canvas = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'image', prompt: 'test' }),
  })
  assert.equal(canvas.status, 503)
  assert.match(((await canvas.json()) as { error: string }).error, /shutting down/i)

  for (const endpoint of [
    '/api/prompt-chats/chat/messages',
    '/api/prompt-chats/chat/context/rebuild',
  ]) {
    const response = await fetch(`${base}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 503)
    assert.match(((await response.json()) as { error: string }).error, /shutting down/i)
  }
})

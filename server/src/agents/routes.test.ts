import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import express from 'express'
import type { AgentHost } from './host.js'
import { AgentPackageError } from './package-errors.js'
import type { AgentPackageManager } from './package-manager.js'
import { createAgentRouter } from './routes.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

test('local generation catalog route exposes only Host-owned ready media metadata', async (t) => {
  const host = {
    generationCatalog: () => ({
      revision: 12,
      connection: { id: 'local-fal', kind: 'generation', status: 'ready' },
      models: [{ id: 'image-a', name: 'Image A', kind: 'image', endpoint: 'fake/image-a', params: [], refs: false }],
    }),
  } as unknown as AgentHost
  const app = express()
  app.use('/api', createAgentRouter(host, {} as never))
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/agents/generation/catalog`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    revision: 12,
    connection: { id: 'local-fal', kind: 'generation', status: 'ready' },
    models: [{ id: 'image-a', name: 'Image A', kind: 'image', endpoint: 'fake/image-a', params: [], refs: false }],
  })
})

test('local generation capture route forwards only board item identities to Host', async (t) => {
  let received: unknown
  const host = {
    captureGenerationInputs: async (input: unknown) => {
      received = input
      return [{
        itemId: 'item-a',
        artifact: {
          artifactId: 'agent-ref-a', revision: 1, checksum: 'a'.repeat(64), kind: 'image',
          caption: 'Native', mimeType: 'image/png', sizeBytes: 1,
          mediaSrc: '/media/agent-ref-a.png', provenance: 'reference',
        },
      }]
    },
  } as unknown as AgentHost
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentRouter(host, {} as never))
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/agents/generation/capture`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectRef: { source: 'local', id: 'board-1' }, projectRevision: 7, inputs: [{ itemId: 'item-a', kind: 'image', checksum: 'not-authority' }] }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(received, { projectRef: { source: 'local', id: 'board-1' }, projectRevision: 7, inputs: [{ itemId: 'item-a', kind: 'image' }] })
  assert.equal((await response.json()).receipts[0].artifact.checksum, 'a'.repeat(64))
})

test('agent events subscribes before backlog and does not lose a commit at the replay boundary', { timeout: 15_000 }, async (t) => {
  const subscribed = deferred<void>()
  const eventsRead = deferred<void>()
  const releaseBacklog = deferred<void>()
  let listener: ((event: unknown) => void) | undefined
  const task = { taskId: 'agent-sse-race', projectRef: { source: 'local', id: 'board-sse' } }
  const host = {
    get: async () => task,
    subscribe: (_taskId: string, next: (event: unknown) => void) => {
      listener = next
      subscribed.resolve()
      return () => { listener = undefined }
    },
    events: async () => {
      eventsRead.resolve()
      await releaseBacklog.promise
      return []
    },
  } as unknown as AgentHost
  const app = express()
  app.use('/api', createAgentRouter(host, {} as never))
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const controller = new AbortController()
  const responsePromise = fetch('http://127.0.0.1:' + address.port + '/api/agent-tasks/' + task.taskId + '/events?after=0', { signal: controller.signal })
  await subscribed.promise
  await eventsRead.promise
  listener?.({ cursor: 1, taskId: task.taskId, type: 'task.progress', payload: { stageId: 'plan' } })
  releaseBacklog.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  listener?.({ cursor: 2, taskId: task.taskId, type: 'task.finished', payload: { state: 'succeeded' } })

  const response = await responsePromise
  assert.equal(response.status, 200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let body = ''
  try {
    while (!body.includes('"cursor":2')) {
      const chunk = await reader.read()
      if (chunk.done) break
      body += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    controller.abort()
    await reader.cancel().catch(() => undefined)
  }
  assert.equal((body.match(/event: agent/gu) ?? []).length, 2)
  assert.match(body, /"cursor":1/u)
  assert.match(body, /"cursor":2/u)
})

test('binary package upload route forwards bounded bytes and idempotency key', async (t) => {
  const calls: Array<{ requestId: string; bytes: Buffer; provenance: unknown }> = []
  const manager = {
    uploadArchive: async (requestId: string, bytes: Buffer, provenance?: unknown) => {
      const prior = calls.find((entry) => entry.requestId === requestId)
      if (prior && (!prior.bytes.equals(bytes) || JSON.stringify(prior.provenance) !== JSON.stringify(provenance))) throw new AgentPackageError('REQUEST_REUSE', 'requestId уже использован для другого upload', 409)
      if (prior) return { archiveId: 'upload-fixed', archiveSha: 'a'.repeat(64), sizeBytes: prior.bytes.length, createdAt: 1 }
      calls.push({ requestId, bytes: Buffer.from(bytes), provenance })
      return { archiveId: 'upload-fixed', archiveSha: 'a'.repeat(64), sizeBytes: bytes.length, createdAt: 1 }
    },
  } as unknown as AgentPackageManager
  const app = express()
  app.use('/api', createAgentRouter({} as AgentHost, {} as never, manager))
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/api/agents/packages/upload`
  const first = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'idempotency-key': 'upload-route-1', 'x-canai-package-provenance': JSON.stringify({ name: 'fixture' }) },
    body: Buffer.from('PK\x03\x04'),
  })
  assert.equal(first.status, 201)
  assert.equal(calls[0]?.requestId, 'upload-route-1')
  assert.deepEqual([...calls[0]!.bytes], [80, 75, 3, 4])
  const replay = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'idempotency-key': 'upload-route-1', 'x-canai-package-provenance': JSON.stringify({ name: 'fixture' }) },
    body: Buffer.from('PK\x03\x04'),
  })
  assert.equal(replay.status, 201)
  assert.equal(calls.length, 1)
  const conflict = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'idempotency-key': 'upload-route-1' },
    body: Buffer.from('different'),
  })
  assert.equal(conflict.status, 409)
})

test('portable Python runtime routes expose status and require explicit install confirmation', async (t) => {
  let installs = 0
  const manager = {
    runtimeStatus: async () => ({ supported: true, ready: false, version: '3.13.16', rootRelative: 'runtime/python-3.13.16', reason: 'RUNTIME_BASELINE_REQUIRED' }),
    installPythonRuntime: async () => {
      installs += 1
      return { kind: 'python' as const, version: '3.13.16', integrity: 'a'.repeat(64), environmentId: 'b'.repeat(32), executableRelative: 'python.exe', stdlibIntegrity: 'c'.repeat(64), treeSha: 'a'.repeat(64), archiveSha: 'd'.repeat(64) }
    },
  } as unknown as AgentPackageManager
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentRouter({} as AgentHost, {} as never, manager))
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/api/agents/runtime/python`
  const status = await fetch(endpoint)
  assert.equal(status.status, 200)
  assert.equal((await status.json()).runtime.ready, false)
  const denied = await fetch(endpoint + '/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
  assert.equal(denied.status, 403)
  assert.equal(installs, 0)
  const installed = await fetch(endpoint + '/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) })
  assert.equal(installed.status, 201)
  assert.equal(installs, 1)
})

test('LAN agent routes are local-only and hide Cloud task state/control', async (t) => {
  let creates = 0
  let controls = 0
  let decisions = 0
  const local = { taskId: 'local-task-1', projectRef: { source: 'local' as const, id: 'board-1' } }
  const cloud = { taskId: 'cloud-task-1', projectRef: { source: 'cloud' as const, id: 'board-cloud' } }
  const host = {
    create: async () => { creates += 1; return local },
    list: async () => [local, cloud],
    get: async (taskId: string) => taskId === local.taskId ? local : taskId === cloud.taskId ? cloud : null,
    view: (task: unknown) => task,
    events: async () => [],
    subscribe: () => () => {},
    control: async () => { controls += 1; return local },
    decide: async () => { decisions += 1; return local },
    llmCatalog: () => ({ revision: 1, models: [] }),
  } as unknown as AgentHost
  const app = express()
  app.use(express.json())
  app.use('/api', (request, response, next) => {
    response.locals.remoteTablet = true
    next()
  }, createAgentRouter(host, {} as never))
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api`
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(base + path, init)
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  const body = {
    requestId: 'lan-request-1', packageId: 'canai.demo', taskType: 'demo-plan', instruction: 'plan',
    input: { sceneCount: 1 }, projectRef: { source: 'cloud', id: 'board-cloud' },
  }
  const cloudCreate = await call('/agent-tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal(cloudCreate.status, 403)
  assert.equal(cloudCreate.body.code, 'REMOTE_CLOUD_TASK_DENIED')
  assert.equal(creates, 0)

  const localCreate = await call('/agent-tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, requestId: 'lan-request-local', projectRef: local.projectRef }),
  })
  assert.equal(localCreate.status, 201)
  assert.deepEqual((await call('/agent-tasks')).body.tasks, [local])
  assert.equal((await call(`/agent-tasks/${cloud.taskId}`)).status, 404)
  assert.equal((await call(`/agent-tasks/${cloud.taskId}/events`)).status, 404)
  assert.equal((await call(`/agent-tasks/${cloud.taskId}/pause`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).status, 404)
  assert.equal((await call(`/agent-tasks/${cloud.taskId}/reviews/review-1/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).status, 404)
  assert.equal(controls, 0)
  assert.equal(decisions, 0)
})

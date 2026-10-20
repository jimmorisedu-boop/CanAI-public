import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentPackageCheckView, AgentTaskView, ProjectRef } from '../../../../../packages/agent-protocol/index'
import { AgentHostRequestError, classifyAgentHostFailure, createAgentHostClient } from './agentHostClient'

const projectRef: ProjectRef = { source: 'local', id: 'board-a' }

function task(): AgentTaskView {
  return {
    taskId: 'task-1', requestId: 'request-1', packageId: 'demo-agent', packageVersion: '1.0.0', packageSha: 'sha',
    protocolVersion: '1.0', projectRef, ownerId: 'owner', controllerId: 'host', taskType: 'canvas.plan',
    instruction: 'План', input: {}, inputs: [], workspaceId: 'workspace', state: 'queued', revision: 1,
    eventCursor: 1, reviews: [], receipts: [], artifacts: [], canvasItems: [], createdAt: 1, updatedAt: 1,
  }
}

test('desktop client addresses the local Host agent routes, not generate bridge', async () => {
  const urls: string[] = []
  const client = createAgentHostClient(async (input) => {
    urls.push(String(input))
    return new Response(JSON.stringify({ tasks: [task()] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const tasks = await client.listTasks(projectRef)
  assert.equal(tasks[0]?.taskId, 'task-1')
  assert.match(urls[0]!, /\/api\/agent-tasks\?projectSource=local&projectId=board-a$/)
})

test('SSE events are delivered and reconnect state is observable', () => {
  let source: { onopen: ((event: Event) => void) | null; onmessage: ((event: MessageEvent<string>) => void) | null; onerror: ((event: Event) => void) | null; close(): void } | undefined
  const statuses: string[] = []
  const received: string[] = []
  const client = createAgentHostClient(
    async () => new Response('{}', { status: 200 }),
    () => {
      source = { onopen: null, onmessage: null, onerror: null, close: () => {} }
      return source
    },
  )
  const cleanup = client.subscribe('task-1', 7, (event) => {
    if ('taskId' in event) received.push(event.taskId)
    else if ('task' in event && event.task && typeof event.task === 'object' && 'taskId' in event.task) received.push(String(event.task.taskId))
  }, (status) => statuses.push(status))
  source!.onopen?.(new Event('open'))
  source!.onmessage?.({ data: JSON.stringify({ task: task() }) } as MessageEvent<string>)
  source!.onerror?.(new Event('error'))
  cleanup()
  assert.deepEqual(received, ['task-1'])
  assert.deepEqual(statuses, ['live', 'reconnecting', 'offline'])
})

test('named Host SSE events use the agent event channel', () => {
  let handler: ((event: MessageEvent<string>) => void) | undefined
  const client = createAgentHostClient(
    async () => new Response('{}', { status: 200 }),
    () => ({
      onopen: null, onmessage: null, onerror: null, close: () => {},
      addEventListener: (_type, listener) => { handler = listener },
      removeEventListener: () => { handler = undefined },
    }),
  )
  const received: string[] = []
  const cleanup = client.subscribe('task-1', 7, (event) => {
    if ('taskId' in event) received.push(event.taskId)
  })
  handler?.({ data: JSON.stringify({ cursor: 8, taskId: 'task-1', type: 'task.progress', at: 2, payload: { stageId: 'run', label: 'Работа', status: 'running' } }) } as MessageEvent<string>)
  cleanup()
  assert.deepEqual(received, ['task-1'])
  assert.equal(handler, undefined)
})

test('package mutations keep exact request bodies and stable request ids', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const candidate: AgentPackageCheckView = {
    checkId: 'check-1', source: { kind: 'git', canonicalUrl: 'https://github.com/acme/agent' },
    manifest: {
      id: 'acme', name: 'Acme', description: 'A package', version: '1.0.0', protocolVersion: '1.0', taskTypes: [], permissions: ['canvas.read_selected'],
      lifecycle: { pause: 'checkpoint', resume: true, cancel: true }, runtime: { kind: 'node', version: '20', entrypoint: 'index.js', dependencies: 'stdlib' },
    }, packageSha: 'sha', supported: true, issues: [],
    trust: { explicitTrustRequired: true, requiredPermissions: ['canvas.read_selected'], disclaimer: 'Not a sandbox.' }, revision: 3,
  }
  const client = createAgentHostClient(async (input, init) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.endsWith('/check')) return new Response(JSON.stringify({ check: candidate }), { status: 200 })
    return new Response(JSON.stringify({ revision: 4, packages: [] }), { status: 200 })
  })
  const checkBody = { requestId: 'request-check-1', source: { kind: 'git' as const, url: 'https://github.com/acme/agent', ref: 'main' } }
  const installBody = { requestId: 'request-install-1', checkId: 'check-1', expectedRevision: 3, trustConfirmed: true as const, approvedPermissions: ['canvas.read_selected'] }
  await client.checkPackage(checkBody)
  await client.installPackage(installBody)
  await client.updatePackage({ ...installBody, requestId: 'request-update-1', priorInstallationId: 'install-1' })
  await client.managePackage('disable', { requestId: 'request-disable-1', expectedRevision: 4, installationId: 'install-1', packageId: 'acme' })
  const mutationCalls = calls.filter((call) => call.body)
  assert.deepEqual(mutationCalls.map((call) => call.url.replace('/api', '')), [
    '/agents/packages/check', '/agents/packages/install', '/agents/packages/update', '/agents/packages/disable',
  ])
  assert.deepEqual(mutationCalls[1]?.body, installBody)
  assert.deepEqual(mutationCalls[2]?.body, { ...installBody, requestId: 'request-update-1', priorInstallationId: 'install-1' })
  assert.equal((mutationCalls[3]?.body as { requestId: string }).requestId, 'request-disable-1')
})

test('ZIP upload stays binary and uses an idempotency key', async () => {
  let received: { body: unknown; headers: Headers } | undefined
  const archive = new Blob([new Uint8Array([80, 75, 3, 4, 0, 1])], { type: 'application/zip' })
  const client = createAgentHostClient(async (input, init) => {
    received = { body: init?.body, headers: new Headers(init?.headers) }
    return new Response(JSON.stringify({ upload: { archiveId: 'upload-1', archiveSha: 'a'.repeat(64), sizeBytes: 6, createdAt: 1 } }), { status: 201 })
  })
  const upload = await client.uploadPackageArchive({ requestId: 'upload-request-1', archive })
  assert.equal(upload.archiveId, 'upload-1')
  assert.equal(received?.headers.get('content-type'), 'application/zip')
  assert.equal(received?.headers.get('idempotency-key'), 'upload-request-1')
  assert.equal(received?.body, archive)
  assert.equal(typeof received?.body, 'object')
})

test('portable Python status is read-only until explicit install call', async () => {
  const calls: string[] = []
  const client = createAgentHostClient(async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input).replace('/api', '')}`)
    if (String(input).endsWith('/runtime/python')) return new Response(JSON.stringify({ runtime: { supported: true, ready: false, version: '3.13.16', rootRelative: 'python', reason: 'RUNTIME_BASELINE_REQUIRED' } }), { status: 200 })
    return new Response(JSON.stringify({ runtime: { supported: true, ready: true, version: '3.13.16', rootRelative: 'python', runtime: { kind: 'python', version: '3.13.16', integrity: 'i', environmentId: 'e', executableRelative: 'python.exe', stdlibIntegrity: 's', treeSha: 't', archiveSha: 'a'.repeat(64) } } }), { status: 201 })
  })
  const before = await client.getPythonRuntime!()
  assert.equal(before.ready, false)
  assert.deepEqual(calls, ['GET /agents/runtime/python'])
  const after = await client.installPythonRuntime!()
  assert.equal(after.ready, true)
  assert.deepEqual(calls, ['GET /agents/runtime/python', 'POST /agents/runtime/python/install'])
})

test('package refusal stays live while transport failure is offline', () => {
  const refused = classifyAgentHostFailure(new AgentHostRequestError('Права не подтверждены', 403, 'TRUST_REQUIRED'))
  assert.deepEqual(refused, { domainRefusal: true, refreshLibrary: false, message: 'Права не подтверждены' })
  const stale = classifyAgentHostFailure(new AgentHostRequestError('Ревизия устарела', 409, 'LIBRARY_REVISION_STALE'))
  assert.deepEqual(stale, { domainRefusal: true, refreshLibrary: true, message: 'Ревизия устарела' })
  const offline = classifyAgentHostFailure(new TypeError('fetch failed'))
  assert.deepEqual(offline, { domainRefusal: false, refreshLibrary: false, message: 'fetch failed' })
})

test('LLM start keeps consent and integer micros in the exact Host request body', async () => {
  let body: unknown
  const client = createAgentHostClient(async (_input, init) => {
    body = init?.body ? JSON.parse(String(init.body)) : undefined
    return new Response(JSON.stringify({ task: task() }), { status: 201 })
  })
  await client.startTask({
    requestId: 'request-llm-1', projectRef, packageId: 'writer', taskType: 'write',
    instruction: 'Сделай текст', input: { tone: 'plain' }, inputs: [],
    llm: { connectionId: 'local-fal', textTransferConsent: true, maxCostMicros: 123_456, expectedModelId: 'assistant-text', expectedCatalogRevision: 8 },
  })
  assert.deepEqual(body, {
    requestId: 'request-llm-1', projectRef, packageId: 'writer', taskType: 'write',
    instruction: 'Сделай текст', input: { tone: 'plain' }, inputs: [],
    llm: { connectionId: 'local-fal', textTransferConsent: true, maxCostMicros: 123_456, expectedModelId: 'assistant-text', expectedCatalogRevision: 8 },
  })
})

test('local Host generation catalog and launch keep the pinned grant DTO exact', async () => {
  const urls: string[] = []
  let body: unknown
  const client = createAgentHostClient(async (input, init) => {
    urls.push(String(input))
    if (String(input).endsWith('/agents/generation/catalog')) {
      return new Response(JSON.stringify({
        revision: 12,
        connection: { id: 'local-fal', kind: 'generation', status: 'ready' },
        models: [{ id: 'image-a', name: 'Image A', kind: 'image', endpoint: 'fake/image-a', params: [], refs: false }],
      }), { status: 200 })
    }
    body = init?.body ? JSON.parse(String(init.body)) : undefined
    return new Response(JSON.stringify({ task: task() }), { status: 201 })
  })
  const catalog = await client.getGenerationCatalog!()
  assert.equal(catalog.connection.status, 'ready')
  assert.equal(catalog.revision, 12)
  await client.startTask({
    requestId: 'request-generation-1', projectRef, packageId: 'media-agent', taskType: 'make-image',
    instruction: 'Сделай картинку', input: {}, inputs: [],
    generation: {
      connectionId: 'local-fal', mediaTransferConsent: true, maxCostMicros: 250_000, maxCalls: 1,
      expectedModelId: 'image-a', expectedCatalogRevision: 12,
      artifactRefs: [{ artifactId: 'ref-a', revision: 3, checksum: 'a'.repeat(64) }],
    },
  })
  assert.match(urls[0]!, /\/agents\/generation\/catalog$/u)
  assert.deepEqual(body, {
    requestId: 'request-generation-1', projectRef, packageId: 'media-agent', taskType: 'make-image',
    instruction: 'Сделай картинку', input: {}, inputs: [],
    generation: {
      connectionId: 'local-fal', mediaTransferConsent: true, maxCostMicros: 250_000, maxCalls: 1,
      expectedModelId: 'image-a', expectedCatalogRevision: 12,
      artifactRefs: [{ artifactId: 'ref-a', revision: 3, checksum: 'a'.repeat(64) }],
    },
  })
})

test('local Host capture sends board item identities and returns native receipts', async () => {
  let body: unknown
  const client = createAgentHostClient(async (_input, init) => {
    body = init?.body ? JSON.parse(String(init.body)) : undefined
    return new Response(JSON.stringify({ receipts: [{
      itemId: 'item-a',
      artifact: {
        artifactId: 'agent-ref-a', revision: 1, checksum: 'a'.repeat(64), kind: 'image',
        caption: 'Native', mimeType: 'image/png', sizeBytes: 1, mediaSrc: '/media/agent-ref-a.png', provenance: 'reference',
      },
    }] }), { status: 200 })
  })
  const receipts = await client.captureGenerationInputs!({
    projectRef, projectRevision: 7,
    inputs: [{ itemId: 'item-a', kind: 'image' }],
  })
  assert.equal(receipts[0]?.artifact.checksum, 'a'.repeat(64))
  assert.deepEqual(body, { projectRef, projectRevision: 7, inputs: [{ itemId: 'item-a', kind: 'image' }] })
})

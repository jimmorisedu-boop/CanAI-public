import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JOB_RECOVERY_REVIEW_ERROR, JobStore } from './jobs.js'
import { publicLocalJob, waitForJobs } from './jobWait.js'
import type { CatalogModel } from './catalog.js'

function tempName(prefix: string): string {
  return path.join(os.tmpdir(), prefix)
}

test('JobStore restores queued and submitted local jobs without losing requestId', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-local-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')

  const first = new JobStore(file)
  const queued = first.create('image', 'queued prompt', [])
  queued.generationRoute = 'local'
  const submitted = first.create('video', 'submitted prompt', [])
  submitted.status = 'running'
  submitted.generationRoute = 'local'
  submitted.falEndpoint = 'fal-ai/example/video'
  submitted.falRequestId = 'request-123'
  const audio = first.create('text', 'audio prompt', [{ kind: 'audio', src: '/media/voice.mp3' }])
  await first.persistNow()

  const second = new JobStore(file)
  const active = await second.restore()
  assert.deepEqual(active.map((job) => job.id).sort(), [queued.id, submitted.id, audio.id].sort())
  assert.equal(second.get(submitted.id)?.falRequestId, 'request-123')
  assert.equal(second.get(submitted.id)?.status, 'running')
  assert.equal(second.get(audio.id)?.refs[0]?.kind, 'audio')
  assert.equal(second.get(queued.id)?.generationRoute, 'local')
})

test('public job and wait responses hide provider recovery internals while disk state survives', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-public-view-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')
  const store = new JobStore(file)
  const job = store.create('image', 'private recovery', [])
  job.generationRoute = 'local'
  job.status = 'running'
  job.falEndpoint = 'fal-ai/private-model'
  job.falRequestId = 'provider-request-private'
  job.paidResult = { url: 'https://provider.invalid/result.png', width: 32, height: 24 }
  const direct = publicLocalJob(job)
  for (const field of ['falEndpoint', 'falRequestId', 'paidResult']) assert.equal(field in direct, false, field)
  const waited = await waitForJobs([job.id], {}, 0, {
    local: (id) => store.get(id),
    allLocal: () => store.all(),
    now: () => 0,
    sleep: async () => undefined,
  })
  for (const field of ['falEndpoint', 'falRequestId', 'paidResult']) assert.equal(field in (waited[0]?.job ?? {}), false, field)
  await store.persistNow()
  const restored = new JobStore(file)
  await restored.restore()
  assert.equal(restored.get(job.id)?.falEndpoint, 'fal-ai/private-model')
  assert.equal(restored.get(job.id)?.falRequestId, 'provider-request-private')
  assert.deepEqual(restored.get(job.id)?.paidResult, job.paidResult)
})

test('JobStore rejects an unknown saved generation route', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-route-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    jobs: [{
      id: 'job-1', kind: 'image', prompt: 'cat', refs: [], status: 'queued',
      createdAt: 1, generationRoute: 'someone-elses-server',
    }],
  }))
  await assert.rejects(new JobStore(file).restore(), /jobs\.json corrupted: invalid job/u)
})

test('legacy shared jobs never enter the local execution queue after an upgrade', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-local-upgrade-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')
  const local = new JobStore(file)
  const queued = local.create('image', 'local work', [])
  queued.generationRoute = 'local'
  await local.persistNow()
  const document = JSON.parse(await fs.readFile(file, 'utf8'))
  document.jobs.push(
    { ...queued, id: 'old-shared-route', generationRoute: 'account-cloud' },
    { ...queued, id: 'old-shared-target', target: { kind: 'canvas', source: 'cloud', projectId: 'remote-board', placeholderId: 'pending-remote' } },
    { ...queued, id: 'old-shared-binding', cloudJobId: 'remote-job' },
  )
  await fs.writeFile(file, JSON.stringify(document))
  const restored = new JobStore(file)
  const executable = await restored.restore()
  assert.deepEqual(executable.map(job => job.id), [queued.id])
  assert.equal(restored.get(queued.id)?.generationRoute, 'local')
  for (const id of ['old-shared-route', 'old-shared-target', 'old-shared-binding']) {
    assert.equal(restored.get(id), undefined, 'a shared request cannot be submitted to the local provider')
  }
  const durable = JSON.parse(await fs.readFile(file, 'utf8')) as { jobs: Array<Record<string, unknown>> }
  const backup = JSON.parse(await fs.readFile(`${file}.bak`, 'utf8')) as { jobs: Array<Record<string, unknown>> }
  assert.deepEqual(durable.jobs.map((job) => job.id), [queued.id], 'primary migration removes shared jobs')
  assert.deepEqual(backup.jobs.map((job) => job.id), [queued.id], 'backup migration removes shared jobs')
  assert.equal(JSON.stringify(durable).includes('account-cloud'), false)
  assert.equal(JSON.stringify(backup).includes('account-cloud'), false)
})

test('JobStore rejects a corrupt file instead of overwriting paid job state', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-corrupt-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')
  await fs.writeFile(file, '{broken', 'utf8')
  const store = new JobStore(file)
  await assert.rejects(store.restore())
  assert.equal(await fs.readFile(file, 'utf8'), '{broken')
})

test('JobStore restores a valid backup, quarantines corrupt primary, and blocks ambiguous paid work', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-recovery-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')
  const first = new JobStore(file)
  const job = first.create('image', 'preserve this prompt', [{ kind: 'image', src: '/media/keep.png' }])
  job.generationRoute = 'local'
  await first.persistNow()
  job.status = 'running'
  await first.persistNow()
  const backupBefore = await fs.readFile(`${file}.bak`, 'utf8')
  await fs.writeFile(file, '{broken', 'utf8')

  const restored = new JobStore(file)
  assert.deepEqual(await restored.restore(), [])
  const quarantined = (await fs.readdir(dir)).filter((name) => name.startsWith('jobs.json.corrupt-'))
  assert.equal(quarantined.length, 1)
  const recovered = restored.get(job.id)
  assert.equal(recovered?.status, 'error')
  assert.equal(recovered?.error, JOB_RECOVERY_REVIEW_ERROR)
  assert.equal(recovered?.recoveryNeedsReview, true)
  assert.deepEqual(recovered?.refs, [{ kind: 'image', src: '/media/keep.png' }])
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), backupBefore)
  const durable = JSON.parse(await fs.readFile(file, 'utf8')) as { jobs: Array<{ recoveryNeedsReview?: boolean; refs?: Array<{ src?: string }> }> }
  assert.equal(durable.jobs[0]?.recoveryNeedsReview, true)
  assert.deepEqual(durable.jobs[0]?.refs, [{ kind: 'image', src: '/media/keep.png' }])
  assert.equal((JSON.parse(await fs.readFile(`${file}.recovery-pending`, 'utf8')) as { phase?: string }).phase, 'applied')

  const restarted = new JobStore(file)
  assert.deepEqual(await restarted.restore(), [])
  assert.equal(restarted.get(job.id)?.recoveryNeedsReview, true)
  const fresh = restarted.create('image', 'new work after review', [])
  fresh.generationRoute = 'local'
  await restarted.persistNow()
  const thirdStart = new JobStore(file)
  assert.deepEqual((await thirdStart.restore()).map((entry) => entry.id), [fresh.id])
})

test('JobStore resumes a provider binding from a recovered backup without a new submit', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-binding-recovery-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')
  const first = new JobStore(file)
  const job = first.create('video', 'resume this request', [])
  job.status = 'running'
  job.generationRoute = 'local'
  job.falEndpoint = 'fal-ai/video'
  job.falRequestId = 'request-kept'
  await first.persistNow()
  await first.persistNow()
  await fs.writeFile(file, '{broken', 'utf8')

  const restored = new JobStore(file)
  const active = await restored.restore()
  assert.deepEqual(active.map((entry) => entry.id), [job.id])
  assert.equal(restored.get(job.id)?.falRequestId, 'request-kept')
  assert.equal(restored.get(job.id)?.recoveryNeedsReview, undefined)
})

test('JobStore refuses invalid primary and invalid backup without overwriting either file', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-recovery-fail-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')
  await fs.writeFile(file, '{primary-broken', 'utf8')
  await fs.writeFile(`${file}.bak`, '{backup-broken', 'utf8')
  const store = new JobStore(file)
  await assert.rejects(store.restore(), /jobs\.json cannot be recovered/u)
  assert.equal(await fs.readFile(file, 'utf8'), '{primary-broken')
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), '{backup-broken')
})

test('JobStore preserves prompt-chat targets, internal jobs, and deliveredAt', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-target-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')
  const first = new JobStore(file)
  const chat = first.create('text', 'User question', [], 'claude', {}, {
    kind: 'prompt-chat', projectId: 'p1', conversationId: 'c1',
    requestMessageId: 'u1', responseMessageId: 'a1', requestId: 'send-1', boardMemoryEnabled: false,
  })
  chat.status = 'done'
  chat.result = { text: '{"reply":"Done","prompts":[]}' }
  chat.finishedAt = Date.now()
  chat.deliveredAt = chat.finishedAt + 1
  const compaction = first.create('text', 'Memory', [], 'qwen', {}, {
    kind: 'prompt-chat-compaction', projectId: 'p1', conversationId: 'c1',
    fromMessageId: null, throughMessageId: 'a1', contextRevision: 2,
  }, true)
  await first.persistNow()

  const restored = new JobStore(file)
  await restored.restore()
  assert.deepEqual(restored.get(chat.id)?.target, chat.target)
  assert.equal(restored.get(chat.id)?.deliveredAt, chat.deliveredAt)
  assert.deepEqual(restored.get(compaction.id)?.target, compaction.target)
  assert.equal(restored.get(compaction.id)?.internal, true)
})

test('JobStore rejects a prompt-chat target with a malformed memory flag', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-board-memory-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    jobs: [{
      id: 'job-1', kind: 'text', prompt: 'answer', refs: [], status: 'queued', createdAt: 1,
      target: { kind: 'prompt-chat', projectId: 'p1', conversationId: 'c1', requestMessageId: 'u1', responseMessageId: 'a1', requestId: 'r1', boardMemoryEnabled: 'false' },
    }],
  }))
  await assert.rejects(new JobStore(file).restore(), /jobs\.json corrupted: invalid job/u)
})

test('JobStore restores a catalog draft snapshot and idempotency key', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-draft-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')
  const draft: CatalogModel = {
    id: 'user-demo', name: 'Test', kind: 'image', endpoint: 'vendor/demo',
    params: [], pricing: { unit: 'image', usd: 0.1 },
  }
  const first = new JobStore(file)
  const job = first.create('image', 'test', [], draft.id)
  job.modelSnapshot = draft
  job.catalogDraftTest = { draftId: draft.id, definitionHash: 'd'.repeat(64), tariffHash: 'e'.repeat(64), idempotencyKey: 'attempt-1' }
  await first.persistNow()
  const restored = new JobStore(file)
  await restored.restore()
  assert.deepEqual(restored.get(job.id)?.modelSnapshot, draft)
  assert.deepEqual(restored.get(job.id)?.catalogDraftTest, job.catalogDraftTest)
})

test('JobStore ignores legacy remote work when importing a local jobs file', async (t) => {
  const dir = await fs.mkdtemp(tempName('canai-jobs-local-migration-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {}))
  const file = path.join(dir, 'jobs.json')
  await fs.writeFile(file, JSON.stringify({ version: 1, jobs: [
    { id: 'remote', kind: 'image', prompt: 'remote', refs: [], status: 'queued', createdAt: 1, generationRoute: 'account-cloud' },
    { id: 'local', kind: 'image', prompt: 'local', refs: [], status: 'queued', createdAt: 2, generationRoute: 'local' },
  ] }))
  const store = new JobStore(file)
  const active = await store.restore()
  assert.deepEqual(active.map((job) => job.id), ['local'])
  assert.equal(store.get('remote'), undefined)
})

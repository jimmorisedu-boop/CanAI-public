import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('canvas delivery and paid-result recovery use the real local jobs.json', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-verify-delivery-'))
  process.env.CANAI_DATA_DIR = dataDir
  process.env.CANAI_ENV_FILE = path.join(dataDir, 'missing.env')
  process.env.CANAI_MOCK = '1'
  const [{ jobs }, { generationGate }, runner, projects, presence, chat, { config }] = await Promise.all([
    import('./jobs.js'), import('./generationGate.js'), import('./runner.js'),
    import('./projects.js'), import('./boardPresence.js'), import('./promptChatDelivery.js'), import('./config.js'),
  ])
  // A closed gate prevents a recovery assertion from starting a provider call.
  await generationGate.closeAndWait()
  t.after(async () => {
    config.falKey = null
    for (const job of jobs.all()) jobs.remove(job.id)
    presence.resetBoardPresence()
    await jobs.persistNow()
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const board = await projects.createProject('Delivery')
  const target = { kind: 'canvas' as const, projectId: board.id, placeholderId: 'slot-1' }

  await t.test('a download failure does not receive deliveredAt and is recovered', async () => {
    const job = jobs.create('image', 'Paid', [], 'nano-banana', {}, target)
    Object.assign(job, {
      status: 'error', error: 'CDN unavailable', finishedAt: Date.now(),
      falEndpoint: 'fal-ai/nano-banana', falRequestId: 'existing-request',
      paidResult: { url: 'https://example.test/paid.png' },
    })
    await runner.deliverJobResult(job)
    assert.equal(job.deliveredAt, undefined)
    await jobs.persistNow()
    jobs.remove(job.id)
    assert.equal((await runner.restoreJobs()).restored, 1)
    assert.equal(jobs.get(job.id)?.status, 'queued')
    assert.equal(jobs.get(job.id)?.falRequestId, 'existing-request')
    assert.deepEqual(jobs.get(job.id)?.paidResult, { url: 'https://example.test/paid.png' })
    jobs.remove(job.id)
  })

  await t.test('an old error deliveredAt does not bury a paid canvas job', async () => {
    const job = jobs.create('image', 'Old failure', [], 'nano-banana', {}, target)
    Object.assign(job, {
      status: 'error', error: 'timeout', deliveredAt: Date.now(), finishedAt: Date.now(),
      falEndpoint: 'fal-ai/nano-banana', falRequestId: 'historical-request',
    })
    await jobs.persistNow()
    jobs.remove(job.id)
    await runner.restoreJobs()
    assert.equal(jobs.get(job.id)?.status, 'queued')
    assert.equal(jobs.get(job.id)?.deliveredAt, undefined)
    assert.equal(jobs.get(job.id)?.falRequestId, 'historical-request')
    jobs.remove(job.id)
  })

  await t.test('delivery is idempotent and waits while a local board is open', async () => {
    const job = jobs.create('image', 'Ready', [], undefined, {}, target)
    Object.assign(job, {
      status: 'done', finishedAt: Date.now(), result: {
        url: '/media/ready.png', mime: 'image/png', width: 100, height: 100,
      },
    })
    presence.claimBoard(board.id, 'device-1', 'Open board')
    await runner.deliverJobResult(job)
    assert.equal(job.deliveredAt, undefined)
    assert.equal((await projects.loadProjectSnapshot(board.id))?.snapshot, null)
    presence.resetBoardPresence()
    await runner.deliverJobResult(job)
    assert.ok(job.deliveredAt)
    // If the process dies after writing the canvas but before jobs.json, the
    // sourceJobId guard makes retry safe.
    job.deliveredAt = undefined
    await runner.deliverJobResult(job)
    const saved = (await projects.loadProjectSnapshot(board.id))?.snapshot as { items: unknown[] }
    assert.equal(saved.items.length, 1)
    assert.ok(job.deliveredAt)
    jobs.remove(job.id)
  })

  await t.test('a queued local job can be cancelled without a provider request', async () => {
    const job = jobs.create('image', 'Cancel me', [], 'nano-banana', {}, target)
    const outcome = await runner.cancelJobById(job.id)
    assert.equal(outcome, 'cancelled')
    assert.equal(job.status, 'error')
    assert.equal(job.error, 'Cancelled')
    assert.equal(job.cancelled, true)
    assert.equal(job.falRequestId, undefined)
    jobs.remove(job.id)
  })

  await t.test('paid-error recovery stops after the retry budget', async () => {
    const job = jobs.create('image', 'Changed key', [], 'nano-banana', {}, target)
    Object.assign(job, {
      status: 'error', error: 'invalid key credentials', finishedAt: Date.now(),
      falEndpoint: 'fal-ai/nano-banana', falRequestId: 'foreign-key-request',
    })
    for (let attempt = 1; attempt <= runner.MAX_RECOVERY_ATTEMPTS; attempt++) {
      await jobs.persistNow()
      jobs.remove(job.id)
      assert.equal((await runner.restoreJobs()).restored, 1, `attempt ${attempt} should resume`)
      const restored = jobs.get(job.id)!
      assert.equal(restored.recoveryAttempts, attempt)
      Object.assign(restored, { status: 'error', error: 'invalid key credentials', finishedAt: Date.now() })
    }
    await jobs.persistNow()
    jobs.remove(job.id)
    assert.equal((await runner.restoreJobs()).restored, 0)
    assert.equal(jobs.get(job.id)?.status, 'error')
    jobs.remove(job.id)
  })

  await t.test('cancelled paid errors are not resumed', async () => {
    const job = jobs.create('image', 'Cancelled', [], undefined, {}, target)
    Object.assign(job, {
      status: 'error', cancelled: true, error: 'Cancelled', finishedAt: Date.now(),
      falEndpoint: 'fal-ai/nano-banana', falRequestId: 'cancelled-request',
    })
    await jobs.persistNow()
    jobs.remove(job.id)
    await runner.restoreJobs()
    assert.equal(jobs.get(job.id)?.status, 'error')
    jobs.remove(job.id)
  })

  await t.test('a chat error is finalized and is not resumed after delivery', async () => {
    const repo = chat.promptChatRepository
    const conversation = await repo.createOrReuseEmpty(board.id, 'claude')
    const chatTarget = {
      kind: 'prompt-chat' as const, projectId: board.id, conversationId: conversation.id,
      requestMessageId: 'u1', responseMessageId: 'a1', requestId: 'send-1',
    }
    const job = jobs.create('text', 'Question', [], 'claude', {}, chatTarget)
    await repo.appendMessages(board.id, conversation.id, [
      { id: 'u1', role: 'user', text: 'Question', createdAt: 1 },
      { id: 'a1', role: 'assistant', text: '', createdAt: 2, status: 'queued', jobId: job.id },
    ])
    Object.assign(job, {
      status: 'error', error: 'Provider error', finishedAt: Date.now(),
      falEndpoint: 'fal-ai/any-llm', falRequestId: 'chat-request',
    })
    await runner.deliverJobResult(job)
    assert.ok(job.deliveredAt)
    assert.equal((await repo.findMessage(board.id, conversation.id, 'a1'))?.status, 'error')
    jobs.remove(job.id)
    await runner.restoreJobs()
    assert.equal(jobs.get(job.id)?.status, 'error')
    jobs.remove(job.id)
  })
})

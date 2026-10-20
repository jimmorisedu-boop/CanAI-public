import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CatalogLibrary } from './catalogLibrary.js'
import { JobStore } from './jobs.js'
import { CATALOG, type CatalogModel } from './catalog.js'
import { CatalogDraftTestService, quoteDraftTest } from './catalogDraftTests.js'
import { prepareFalModelSetup } from './falModelSetup.js'

async function harness(t: { after(fn: () => Promise<void> | void): void }, draft: CatalogModel) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-draft-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  const file = path.join(dir, 'catalog.json')
  const library = new CatalogLibrary(file, CATALOG)
  await library.load()
  await library.saveDraft(draft, 0)
  await library.updateDraftTariff(draft.id, {
    pricing: draft.pricing,
    textPricing: draft.textPricing,
    tariffSourceUrl: `https://fal.ai/models/${draft.endpoint}`,
  }, 1)
  const jobs = new JobStore(path.join(dir, 'jobs.json'))
  let enqueueCount = 0
  const service = new CatalogDraftTestService(library, jobs, {
    getConfirmCostAboveUsd: async () => 0.01,
    generationRoute: () => 'mock',
    persistAndEnqueue: async () => { enqueueCount += 1; await jobs.persistNow() },
  })
  return { library, file, jobs, service, enqueueCount: () => enqueueCount }
}

test('Krea megapixel setup persists a tariff and allows a confirmed test with changed references and reasoning', async t => {
  const draft: CatalogModel = {
    id: 'user-krea-v3-edit', name: 'Krea 3 Edit', endpoint: 'krea/v3/edit', kind: 'image',
    refs: true, imageInputField: 'image_urls', minImageRefs: 1, maxImageRefs: 8,
    params: [{ name: 'reasoning_level', label: 'Reasoning', widget: 'select', default: 'low', options: ['low', 'medium', 'high'].map(value => ({ value, label: value })) }],
  }
  const refs = [{ kind: 'image' as const, src: '/media/flower.jpg' }]
  const setup = await prepareFalModelSetup(draft, {
    falKey: 'test-key',
    buildSamples: async () => ({ input: { prompt: 'Edit flowers', params: { reasoning_level: 'low' }, refs }, samples: [] }),
    fetcher: async () => new Response(JSON.stringify({ prices: [{ endpoint_id: draft.endpoint, unit_price: 0.025, unit: 'megapixels', currency: 'USD' }] })),
  })
  const h = await harness(t, { ...draft, pricing: setup.persist?.pricing })
  const low = await h.service.quote(draft.id, { reasoning_level: 'low' }, refs)
  assert.equal(low.amountUsd, setup.pricing?.amountUsd)
  const high = await h.service.quote(draft.id, { reasoning_level: 'high' }, [...refs, ...refs])
  assert.equal(high.amountUsd, 0.426849)
  assert.equal(h.enqueueCount(), 0, 'Preparing and quoting never submit a generation')
  const job = await h.service.start({
    draftId: draft.id, prompt: 'Edit flowers', params: { reasoning_level: 'high' }, refs: [...refs, ...refs],
    idempotencyKey: 'krea-confirmed-test', confirmedAmountUsd: high.amountUsd,
  })
  assert.equal(job.status, 'queued')
  assert.equal(h.enqueueCount(), 1)
})

function nanoBananaEditDraft(): CatalogModel {
  return {
    id: 'user-google-nano-banana-2-1-edit',
    name: 'Nano Banana 2.1 Edit',
    kind: 'image',
    endpoint: 'google/nano-banana-2.1/edit',
    refs: true,
    imageInputField: 'image_urls',
    conditionalReferenceRequirement: 'image-or-video-or-pdf',
    minImageRefs: 0,
    maxImageRefs: 16,
    videoRefs: true,
    videoInputField: 'video_url',
    minVideoRefs: 0,
    maxVideoRefs: 1,
    params: [
      { name: 'output_format', label: 'Output Format', widget: 'select', options: ['jpeg', 'png', 'webp'].map(value => ({ value, label: value })), default: 'png' },
      { name: 'resolution', label: 'Resolution', widget: 'select', options: ['1K', '2K', '4K'].map(value => ({ value, label: value })), default: '1K' },
      { name: 'pdf_url', label: 'PDF URL', widget: 'textarea' },
      { name: 'document_url', label: 'Document URL', widget: 'textarea' },
      { name: 'custom__pdf_url', label: 'Custom PDF URL', widget: 'textarea' },
      { name: 'thinking_level', label: 'Thinking Level', widget: 'select', options: ['minimal', 'medium', 'high'].map(value => ({ value, label: value })), default: 'medium' },
      { name: 'seed', label: 'Seed', widget: 'seed', step: 1 },
      { name: 'num_images', label: 'Number of Images', widget: 'number', min: 1, max: 1, step: 1, default: 1 },
    ],
    pricing: { unit: 'image', usd: 0.08 },
  }
}

test('draft quote uses the confirmed flat tariff', () => {
  const draft: CatalogModel = {
    id: 'user-video', name: 'Видео', kind: 'video', endpoint: 'vendor/video', params: [
      { name: 'duration', label: 'Длительность', widget: 'number', default: 4 },
    ],
    pricing: { unit: 'second', usd: 0.05 },
  }
  const quote = quoteDraftTest(draft, {}, 0.1)
  assert.equal(quote.amountUsd, 0.2)
  assert.equal(quote.requiresConfirmation, true)
  assert.match(quote.definitionHash, /^[a-f0-9]{64}$/)
  assert.match(quote.tariffHash, /^[a-f0-9]{64}$/)
})

test('historical per-call pricing survives quote, test receipt, and publication without token fabrication', async t => {
  const draft: CatalogModel = {
    id: 'user-call-priced-text', name: 'Call-priced text', kind: 'text', endpoint: 'vendor/call-priced-text',
    promptInputField: 'prompt', params: [], pricing: { unit: 'call', usd: 0.31 },
  }
  const { service, jobs, library } = await harness(t, draft)
  const quote = await service.quote(draft.id, {}, [])
  assert.equal(quote.amountUsd, 0.31)
  const job = await service.start({
    draftId: draft.id,
    prompt: 'Проверка одного вызова',
    refs: [],
    params: {},
    idempotencyKey: 'call-priced-test',
    confirmedAmountUsd: quote.amountUsd,
  })
  job.status = 'done'
  job.result = { text: 'Готово' }
  job.finishedAt = Date.now()
  await jobs.persistNow()
  await service.status(draft.id, job.id)
  const view = library.view()
  assert.equal(view.draftMeta[draft.id]?.test?.jobId, job.id)
  await library.publish(draft.id, view.revision)
  assert.equal(library.view().models.find(model => model.id === draft.id)?.pricing?.unit, 'call')
})

test('draft test validates required refs and reuses one idempotent job', async t => {
  const draft: CatalogModel = {
    id: 'user-audio-test', name: 'Аудио', kind: 'audio', endpoint: 'vendor/audio',
    refs: true, audioInputField: 'audio_url', minAudioRefs: 1, maxAudioRefs: 1, maxTotalRefs: 1,
    params: [], pricing: { unit: 'image', usd: 0.05 },
  }
  const { service, jobs, library, enqueueCount } = await harness(t, draft)
  await assert.rejects(service.start({
    draftId: draft.id, prompt: 'голос', refs: [], params: {},
    idempotencyKey: 'attempt-1', confirmedAmountUsd: 0.05,
  }), /requires audio selection/)

  const input = {
    draftId: draft.id,
    prompt: 'голос',
    refs: [{ kind: 'audio' as const, src: '/media/voice.mp3' }],
    params: {},
    idempotencyKey: 'attempt-1',
    confirmedAmountUsd: 0.05,
  }
  await assert.rejects(service.start({ ...input, idempotencyKey: 'unconfirmed', confirmedAmountUsd: undefined }), /Confirm the paid test/i)
  const first = await service.start(input)
  const repeated = await service.start(input)
  assert.equal(repeated.id, first.id)
  assert.equal(enqueueCount(), 1)

  first.status = 'done'
  first.result = { url: '/media/result.mp3', mime: 'audio/mpeg' }
  first.finishedAt = Date.now()
  await jobs.persistNow()
  const status = await service.status(draft.id, first.id)
  assert.equal(status.actualCostUsd, null)
  assert.equal(library.view().draftMeta[draft.id]?.test?.jobId, first.id)
  assert.equal(library.view().draftMeta[draft.id]?.test?.actualCostUsd, null)
  const recordedRevision = library.view().revision
  await service.status(draft.id, first.id)
  assert.equal(library.view().revision, recordedRevision, 'повторный status не перезаписывает чек')
})

test('concurrent starts with one idempotency key enqueue only one job', async t => {
  const draft: CatalogModel = {
    id: 'user-concurrent-test', name: 'Concurrent', kind: 'image', endpoint: 'vendor/concurrent',
    promptInputField: 'prompt', params: [], pricing: { unit: 'image', usd: 0.05 },
  }
  const { library, jobs } = await harness(t, draft)
  let releaseConfirm!: () => void
  let confirmStarted!: () => void
  const confirmGate = new Promise<void>(resolve => { releaseConfirm = resolve })
  const confirmReady = new Promise<void>(resolve => { confirmStarted = resolve })
  let confirmCalls = 0
  let enqueueCount = 0
  const service = new CatalogDraftTestService(library, jobs, {
    getConfirmCostAboveUsd: async () => {
      confirmCalls += 1
      confirmStarted()
      await confirmGate
      return 0.01
    },
    generationRoute: () => 'mock',
    persistAndEnqueue: async () => {
      enqueueCount += 1
      await jobs.persistNow()
    },
  })
  const input = {
    draftId: draft.id,
    prompt: 'Один запуск',
    refs: [],
    params: {},
    idempotencyKey: 'concurrent-key',
    confirmedAmountUsd: 0.05,
  }
  const first = service.start(input)
  await confirmReady
  const second = service.start(input)
  releaseConfirm()
  const [firstJob, secondJob] = await Promise.all([first, second])
  assert.equal(firstJob.id, secondJob.id)
  assert.equal(jobs.all().length, 1)
  assert.equal(confirmCalls, 1)
  assert.equal(enqueueCount, 1)
})

test('failed singleflight start cleans up so a retry can enqueue a fresh job', async t => {
  const draft: CatalogModel = {
    id: 'user-retry-test', name: 'Retry', kind: 'image', endpoint: 'vendor/retry',
    promptInputField: 'prompt', params: [], pricing: { unit: 'image', usd: 0.05 },
  }
  const { library, jobs } = await harness(t, draft)
  let attempts = 0
  const service = new CatalogDraftTestService(library, jobs, {
    getConfirmCostAboveUsd: async () => 0.01,
    generationRoute: () => 'mock',
    persistAndEnqueue: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary enqueue failure')
      await jobs.persistNow()
    },
  })
  const input = {
    draftId: draft.id,
    prompt: 'Повторить запуск',
    refs: [],
    params: {},
    idempotencyKey: 'retry-key',
    confirmedAmountUsd: 0.05,
  }
  await assert.rejects(service.start(input), /temporary enqueue failure/)
  const retried = await service.start(input)
  assert.equal(attempts, 2)
  assert.equal(jobs.all().length, 1)
  assert.equal(retried.catalogDraftTest?.idempotencyKey, input.idempotencyKey)
})

test('concurrent start waits for a pending persist failure instead of returning an unsaved job', async t => {
  const draft: CatalogModel = {
    id: 'user-concurrent-failure-test', name: 'Concurrent failure', kind: 'image', endpoint: 'vendor/concurrent-failure',
    promptInputField: 'prompt', params: [], pricing: { unit: 'image', usd: 0.05 },
  }
  const { library, jobs } = await harness(t, draft)
  let releasePersist!: () => void
  let persistEntered!: () => void
  const persistGate = new Promise<void>(resolve => { releasePersist = resolve })
  const persistReady = new Promise<void>(resolve => { persistEntered = resolve })
  const service = new CatalogDraftTestService(library, jobs, {
    getConfirmCostAboveUsd: async () => 0.01,
    generationRoute: () => 'mock',
    persistAndEnqueue: async () => {
      persistEntered()
      await persistGate
      throw new Error('deferred enqueue failure')
    },
  })
  const input = {
    draftId: draft.id,
    prompt: 'Не возвращать незаписанную задачу',
    refs: [],
    params: {},
    idempotencyKey: 'concurrent-failure-key',
    confirmedAmountUsd: 0.05,
  }
  const first = service.start(input)
  await persistReady
  const second = service.start(input)
  let secondSettled = false
  void second.then(() => { secondSettled = true }, () => { secondSettled = true })
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  assert.equal(secondSettled, false)
  releasePersist()
  await Promise.all([
    assert.rejects(first, /deferred enqueue failure/),
    assert.rejects(second, /deferred enqueue failure/),
  ])
  assert.equal(jobs.all().length, 0)
})

test('optional image/video/PDF inputs survive draft quote and the tested model is frozen in the job', async t => {
  const draft = nanoBananaEditDraft()
  const { service, file, jobs, library, enqueueCount } = await harness(t, draft)
  const imageRef = { kind: 'image' as const, src: '/media/reference.png' }
  const videoRef = { kind: 'video' as const, src: '/media/context.mp4' }
  assert.equal(library.view().drafts.find(item => item.id === draft.id)?.conditionalReferenceRequirement, 'image-or-video-or-pdf')
  const restored = new CatalogLibrary(file, CATALOG)
  await restored.load()
  assert.equal(restored.view().drafts.find(item => item.id === draft.id)?.conditionalReferenceRequirement, 'image-or-video-or-pdf')

  await assert.rejects(
    service.quote(draft.id, {}, []),
    /add an image, video, or PDF/i,
  )
  await assert.rejects(
    service.start({ draftId: draft.id, prompt: 'Контекст', refs: [], params: {}, idempotencyKey: 'nano-empty' }),
    /add an image, video, or PDF/i,
  )
  assert.equal(enqueueCount(), 0, 'empty conditional input is rejected before enqueue')

  for (const candidate of [
    { refs: [imageRef], params: {} },
    { refs: [videoRef], params: {} },
    { refs: [], params: { pdf_url: 'https://example.com/context.pdf' } },
  ]) {
    const quote = await service.quote(draft.id, candidate.params, candidate.refs)
    assert.equal(quote.amountUsd, 0.08)
  }
  for (const [alias, idempotencyKey] of [
    ['document_url', 'nano-document-alias'],
    ['custom__pdf_url', 'nano-custom-pdf-alias'],
  ] as const) {
    const params = { [alias]: 'https://example.com/context.pdf' }
    await assert.rejects(
      service.quote(draft.id, params, []),
      /Parameter|add an image, video, or PDF/i,
    )
    await assert.rejects(
      service.start({ draftId: draft.id, prompt: 'Контекст', refs: [], params, idempotencyKey }),
      /Parameter|add an image, video, or PDF/i,
    )
  }
  assert.equal(enqueueCount(), 0, 'unsupported PDF aliases are rejected before enqueue')

  const quote = await service.quote(draft.id, {}, [imageRef])
  const job = await service.start({
    draftId: draft.id,
    prompt: 'Отредактируй изображение',
    refs: [imageRef],
    params: {},
    idempotencyKey: 'nano-edit-image',
    confirmedAmountUsd: quote.amountUsd,
  })
  assert.deepEqual(job.refs, [imageRef])
  assert.equal(job.modelSnapshot?.endpoint, draft.endpoint)
  assert.equal(job.modelSnapshot?.imageInputField, 'image_urls')
  assert.equal(job.modelSnapshot?.minImageRefs, 0)
  assert.equal(job.modelSnapshot?.videoInputField, 'video_url')
  assert.equal(job.modelSnapshot?.minVideoRefs, 0)
  assert.equal(job.modelSnapshot?.params?.find(param => param.name === 'resolution')?.default, '1K')

  const detachedDraft = library.view().drafts.find(item => item.id === draft.id)!
  detachedDraft.params!.find(param => param.name === 'resolution')!.default = '4K'
  assert.equal(job.modelSnapshot?.params?.find(param => param.name === 'resolution')?.default, '1K')

  job.status = 'done'
  job.result = { url: '/media/test-result.png', mime: 'image/png' }
  job.finishedAt = Date.now()
  await jobs.persistNow()
  await service.status(draft.id, job.id)

  const receiptView = library.view()
  assert.equal(receiptView.draftMeta[draft.id]?.test?.jobId, job.id)
  await library.publish(draft.id, receiptView.revision)
  assert.equal(library.view().drafts.some(item => item.id === draft.id), false)
  assert.equal(library.view().models.some(item => item.id === draft.id), true)
})

test('changing the conditional input contract invalidates an old draft test receipt', async t => {
  const draft = nanoBananaEditDraft()
  const { service, jobs, library } = await harness(t, draft)
  const imageRef = { kind: 'image' as const, src: '/media/reference.png' }
  const quote = await service.quote(draft.id, {}, [imageRef])
  const job = await service.start({
    draftId: draft.id,
    prompt: 'Проверка контракта',
    refs: [imageRef],
    params: {},
    idempotencyKey: 'nano-contract-before-change',
    confirmedAmountUsd: quote.amountUsd,
  })
  job.status = 'done'
  job.result = { url: '/media/test-result.png', mime: 'image/png' }
  job.finishedAt = Date.now()
  await jobs.persistNow()
  await service.status(draft.id, job.id)

  const before = library.view()
  const beforeMeta = before.draftMeta[draft.id]
  assert.ok(beforeMeta?.test)
  assert.equal(beforeMeta?.test?.definitionHash, beforeMeta?.definitionHash)
  const changed = structuredClone(before.drafts.find(item => item.id === draft.id)!)
  changed.conditionalReferenceRequirement = undefined
  await library.saveDraft(changed, before.revision)

  const after = library.view()
  assert.notEqual(after.draftMeta[draft.id]?.definitionHash, beforeMeta?.definitionHash)
  assert.equal(after.draftMeta[draft.id]?.test, undefined)
  assert.ok(after.draftMeta[draft.id]?.testInvalidatedAt)
  await assert.rejects(
    library.publish(draft.id, after.revision),
    /schema or pricing changed/i,
  )
})

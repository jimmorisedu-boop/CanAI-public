import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CatalogLibrary, CatalogLibraryError } from './catalogLibrary.js'
import { catalogLibraryErrorResponse } from './catalogLibraryRoutes.js'
import { CATALOG } from './catalog.js'
import { CatalogDraftTestService } from './catalogDraftTests.js'
import { JobStore } from './jobs.js'

async function approveDraft(library: CatalogLibrary, id: string): Promise<void> {
  await library.updateDraftTariff(id, {
    pricing: { unit: 'image', usd: 0.1 },
    tariffSourceUrl: `https://fal.ai/models/vendor/${id}`,
  }, library.view().revision)
  const meta = library.view().draftMeta[id]!
  await library.recordDraftTest(id, {
    jobId: `test-${id}`,
    completedAt: Date.now(),
    resultKind: 'image',
    actualCostUsd: null,
    definitionHash: meta.definitionHash!,
    tariffHash: meta.tariffHash!,
  }, library.view().revision)
}

test('catalog route exposes known client errors and hides unexpected details', () => {
  assert.deepEqual(catalogLibraryErrorResponse(new Error('C:\\private\\catalog.json')), {
    status: 500, body: { error: 'Could not complete the model-catalog operation' },
  })
  assert.deepEqual(catalogLibraryErrorResponse(new CatalogLibraryError('конфликт', 409)), {
    status: 409, body: { error: 'конфликт' },
  })
  assert.equal(catalogLibraryErrorResponse(new CatalogLibraryError('неверное поле')).status, 400)
})

test('archive retains model definition and extensions survive a refreshed snapshot', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const library = new CatalogLibrary(path.join(dir, 'catalog.json'), CATALOG)
  await library.load()
  await library.setLifecycle('grok-image', 'archived', 0)
  assert.equal(library.models().find(m => m.id === 'grok-image')?.lifecycle, 'archived')
  assert.ok(library.models().find(m => m.id === 'grok-image')?.params?.length)
  const fresh = new CatalogLibrary(path.join(dir, 'catalog.json'), CATALOG)
  await fresh.load()
  assert.equal(fresh.models().find(m => m.id === 'grok-image')?.lifecycle, 'archived')
  await assert.rejects(fresh.setLifecycle('grok-image', 'active', 0), /Catalog changed/)
})

test('custom model requires a checked draft and does not replace built-in definitions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const library = new CatalogLibrary(path.join(dir, 'catalog.json'), CATALOG)
  await library.load()
  const model = { id: 'user-test', name: 'Моя модель', kind: 'image' as const, endpoint: 'fal-ai/test-model', params: [] }
  await library.saveDraft(model, 0)
  assert.equal(library.models().some(m => m.id === model.id), false)
  await approveDraft(library, model.id)
  await library.publish(model.id, library.view().revision)
  assert.equal(library.models().some(m => m.id === model.id), true)
  const restored = new CatalogLibrary(path.join(dir, 'catalog.json'), [...CATALOG])
  await restored.load()
  assert.equal(restored.models().some(m => m.id === model.id), true)
  await assert.rejects(restored.saveDraft({ ...model, id: 'grok-image' }, restored.view().revision), /user-/)
  await assert.rejects(restored.saveDraft({ ...model, endpoint:'fal-ai/different-model' }, restored.view().revision), /new ID/)
})

test('custom drafts reject endpoints already used by bundled models, including fal URLs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const library = new CatalogLibrary(path.join(dir, 'catalog.json'), CATALOG)
  await library.load()
  await assert.rejects(
    library.saveDraft({
      id: 'user-duplicate-endpoint', name: 'Дубликат', kind: 'image',
      endpoint: 'https://fal.ai/models/fal-ai/nano-banana-2', params: [],
    }, 0),
    /endpoint is already in the library/,
  )
  const published = { id: 'user-published-endpoint', name: 'Опубликованная', kind: 'image' as const, endpoint: 'vendor/published', params: [] }
  await library.saveDraft(published, 0)
  await approveDraft(library, published.id)
  await library.publish(published.id, library.view().revision)
  await assert.rejects(
    library.saveDraft({ ...published, id: 'user-second-published', endpoint: 'https://www.fal.ai/models/vendor/published' }, library.view().revision),
    /endpoint is already in the library/,
  )
})

test('manual video and audio reference drafts pass their explicit input contracts', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const library = new CatalogLibrary(path.join(dir, 'catalog.json'), CATALOG)
  await library.load()
  await library.saveDraft({
    id: 'user-video-ref', name: 'Видео по референсу', kind: 'video', endpoint: 'vendor/video-edit',
    refs: true, videoRefs: true, videoInputField: 'video_url', params: [],
  }, 0)
  await library.saveDraft({
    id: 'user-audio-ref', name: 'Аудио по референсу', kind: 'audio', endpoint: 'vendor/audio-edit',
    refs: true, audioInputField: 'audio_url', params: [],
  }, 1)
  assert.equal(library.view().drafts.length, 2)
  assert.equal(library.view().drafts[0].maxVideoRefs, 1)
  assert.equal(library.view().drafts[1].maxAudioRefs, 1)
  await assert.rejects(library.saveDraft({
    id:'user-invalid-video', name:'Неверные входы', kind:'video', endpoint:'vendor/invalid-video',
    refs:true,videoRefs:true,videoInputField:'video_url',minVideoRefs:2,params:[],
  },2),/reference count/)
})

test('v1 catalog gains deterministic defaults without changing old collections', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const file = path.join(dir, 'catalog.json')
  await fs.writeFile(file, JSON.stringify({
    revision: 7,
    lifecycle: {},
    drafts: [],
    extensions: [],
  }))

  const library = new CatalogLibrary(file, CATALOG)
  await library.load('claude')

  assert.deepEqual(library.view().defaults, {
    image: 'chatgpt-image-2',
    video: 'seedance-2',
    audio: 'sam-audio-separate',
    assistant: 'claude',
  })
  const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as {
    schemaVersion?: number
    revision: number
    drafts: unknown[]
    extensions: unknown[]
  }
  assert.equal(persisted.schemaVersion, 2)
  assert.equal(persisted.revision, 8)
  assert.deepEqual(persisted.drafts, [])
  assert.deepEqual(persisted.extensions, [])
})

test('defaults accept only active compatible base models', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const library = new CatalogLibrary(path.join(dir, 'catalog.json'), CATALOG)
  await library.load()

  await assert.rejects(
    library.setDefaults({ video: 'chatgpt-image-2' }, 0),
    /video/,
  )
  await library.setLifecycle('seedance-2', 'archived', 0)
  await assert.rejects(
    library.setDefaults({ video: 'seedance-2' }, 1),
    /active model/,
  )
})

test('draft tariff is normalized into the flat model and records its official source', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const library = new CatalogLibrary(path.join(dir, 'catalog.json'), CATALOG)
  await library.load()
  await library.saveDraft({
    id: 'user-priced', name: 'Платная модель', kind: 'image', endpoint: 'vendor/priced', params: [],
  }, 0)

  await library.updateDraftTariff('user-priced', {
    pricing: { unit: 'image', usd: 0.125 },
    tariffSourceUrl: 'https://fal.ai/models/vendor/priced',
  }, 1)

  const view = library.view()
  assert.deepEqual(view.drafts[0].pricing, { unit: 'image', usd: 0.125 })
  assert.equal(view.draftMeta['user-priced'].tariffSourceUrl, 'https://fal.ai/models/vendor/priced')
  assert.ok(view.draftMeta['user-priced'].tariffConfirmedAt)
  assert.match(view.draftMeta['user-priced'].definitionHash ?? '', /^[a-f0-9]{64}$/)
  assert.match(view.draftMeta['user-priced'].tariffHash ?? '', /^[a-f0-9]{64}$/)

  await assert.rejects(
    library.updateDraftTariff('user-priced', {
      pricing: { unit: 'image', usd: 0.2 },
      tariffSourceUrl: 'https://example.com/vendor/priced',
    }, 2),
    /fal\.ai/,
  )
})

test('draft tariff accepts the official fal API source and keeps the setup note', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const library = new CatalogLibrary(path.join(dir, 'catalog.json'), CATALOG)
  await library.load()
  await library.saveDraft({
    id: 'user-api-priced', name: 'API price', kind: 'image', endpoint: 'vendor/api-priced', params: [],
  }, 0)

  await library.updateDraftTariff('user-api-priced', {
    pricing: { unit: 'image', usd: 0.08 },
    tariffSourceUrl: 'https://api.fal.ai/v1/models/pricing?endpoint_id=vendor%2Fapi-priced',
    pricingNote: 'Тариф подтверждён официальным API fal.',
  }, 1)

  const view = library.view()
  assert.equal(view.draftMeta['user-api-priced'].tariffSourceUrl, 'https://api.fal.ai/v1/models/pricing?endpoint_id=vendor%2Fapi-priced')
  assert.equal(view.drafts[0].pricingNote, 'Тариф подтверждён официальным API fal.')
})

test('lifecycle and required default replacement share one catalog revision', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const library = new CatalogLibrary(path.join(dir, 'catalog.json'), CATALOG)
  await library.load()

  await library.applyLifecycleChange(
    'chatgpt-image-2',
    'archived',
    { image: 'grok-image' },
    0,
  )

  const view = library.view()
  assert.equal(view.revision, 1)
  assert.equal(view.defaults.image, 'grok-image')
  assert.equal(view.models.find(model => model.id === 'chatgpt-image-2')?.lifecycle, 'archived')
  assert.equal(view.models.find(model => model.id === 'chatgpt-image-2-edit')?.lifecycle, 'archived')
})

test('publish rejects a missing or stale successful paid test', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const library = new CatalogLibrary(path.join(dir, 'catalog.json'), CATALOG)
  await library.load()
  await library.saveDraft({
    id: 'user-tested', name: 'Проверяемая', kind: 'image', endpoint: 'vendor/tested', params: [],
  }, 0)
  await library.updateDraftTariff('user-tested', {
    pricing: { unit: 'image', usd: 0.1 },
    tariffSourceUrl: 'https://fal.ai/models/vendor/tested',
  }, 1)

  await assert.rejects(library.publish('user-tested', 2), /paid model test/)
  await library.recordDraftTest('user-tested', {
    jobId: 'job-stale',
    completedAt: Date.now(),
    resultKind: 'image',
    actualCostUsd: null,
    definitionHash: 'a'.repeat(64),
    tariffHash: 'b'.repeat(64),
  }, 2)
  await assert.rejects(library.publish('user-tested', 3), /schema or pricing changed/)
})

test('changing a tested tariff invalidates publication with a conflict', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const library = new CatalogLibrary(path.join(dir, 'catalog.json'), CATALOG)
  await library.load()
  await library.saveDraft({
    id: 'user-retariff', name: 'Тариф', kind: 'image', endpoint: 'vendor/retariff', params: [],
  }, 0)
  await approveDraft(library, 'user-retariff')
  await library.updateDraftTariff('user-retariff', {
    pricing: { unit: 'image', usd: 0.2 },
    tariffSourceUrl: 'https://fal.ai/models/vendor/retariff',
  }, library.view().revision)

  await assert.rejects(
    library.publish('user-retariff', library.view().revision),
    (error: unknown) => error instanceof CatalogLibraryError && error.status === 409 && /schema or pricing changed/.test(error.message),
  )
})

test('v1 migration, paid draft test and local defaults survive a full restart', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-catalog-restart-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const catalogFile = path.join(dir, 'catalog-library.json')
  const settingsFile = path.join(dir, 'settings.json')
  const jobsFile = path.join(dir, 'jobs.json')
  await fs.writeFile(catalogFile, JSON.stringify({ revision: 3, lifecycle: {}, drafts: [], extensions: [] }))
  await fs.writeFile(settingsFile, JSON.stringify({ assistantModelId: 'claude' }))
  const legacy = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as { assistantModelId: string }

  const library = new CatalogLibrary(catalogFile, CATALOG)
  await library.load(legacy.assistantModelId)
  const draft = {
    id: 'user-restart-model', name: 'Restart model', kind: 'image' as const,
    endpoint: 'vendor/restart-model', refs: false, params: [],
  }
  await library.saveDraft(draft, library.view().revision)
  await library.updateDraftTariff(draft.id, {
    pricing: { unit: 'image', usd: 0.075 },
    tariffSourceUrl: 'https://fal.ai/models/vendor/restart-model',
  }, library.view().revision)

  const firstJobs = new JobStore(jobsFile)
  const firstService = new CatalogDraftTestService(library, firstJobs, {
    getConfirmCostAboveUsd: async () => 0.01,
    generationRoute: () => 'mock',
    persistAndEnqueue: async () => { await firstJobs.persistNow() },
  })
  const started = await firstService.start({
    draftId: draft.id,
    prompt: 'restart test',
    refs: [],
    params: {},
    idempotencyKey: 'restart-attempt-1',
    confirmedAmountUsd: 0.075,
  })

  const restoredJobs = new JobStore(jobsFile)
  const active = await restoredJobs.restore()
  assert.equal(active.map(job => job.id).includes(started.id), true)
  const restored = restoredJobs.get(started.id)!
  assert.equal(restored.modelSnapshot?.endpoint, draft.endpoint)
  restored.status = 'done'
  restored.result = { url: '/media/restart-result.png', mime: 'image/png' }
  restored.finishedAt = Date.now()
  await restoredJobs.persistNow()
  const restoredService = new CatalogDraftTestService(library, restoredJobs, {
    getConfirmCostAboveUsd: async () => 0.01,
    generationRoute: () => 'mock',
    persistAndEnqueue: async () => { await restoredJobs.persistNow() },
  })
  await restoredService.status(draft.id, restored.id)
  await library.publish(draft.id, library.view().revision)
  await library.setDefaults({ image: draft.id }, library.view().revision)

  const fresh = new CatalogLibrary(catalogFile, CATALOG)
  await fresh.load()
  const view = fresh.view()
  const published = view.models.find(model => model.id === draft.id)
  assert.equal(published?.endpoint, draft.endpoint)
  assert.deepEqual(published?.pricing, { unit: 'image', usd: 0.075 })
  assert.equal(published?.lifecycle, 'active')
  assert.equal(view.defaults.image, draft.id)
  assert.equal(view.defaults.assistant, 'claude')
  assert.equal(view.drafts.some(model => model.id === draft.id), false)
  assert.ok(view.revision > 3)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import type { CatalogDraftSetupResponse, CatalogModel, DraftTariffInput, DraftTestInput, GenRef } from '../types.js'
import {
  compactRefs,
  deliveredTestResult,
  existingTestAttemptKey,
  initialWizardState,
  positiveFiniteRate,
  persistedTestReceipt,
  reduceWizard,
  refsMeetMinimum,
  requiredRefs,
  setupPricingReady,
  setupTariffReady,
  supportedReferenceSlots,
  tariffUnitForKind,
  tariffUnitLabel,
  testAttemptFingerprint,
  type WizardState,
} from './FalModelWizard.js'
import { quoteConfirmationRequest } from '../ui/quotePresentation.js'

const draft: CatalogModel = {
  id: 'user-test', name: 'Test', endpoint: 'vendor/test', kind: 'image', refs: false, params: [],
}
const pricing: DraftTariffInput = {
  pricing: { unit: 'image', usd: 0.04 },
  tariffSourceUrl: 'https://fal.ai/models/vendor/test',
}

test('wizard invalidates success when tariff changes', () => {
  const testedState: WizardState = {
    ...initialWizardState(), step: 'ready', draft, tariff: pricing,
    test: {
      jobId: 'job-1', completedAt: 1, resultKind: 'image', actualCostUsd: 0.04,
      definitionHash: 'definition', tariffHash: 'tariff',
    },
  }
  const next = reduceWizard(testedState, {
    type: 'tariffChanged',
    pricing: { ...pricing, pricing: { unit: 'image', usd: 0.05 } },
  })
  assert.equal(next.step, 'tariff')
  assert.equal(next.test, null)
})

test('new test attempt receives one stable idempotency key', () => {
  const state = { ...initialWizardState(), step: 'inputs' as const, draft, tariff: pricing }
  const first = reduceWizard(state, { type: 'testStarted', jobId: 'job-1', idempotencyKey: 'attempt-1' })
  const retry = reduceWizard(first, { type: 'testStarted', jobId: 'job-1', idempotencyKey: 'attempt-1' })
  assert.equal(first.idempotencyKey, 'attempt-1')
  assert.equal(retry.idempotencyKey, 'attempt-1')
})

test('test attempt reserves its idempotency key before the start request', () => {
  const source = fs.readFileSync(new URL('./FalModelWizard.tsx', import.meta.url), 'utf8')
  assert.match(source, /testAttemptReserved/)
  assert.match(source, /existingTestAttemptKey\(state, fingerprint\) \?\? newId\(\)/)
})

test('test attempt retries only the same payload and clears terminal intents', () => {
  const input: DraftTestInput = {
    prompt: 'Протестируй модель', params: { resolution: '1K' },
    refs: [{ kind: 'image', src: '/media/reference.png' }],
  }
  const fingerprint = testAttemptFingerprint(draft.id, input, pricing)
  const reserved = reduceWizard(
    { ...initialWizardState(), step: 'inputs' as const, draft, tariff: pricing },
    { type: 'testAttemptReserved', idempotencyKey: 'attempt-1', fingerprint },
  )
  assert.equal(existingTestAttemptKey(reserved, fingerprint), 'attempt-1')
  assert.equal(existingTestAttemptKey(reserved, testAttemptFingerprint(draft.id, { ...input, prompt: 'Другой prompt' }, pricing)), null)
  assert.notEqual(testAttemptFingerprint(draft.id, input, { ...pricing, pricing: { unit: 'image', usd: 0.05 } }), fingerprint)

  const retryable = reduceWizard(reserved, { type: 'testFailed', preserveAttempt: true })
  assert.equal(retryable.idempotencyKey, 'attempt-1')
  const terminal = reduceWizard(reserved, { type: 'testFailed' })
  assert.equal(terminal.idempotencyKey, null)
  assert.equal(terminal.idempotencyFingerprint, null)
  const completed = reduceWizard(reserved, {
    type: 'testCompleted',
    receipt: { jobId: 'job-1', completedAt: 1, resultKind: 'image', actualCostUsd: 0.04, definitionHash: 'd', tariffHash: 't' },
    result: { url: '/media/result.png' },
  })
  assert.equal(completed.idempotencyKey, null)
  assert.equal(completed.idempotencyFingerprint, null)
  const retry = reduceWizard(completed, { type: 'retryTest' })
  assert.equal(retry.step, 'inputs')
  assert.equal(retry.test, null)
  assert.equal(retry.result, null)
})

test('wizard uses the shared quote confirmation and has no free-form JSON escape hatch', () => {
  const source = fs.readFileSync(new URL('./FalModelWizard.tsx', import.meta.url), 'utf8')
  assert.match(source, /quoteConfirmationRequest/)
  assert.match(source, /newId\(\)/)
  assert.match(source, /https:\/\/fal\.ai\/models/)
  assert.match(source, />Add model<\/button>/)
  assert.doesNotMatch(source, />Read schema<\/button>/)
  assert.doesNotMatch(source, /Custom parameter description|JSON/)
})

test('optional image and video inputs stay visible when fal reports min=0', () => {
  const optional: CatalogModel = {
    ...draft,
    refs: true,
    imageInputField: 'image_urls', maxImageRefs: 16, minImageRefs: 0,
    videoRefs: true, videoInputField: 'video_url', maxVideoRefs: 1, minVideoRefs: 0,
  }
  assert.deepEqual(requiredRefs(optional), [])
  assert.deepEqual(supportedReferenceSlots(optional), [
    { kind: 'image', required: false },
    { kind: 'video', required: false },
  ])
})

test('conditional image input requires image, video, or PDF context', () => {
  const conditional: CatalogModel = {
    ...draft, endpoint: 'google/nano-banana-2.1/edit', refs: true,
    imageInputField: 'image_urls', maxImageRefs: 16, minImageRefs: 0,
    videoRefs: true, videoInputField: 'video_url', maxVideoRefs: 1, minVideoRefs: 0,
    params: [{ name: 'pdf_url', label: 'PDF URL', widget: 'textarea' }],
  }
  const issue = 'Схема: image_urls можно не указывать только при наличии video_url или pdf_url.'
  assert.equal(refsMeetMinimum(conditional, [], {}, [issue]), false)
  assert.equal(refsMeetMinimum(conditional, [{ kind: 'video', src: '/media/context.mp4' }], {}, [issue]), true)
  assert.equal(refsMeetMinimum(conditional, [], { pdf_url: 'https://example.test/context.pdf' }, [issue]), true)
})

test('mandatory minimums block empty refs but accept the uploaded kind', () => {
  const mandatory: CatalogModel = { ...draft, refs: true, imageInputField: 'image_url', minImageRefs: 1, maxImageRefs: 1 }
  assert.equal(refsMeetMinimum(mandatory, []), false)
  assert.equal(refsMeetMinimum(mandatory, [{ kind: 'image', src: '/media/a.png' }]), true)
  assert.equal(refsMeetMinimum(mandatory, [{ kind: 'video', src: '/media/a.mp4' }]), false)
})

test('optional replacement/removal compacts refs without preserving array holes', () => {
  const first: GenRef = { kind: 'image', src: '/media/one.png' }
  const second: GenRef = { kind: 'image', src: '/media/two.png' }
  assert.deepEqual(compactRefs([first, null, second]), [first, second])
  assert.deepEqual(compactRefs([null, second, null]), [second])
})

test('tariff validation requires positive finite amounts', () => {
  assert.equal(positiveFiniteRate('0.08'), true)
  assert.equal(positiveFiniteRate(0), false)
  assert.equal(positiveFiniteRate('NaN'), false)
  assert.equal(positiveFiniteRate(Number.POSITIVE_INFINITY), false)
})

test('automatic setup requires a finite positive price and delivered result before publish', () => {
  assert.equal(setupPricingReady(null), false)
  assert.equal(setupPricingReady({ sourceUrl: 'https://fal.ai/models/vendor/test', note: 'estimate', amountUsd: 0.04, approximate: true }), true)
  assert.equal(setupPricingReady({ sourceUrl: '', note: 'estimate', amountUsd: 0.04, approximate: true }), false)
  const receipt = { resultKind: 'image' as const }
  assert.equal(deliveredTestResult(receipt, { url: '/media/result.png' }), true)
  assert.equal(deliveredTestResult(receipt, { url: '/media/wrong.mp4', mime: 'video/mp4' }), false)
  assert.equal(deliveredTestResult(receipt, null), false)
  assert.equal(deliveredTestResult({ resultKind: 'text' }, { url: '/media/wrong.png' }), false)
  assert.equal(deliveredTestResult({ resultKind: 'text' }, { text: 'готово' }), true)
})

test('approximate setup pricing uses an honest estimated confirmation', () => {
  const request = quoteConfirmationRequest({
    amountUsd: 0.042,
    model: 'Nano Banana',
    quantity: 1,
    quantityLabel: 'Тестовых запусков',
    pricingMode: 'fal-metered',
    meteredUncapped: true,
    guaranteed: false,
  })
  assert.equal(request.title, 'Run for about $0.042?')
  assert.equal(request.confirmLabel, 'Run for about $0.042')
  assert.match(request.detail ?? '', /actual generation cost/u)
})

test('automatic setup only enables a test after the server persisted tariff hashes', () => {
  const setup = {
    pricing: { sourceUrl: 'https://fal.ai/models/vendor/test', note: 'call estimate', amountUsd: 0.04, approximate: true, unit: 'call' },
    library: { draftMeta: { 'user-test': { tariffConfirmedAt: 1, definitionHash: 'd', tariffHash: 't' } } },
  } as unknown as CatalogDraftSetupResponse
  assert.equal(setupTariffReady(setup, 'user-test'), true)
  assert.equal(setupTariffReady(setup, 'other'), false)
  assert.equal(setupTariffReady({ ...setup, library: { draftMeta: { 'user-test': {} } } } as unknown as CatalogDraftSetupResponse, 'user-test'), false)
})

test('automatic setup resumes only a persisted test whose schema and tariff hashes still match', () => {
  const receipt = {
    jobId: 'job-existing', completedAt: 1, resultKind: 'image' as const,
    actualCostUsd: 0.04, definitionHash: 'definition', tariffHash: 'tariff',
  }
  const setup = {
    library: { draftMeta: {
      'user-test': { definitionHash: 'definition', tariffHash: 'tariff', test: receipt },
    } },
  } as unknown as CatalogDraftSetupResponse
  assert.deepEqual(persistedTestReceipt(setup, 'user-test'), receipt)
  assert.equal(persistedTestReceipt(setup, 'other'), null)
  assert.equal(persistedTestReceipt({
    ...setup,
    library: { draftMeta: { 'user-test': { definitionHash: 'changed', tariffHash: 'tariff', test: receipt } } },
  } as unknown as CatalogDraftSetupResponse, 'user-test'), null)
})

test('tariff defaults to per-result for non-video media and labels seconds by media', () => {
  assert.equal(tariffUnitForKind('video'), 'second')
  assert.equal(tariffUnitForKind('image'), 'image')
  assert.equal(tariffUnitForKind('audio'), 'image')
  assert.equal(tariffUnitForKind('other'), 'image')
  assert.equal(tariffUnitLabel('video', 'second'), 'Per video second')
  assert.equal(tariffUnitLabel('audio', 'second'), 'Per second')
  assert.equal(tariffUnitLabel('other', 'second'), 'Per second')
})

test('wizard presents three simple stages and keeps technical details collapsed', () => {
  const source = fs.readFileSync(new URL('./FalModelWizard.tsx', import.meta.url), 'utf8')
  assert.match(source, /Link/)
  assert.match(source, /Test/)
  assert.match(source, /Prepare test/)
  assert.doesNotMatch(source, /Setup and test/)
  assert.match(source, /Add/)
  assert.match(source, /settings-technical fal-wizard-details/)
  assert.match(source, /Test model/)
  assert.match(source, /Preparing test/)
  assert.match(source, /Edit test/)
  assert.match(source, /fal-wizard-test-overview/)
  assert.match(source, /fal-wizard-actions/)
  assert.doesNotMatch(source, /Источник тарифа\s*\n?\s*<input/)
  assert.doesNotMatch(source, /Цена, \$ за единицу|Вход, \$ за 1 млн токенов|value=\{unit\}/)
  assert.match(source, /The price will be recalculated before confirmation/)
  assert.match(source, /formatExactUsd/)
})

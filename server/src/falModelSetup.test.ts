import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareFalModelSetup, falModelSetupInternals, type FalModelTestSamples } from './falModelSetup.js'
import type { CatalogModel } from './catalog.js'

const imageModel = (overrides: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'user-setup-image',
  name: 'Setup image',
  kind: 'image',
  endpoint: 'vendor/setup-image',
  promptInputField: 'prompt',
  params: [{ name: 'resolution', label: 'Resolution', widget: 'select', options: ['1K', '2K'].map(value => ({ value, label: value })), default: '1K' }],
  ...overrides,
})

const samples = (refs: FalModelTestSamples['input']['refs'] = []): FalModelTestSamples => ({
  input: { prompt: 'setup prompt', refs, params: { resolution: '1K' } },
  samples: refs.map((ref, index) => ({
    kind: ref.kind === 'text' ? 'image' : ref.kind,
    name: `sample-${index}`,
    url: ref.kind === 'text' || typeof ref.src !== 'string' ? '/media/sample.jpg' : ref.src,
  })),
})

test('setup accepts an authenticated image unit price without queueing a generation', async () => {
  const calls: Array<{ url: string; method: string; authorization?: string }> = []
  const result = await prepareFalModelSetup(imageModel(), {
    falKey: 'secret-test-key',
    buildSamples: async () => samples([{ kind: 'image', src: '/media/flower.jpg' }]),
    fetcher: async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method ?? 'GET'), authorization: new Headers(init?.headers).get('authorization') ?? undefined })
      return new Response(JSON.stringify({ prices: [{ endpoint_id: 'vendor/setup-image', unit_price: 0.08, unit: 'image', currency: 'USD' }] }), { status: 200 })
    },
  })
  assert.equal(result.pricing?.amountUsd, 0.08)
  assert.equal(result.pricing?.approximate, true, 'API отдаёт базовый тариф, а не гарантированную сумму для любых параметров')
  assert.equal(result.persist?.pricing?.unit, 'image')
  assert.equal(result.persist?.pricing?.usd, 0.08)
  assert.deepEqual(calls, [{
    url: 'https://api.fal.ai/v1/models/pricing?endpoint_id=vendor%2Fsetup-image',
    method: 'GET',
    authorization: 'Key secret-test-key',
  }])
})

test('second unit setup displays the same duration amount that the draft quote will confirm', async () => {
  const model = imageModel({
    kind: 'video',
    endpoint: 'vendor/setup-video',
    params: [{ name: 'duration', label: 'Duration', widget: 'number', default: 4 }],
  })
  const result = await prepareFalModelSetup(model, {
    falKey: 'secret-test-key',
    buildSamples: async () => samples(),
    fetcher: async () => new Response(JSON.stringify({ prices: [{ endpoint_id: 'vendor/setup-video', unit_price: 0.1, unit: 'seconds', currency: 'USD' }] }), { status: 200 }),
  })
  assert.equal(result.pricing?.unit, 'second')
  assert.equal(result.pricing?.amountUsd, 0.4)
  assert.equal(result.persist?.pricing?.unit, 'second')
})

test('Krea 3 edit prepares a megapixel quote even when fal has no historical call price', async () => {
  const model = imageModel({
    endpoint: 'krea/v3/edit',
    params: [{ name: 'reasoning_level', label: 'Reasoning', widget: 'select', default: 'low', options: ['low', 'medium', 'high'].map(value => ({ value, label: value })) }],
  })
  const requests: string[] = []
  const result = await prepareFalModelSetup(model, {
    falKey: 'test-key',
    buildSamples: async () => ({ ...samples([{ kind: 'image', src: '/media/flower.jpg' }]), input: { prompt: 'Edit flowers', refs: [{ kind: 'image', src: '/media/flower.jpg' }], params: { reasoning_level: 'low' } } }),
    fetcher: async (_url, init) => {
      requests.push(String(init?.method ?? 'GET'))
      return new Response(JSON.stringify(init?.method === 'POST'
        ? { estimate_type: 'historical_api_price', total_cost: 0, currency: 'USD' }
        : { prices: [{ endpoint_id: model.endpoint, unit_price: 0.025, unit: 'megapixels', currency: 'USD' }] }))
    },
  })
  const maxOutputCost = 4_220_160 / (1024 * 1024) * 0.025
  assert.equal(result.pricing?.amountUsd, Math.round(2 * maxOutputCost * 1_000_000) / 1_000_000)
  assert.equal(result.pricing?.approximate, true)
  assert.equal(result.persist?.pricing?.unit, 'image')
  assert.equal(result.persist?.pricing?.usd, maxOutputCost)
  assert.equal(result.persist?.pricing?.perReferenceUsd, maxOutputCost)
  assert.deepEqual(result.persist?.pricing?.byParam, {
    name: 'reasoning_level', usd: { low: maxOutputCost, medium: maxOutputCost, high: maxOutputCost + 5 * 0.025 },
  })
  assert.match(result.pricing?.note ?? '', /megapixel.*upper estimate/i)
  assert.deepEqual(requests, ['GET'], 'Known Krea billing must not depend on account usage history')
})

test('unknown megapixel billing stays blocked when fal has no historical estimate', async () => {
  const result = await prepareFalModelSetup(imageModel(), {
    falKey: 'test-key', buildSamples: async () => samples(),
    fetcher: async (_url, init) => new Response(JSON.stringify(init?.method === 'POST'
      ? { estimate_type: 'historical_api_price', total_cost: 0, currency: 'USD' }
      : { prices: [{ endpoint_id: 'vendor/setup-image', unit_price: 0.025, unit: 'megapixels', currency: 'USD' }] })),
  })
  assert.equal(result.pricing, null)
  assert.equal(result.persist, undefined)
})

test('unsupported token pricing exposes an approximate call estimate without inventing media or token rates', async () => {
  const methods: string[] = []
  const result = await prepareFalModelSetup(imageModel({ kind: 'text', endpoint: 'vendor/setup-text' }), {
    falKey: 'secret-test-key',
    buildSamples: async () => samples(),
    fetcher: async (_url, init) => {
      methods.push(String(init?.method ?? 'GET'))
      if (init?.method === 'POST') return new Response(JSON.stringify({ estimate_type: 'historical_api_price', total_cost: 0.31, currency: 'USD' }), { status: 200 })
      return new Response(JSON.stringify({ prices: [{ endpoint_id: 'vendor/setup-text', unit_price: 1.76, unit: 'token', currency: 'USD' }] }), { status: 200 })
    },
  })
  assert.equal(result.pricing?.amountUsd, 0.31)
  assert.equal(result.pricing?.unit, 'call')
  assert.equal(result.pricing?.approximate, true)
  assert.equal(result.persist?.pricing?.unit, 'call')
  assert.equal(result.persist?.pricing?.usd, 0.31)
  assert.match(result.warnings.join(' '), /estimated price|call/i)
  assert.deepEqual(methods, ['GET', 'POST'])
})

test('text models never persist a media unit price as a fake token tariff', async () => {
  const result = await prepareFalModelSetup(imageModel({ kind: 'text', endpoint: 'vendor/text-media-price' }), {
    falKey: 'secret-test-key',
    buildSamples: async () => samples(),
    fetcher: async (_url, init) => init?.method === 'POST'
      ? new Response(JSON.stringify({ estimate_type: 'historical_api_price', total_cost: 0.2, currency: 'USD' }), { status: 200 })
      : new Response(JSON.stringify({ prices: [{ endpoint_id: 'vendor/text-media-price', unit_price: 0.04, unit: 'image', currency: 'USD' }] }), { status: 200 }),
  })
  assert.equal(result.persist?.pricing?.unit, 'call')
  assert.equal(result.pricing?.unit, 'call')
  assert.match(result.warnings.join(' '), /estimated price|call/i)
})

test('Nano Banana fallback parses the official resolution table and reference increment with no key', async () => {
  const html = '<table><tr><th>Output resolution</th><th>Text-to-image</th><th>Edit with two 1K input images</th></tr>'
    + '<tr><td>1K</td><td>$0.040</td><td>$0.044</td></tr>'
    + '<tr><td>2K</td><td>$0.059</td><td>$0.063</td></tr>'
    + '<tr><td>4K</td><td>$0.134</td><td>$0.138</td></tr></table>'
  const calls: string[] = []
  const model = imageModel({ id: 'user-nano', endpoint: 'google/nano-banana-2.1/edit', params: [{ name: 'resolution', label: 'Resolution', widget: 'select', options: ['1K', '2K', '4K'].map(value => ({ value, label: value })), default: '1K' }] })
  const result = await prepareFalModelSetup(model, {
    falKey: null,
    buildSamples: async () => samples([{ kind: 'image', src: '/media/flower.jpg' }]),
    fetcher: async url => { calls.push(String(url)); return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0], 'https://fal.ai/models/google/nano-banana-2.1/edit')
  assert.equal(result.pricing?.amountUsd, 0.042)
  assert.equal(result.pricing?.approximate, true)
  assert.equal(result.persist?.pricing?.byParam?.usd['1K'], 0.04)
  assert.equal(result.persist?.pricing?.byParam?.usd['4K'], 0.134)
  assert.equal(result.persist?.pricing?.perReferenceUsd, 0.002)
  assert.match(result.pricing?.note ?? '', /tokens/i)
})

test('non-Nano setup without a key does not make an external request or fabricate a tariff', async () => {
  let requested = false
  const result = await prepareFalModelSetup(imageModel(), {
    falKey: null,
    buildSamples: async () => samples(),
    fetcher: async () => { requested = true; return new Response('{}') },
  })
  assert.equal(requested, false)
  assert.equal(result.pricing, null)
  assert.equal(result.persist, undefined)
  assert.match(result.warnings.join(' '), /fal\.ai key|pricing/i)
})

test('configured key with unavailable pricing returns an actionable warning without a fake amount', async () => {
  const result = await prepareFalModelSetup(imageModel(), {
    falKey: 'secret-test-key',
    buildSamples: async () => samples(),
    fetcher: async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
  })
  assert.equal(result.pricing, null)
  assert.equal(result.persist, undefined)
  assert.match(result.warnings.join(' '), /pricing|try again/i)
})

test('Nano parser rejects unrelated dollar text and requires all canonical resolution rows', () => {
  const partial = '<p>Output resolution and a price of $0.040</p><table><tr><td>1K</td><td>$0.040</td><td>$0.044</td></tr></table>'
  assert.equal(falModelSetupInternals.parseNanoTable(partial), null)
  const inconsistent = '<p>Output resolution Text-to-image Edit with two 1K input images</p>'
    + '<table><tr><td>1K</td><td>$0.040</td><td>$0.044</td></tr>'
    + '<tr><td>2K</td><td>$0.059</td><td>$0.070</td></tr>'
    + '<tr><td>4K</td><td>$0.134</td><td>$0.138</td></tr></table>'
  assert.equal(falModelSetupInternals.parseNanoTable(inconsistent), null)
})

test('automatic prices never invent a currency or mistake unit totals for a per-call estimate', async () => {
  for (const body of [
    { estimate_type: 'historical_api_price', total_cost: 1 },
    { estimate_type: 'unit_price', total_cost: 1, currency: 'USD' },
    { estimate_type: 'historical_api_price', total_cost: 1, currency: 'EUR' },
  ]) {
    const result = await prepareFalModelSetup(imageModel(), {
      falKey: 'test-key', buildSamples: async () => samples(),
      fetcher: async (_url, init) => new Response(JSON.stringify(init?.method === 'POST'
        ? body : { prices: [{ endpoint_id: 'vendor/setup-image', unit_price: 1, unit: 'image' }] })),
    })
    assert.equal(result.pricing, null)
    assert.equal(result.persist, undefined)
  }
})

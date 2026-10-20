import test from 'node:test'
import assert from 'node:assert/strict'
import { modelExecutionError, validateModelParams } from './modelParams.js'
import { validateModelRefs } from './modelRefLimits.js'
import { CATALOG, replaceRuntimeCatalog, type CatalogModel } from './catalog.js'

test('imported provider model variants keep parameter and reference validation', () => {
  const previous = [...CATALOG]
  const model: CatalogModel = {
    id: 'user-krea-v3-edit', name: 'Krea 3 Edit', endpoint: 'krea/v3/edit', kind: 'image',
    refs: true, minImageRefs: 1, maxImageRefs: 8,
    params: [{ name: 'model', label: 'Model', widget: 'select', default: 'berry', options: ['berry', 'jam'].map(value => ({ value, label: value })) }],
  }
  const refs = [{ kind: 'image' as const, src: '/media/reference.png' }]
  try {
    replaceRuntimeCatalog([...previous, model])
    assert.equal(validateModelParams(model.id, 'image', refs, { model: 'berry' }), true)
    assert.equal(validateModelParams(model.id, 'image', refs, { model: 'jam' }), true)
    assert.equal(validateModelParams(model.id, 'image', refs, { model: 'unknown' }), false)
    assert.equal(validateModelParams(model.id, 'image', refs, { unexpected: true }), false)
    assert.ok(validateModelRefs(model.id, 'image', []), 'the imported reference requirement must still apply')
  } finally {
    replaceRuntimeCatalog(previous)
  }
})

test('unknown saved model and newer executor contract cannot silently fall back', () => {
  assert.equal(validateModelParams('deleted-model', 'image', [], {}), false)
  const model = CATALOG.find(m => m.id === 'grok-image')!
  const previous = model.minExecutorVersion
  try { model.minExecutorVersion = 999; assert.equal(validateModelParams(model.id, 'image', [], {}), false) }
  finally { model.minExecutorVersion = previous }
})

test('unknown model fields are rejected without mutating the request', () => {
  const params = { quality: 'high', misspelled_size: '4K' }
  assert.equal(validateModelParams('chatgpt-image-2', 'image', [], params), false)
  assert.deepEqual(params, { quality: 'high', misspelled_size: '4K' })
})

test('integer controls reject fractional requests before provider submission', () => {
  assert.equal(validateModelParams('chatgpt-image-2', 'image', [], { num_images: 1.5 }), false)
  assert.equal(validateModelParams('chatgpt-image-2', 'image', [], { num_images: 1 }), true)
})

test('compression is accepted only for the formats declared in the shared contract', () => {
  assert.equal(validateModelParams('gpt-image-2.5-flare', 'image', [], { output_compression: 90 }), false)
  assert.equal(validateModelParams('gpt-image-2.5-flare', 'image', [], { output_format: 'png', output_compression: 90 }), false)
  assert.equal(validateModelParams('gpt-image-2.5-flare', 'image', [], { output_format: 'webp', output_compression: 90 }), true)
})

test('new launches cannot switch an explicit model to an unrelated reference-capable family', () => {
  const refs = [{kind:'video' as const,src:'/media/clip.mp4'}]
  assert.match(validateModelRefs('minimax-h3', 'video', refs) ?? '', /video/)
  const model = CATALOG.find(m => m.id === 'minimax-h3')!
  const previous = model.lifecycle
  try { model.lifecycle='disabled'; assert.match(modelExecutionError(model.id,'video',refs) ?? '', /disabled/) }
  finally {model.lifecycle=previous}
})

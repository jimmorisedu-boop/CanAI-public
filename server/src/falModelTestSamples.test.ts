import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { prepareFalModelTestSamples, FAL_TEST_SAMPLE_FILES } from './falModelTestSamples.js'
import type { CatalogModel } from './catalog.js'

const model = (patch: Partial<CatalogModel> = {}): CatalogModel => ({ id: 'user-example', name: 'Пример', kind: 'image', endpoint: 'vendor/example', params: [], ...patch })
const save = async (sample: { file: string }) => `/media/${sample.file}`

test('bundled internet samples have the pinned content and portable relative paths', async () => {
  for (const sample of Object.values(FAL_TEST_SAMPLE_FILES)) {
    const bytes = await fs.readFile(new URL(`../fixtures/fal-wizard/${sample.file}`, import.meta.url))
    assert.ok(bytes.length > 10_000 && bytes.length < 2_000_000)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sample.hash)
  }
})
test('text-to-image setup needs no file while edit uses one image instead of optional video or PDF', async () => {
  assert.deepEqual((await prepareFalModelTestSamples(model(), save)).input.refs, [])
  const edit = await prepareFalModelTestSamples(model({ refs: true, imageInputField: 'image_urls', minImageRefs: 0, maxImageRefs: 14, videoInputField: 'video_url', maxVideoRefs: 1, conditionalReferenceRequirement: 'image-or-video-or-pdf' }), save)
  assert.deepEqual(edit.input.refs, [{ kind: 'image', src: '/media/flower.jpg' }])
  assert.equal(edit.samples[0].url, '/media/flower.jpg')
  assert.equal(edit.input.params.pdf_url, undefined)
})
test('mandatory video/audio and two-frame inputs receive suitable minimum files', async () => {
  const frames = await prepareFalModelTestSamples(model({ kind: 'video', refs: true, imageInputField: 'image_urls', minImageRefs: 2, maxImageRefs: 2 }), save)
  assert.deepEqual(frames.input.refs.map(ref => ref.kind === 'text' ? ref.text : ref.src), ['/media/flower.jpg', '/media/flower-end.jpg'])
  const audio = await prepareFalModelTestSamples(model({ kind: 'audio', audioInputField: 'audio_url', minAudioRefs: 1, maxAudioRefs: 1, videoInputField: 'video_url', maxVideoRefs: 1, audioRequiresVisualRef: true }), save)
  assert.deepEqual(audio.input.refs.map(ref => ref.kind), ['video', 'audio'])
})
test('provider defaults and no-prompt schemas survive setup without unrelated parameters', async () => {
  const ready = await prepareFalModelTestSamples(model({ promptInputField: null, params: [{ name: 'resolution', label: 'Размер', widget: 'select', default: '1K', options: [{ value: '1K', label: '1K' }] }, { name: 'num_images', label: 'Количество', widget: 'number', default: 4 }]}), save)
  assert.equal(ready.input.prompt, '')
  assert.deepEqual(ready.input.params, { resolution: '1K', num_images: 1 })
})

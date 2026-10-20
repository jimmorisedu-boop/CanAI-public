import test from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG, resolveModel } from './catalog.js'
import { prepareImageParams } from './imageParams.js'

for (const variant of ['flare', 'sunburst']) {
test(`${variant} preserves quality, format and background in both operations`, () => {
    const id = `gpt-image-2.5-${variant}`
    for (const edit of [false, true]) {
      const resolved = resolveModel(id, 'image', edit)
      const model = CATALOG.find(m => m.endpoint === resolved.endpoint)!
      assert.ok(model)
      assert.equal(resolved.endpoint, `openai/gpt-image-2.5/${variant}/${edit ? 'edit' : 'text-to-image'}`)
      assert.ok(model.params?.find(p => p.name === 'quality')?.options?.some(o => o.value === 'max'))
      const input = prepareImageParams(model, { aspect_ratio: '16:9', resolution: '4K', quality: 'max', output_format: 'webp', background: 'transparent' }, [])
      assert.deepEqual(input.image_size, { width: 3840, height: 2160 })
      assert.equal(input.quality, 'max')
      assert.equal(input.output_format, 'webp')
      assert.equal(input.background, 'transparent')
      if (edit) assert.equal(model.maxImageRefs, 16)
    }
})
}

test('GPT Image 2.5 quality values keep provider ids with English labels', () => {
  const model = CATALOG.find(item => item.id === 'gpt-image-2.5-flare')!
  assert.deepEqual(
    model.params?.find(param => param.name === 'quality')?.options,
    [
      { value: 'auto', label: 'Auto' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Very high' },
      { value: 'max', label: 'Maximum' },
    ],
  )
})

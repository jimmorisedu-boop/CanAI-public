// @ts-expect-error Node test runtime
import test from 'node:test'
// @ts-expect-error Node test runtime
import assert from 'node:assert/strict'
import { mediaDoubleTapAction } from './generationDetails'
test('двойной тап созданной картинки открывает параметры, видео — просмотр', () => {
  assert.equal(mediaDoubleTapAction({ kind: 'image', prompt: 'Свет' }), 'details')
  assert.equal(mediaDoubleTapAction({ kind: 'image', modelId: 'test' }), 'details')
  assert.equal(mediaDoubleTapAction({ kind: 'image' }), 'viewer')
  assert.equal(mediaDoubleTapAction({ kind: 'video', prompt: 'Свет' }), 'viewer')
})

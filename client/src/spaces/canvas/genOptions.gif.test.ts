import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogModel } from '../../types'
import { acceptsGifFrame, acceptsImageReference } from './genOptions'

const models: CatalogModel[] = [
  { id: 'image-base', name: 'Картинка', kind: 'image', refs: false, pairId: 'image-edit', params: [] },
  { id: 'image-edit', name: 'Правка', kind: 'image', refs: true, maxImageRefs: 4, params: [] },
  { id: 'text-only', name: 'Только текст', kind: 'image', refs: false, params: [] },
  { id: 'video-only', name: 'Только видео', kind: 'video', refs: false, videoRefs: true, maxVideoRefs: 1, params: [] },
  { id: 'assistant-image', name: 'Помощник', kind: 'text', refs: false, inputModalities: ['text', 'image'], params: [] },
  { id: 'explicit-zero', name: 'Без картинок', kind: 'image', refs: true, maxImageRefs: 0, params: [] },
]

test('GIF как кадр доступен только моделям с входом картинки', () => {
  assert.equal(acceptsGifFrame(models, 'image', 'image-base'), true, 'базовая модель переключится на edit-пару')
  assert.equal(acceptsGifFrame(models, 'image', 'image-edit'), true)
  assert.equal(acceptsGifFrame(models, 'text', 'assistant-image'), true)
  assert.equal(acceptsGifFrame(models, 'image', 'text-only'), false)
  assert.equal(acceptsGifFrame(models, 'video', 'video-only'), false)
  assert.equal(acceptsGifFrame(models, 'image', 'explicit-zero'), false)
  assert.equal(acceptsImageReference(null), false)
})

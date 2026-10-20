// @ts-expect-error Клиентский tsconfig намеренно не подключает Node-типы.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx в Node.
import test from 'node:test'
import { cropMetadataForAppliedRect, cropSessionForItem } from './cropState.js'
import type { CanvasItem } from './types.js'

const original: CanvasItem = {
  id: 'image-1',
  kind: 'image',
  x: 100,
  y: 200,
  w: 800,
  h: 600,
  src: '/media/original.png',
  mime: 'image/png',
  naturalWidth: 1600,
  naturalHeight: 1200,
}

test('first crop uses the current image as its immutable source', () => {
  const session = cropSessionForItem(original)

  assert.deepEqual(session.item, original)
  assert.equal(session.savedRect, null)

  assert.deepEqual(
    cropMetadataForAppliedRect(session, { x: 80, y: 60, w: 640, h: 480 }),
    {
      sourceSrc: '/media/original.png',
      sourceMime: 'image/png',
      sourceNaturalWidth: 1600,
      sourceNaturalHeight: 1200,
      rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    },
  )
})

test('cloud crop хранит stable asset исходника, а не только локальный URL', () => {
  const cloud = {
    ...original,
    assetId: 'ast_original',
    src: '/v3/assets/ast_original',
  }

  assert.equal(
    cropMetadataForAppliedRect(cropSessionForItem(cloud), { x: 80, y: 60, w: 640, h: 480 }).sourceAssetId,
    'ast_original',
  )
})

test('repeat crop reopens the full original with the previous crop selected', () => {
  const cropped: CanvasItem = {
    ...original,
    x: 180,
    y: 260,
    w: 640,
    h: 480,
    src: '/media/crop.png',
    naturalWidth: 1280,
    naturalHeight: 960,
    crop: {
      sourceSrc: '/media/original.png',
      sourceMime: 'image/png',
      sourceNaturalWidth: 1600,
      sourceNaturalHeight: 1200,
      rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    },
  }

  const session = cropSessionForItem(cropped)

  assert.equal(session.item.src, '/media/original.png')
  assert.deepEqual(
    { x: session.item.x, y: session.item.y, w: session.item.w, h: session.item.h },
    { x: 100, y: 200, w: 800, h: 600 },
  )
  assert.deepEqual(session.savedRect, { x: 80, y: 60, w: 640, h: 480 })
})

test('repeat crop keeps the visible crop aligned after resize and rotation', () => {
  const cropped: CanvasItem = {
    ...original,
    x: 300,
    y: 400,
    w: 320,
    h: 240,
    rotation: 90,
    src: '/media/crop.png',
    crop: {
      sourceSrc: '/media/original.png',
      sourceMime: 'image/png',
      sourceNaturalWidth: 1600,
      sourceNaturalHeight: 1200,
      rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    },
  }

  const session = cropSessionForItem(cropped)

  assert.deepEqual(
    { x: session.item.x, y: session.item.y, w: session.item.w, h: session.item.h },
    { x: 330, y: 360, w: 400, h: 300 },
  )
  assert.deepEqual(session.savedRect, { x: 40, y: 30, w: 320, h: 240 })
})

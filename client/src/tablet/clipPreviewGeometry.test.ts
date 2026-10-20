import assert from 'node:assert/strict'
import test from 'node:test'
import { resizeFromCorner } from '../spaces/canvas/konva/cropMath'
import {
  applyCropGesture,
  clipSourceSize,
  fitClipPreview,
  normalizedDelta,
  normalizedPoint,
} from './clipPreviewGeometry'

test('fitClipPreview keeps landscape and portrait sources aspect preserving', () => {
  const landscape = fitClipPreview({ width: 1920, height: 1080 }, { width: 1000, height: 600 })
  assert.equal(landscape.width, 960)
  assert.equal(landscape.height, 540)
  assert.equal(landscape.x, 20)
  assert.equal(landscape.y, 30)

  const portrait = fitClipPreview({ width: 1080, height: 1920 }, { width: 1000, height: 600 })
  assert.equal(portrait.width, 315)
  assert.equal(portrait.height, 560)
  assert.equal(portrait.x, 342.5)
  assert.equal(portrait.y, 20)
  assert.deepEqual(fitClipPreview({ width: 16, height: 9 }, { width: Number.NaN, height: 600 }), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    scale: 0,
  })
  assert.deepEqual(fitClipPreview({ width: 16, height: 9 }, { width: 1000, height: Number.POSITIVE_INFINITY }), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    scale: 0,
  })
})

test('source dimensions prefer probe, then media metadata, item dimensions, and 16:9', () => {
  const item = { naturalWidth: 1200, naturalHeight: 800, w: 300, h: 200 }
  assert.deepEqual(clipSourceSize({ width: 1920, height: 1080 }, { videoWidth: 640, videoHeight: 480 }, item), { width: 1920, height: 1080 })
  assert.deepEqual(clipSourceSize(null, { videoWidth: 640, videoHeight: 480 }, item), { width: 640, height: 480 })
  assert.deepEqual(clipSourceSize(null, { videoWidth: 0, videoHeight: 0 }, item), { width: 1200, height: 800 })
  assert.deepEqual(clipSourceSize(null, null, { naturalWidth: 0, naturalHeight: 0, w: 0, h: 0 }), { width: 16 / 9, height: 1 })
})

test('normalized pointer coordinates use the video rectangle, excluding letterbox space', () => {
  const rect = { left: 220, top: 80, width: 560, height: 315 }
  assert.deepEqual(normalizedPoint(220, 80, rect), { x: 0, y: 0 })
  assert.deepEqual(normalizedPoint(500, 237.5, rect), { x: 0.5, y: 0.5 })
  assert.deepEqual(normalizedPoint(0, 999, rect), { x: 0, y: 1 })
  assert.deepEqual(normalizedDelta({ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.1 }), { x: 0.3, y: -0.19999999999999998 })
})

test('corner resize stays inside source bounds and preserves the source-pixel ratio', () => {
  const bounds = { w: 1920, h: 1080 }
  const rect = { x: 480, y: 270, w: 960, h: 540 }
  const expanded = resizeFromCorner(rect, 'se', { x: 4000, y: 4000 }, bounds, 16 / 9)
  assert.equal(expanded.x, 480)
  assert.equal(expanded.y, 270)
  assert.equal(expanded.w, 1440)
  assert.equal(expanded.h, 810)
  assert.equal(expanded.w / expanded.h, 16 / 9)

  const collapsed = resizeFromCorner(rect, 'nw', { x: 1439, y: 809 }, bounds, 16 / 9)
  assert.ok(collapsed.x >= 0)
  assert.ok(collapsed.y >= 0)
  assert.ok(collapsed.x + collapsed.w <= bounds.w)
  assert.ok(collapsed.y + collapsed.h <= bounds.h)
  assert.ok(collapsed.w >= 24)
  assert.ok(collapsed.h >= 24)
  assert.equal(collapsed.w / collapsed.h, 16 / 9)
})

test('gesture kernel updates during pointermove, ignores other pointers, and stays locked while busy', () => {
  const gesture = {
    pointerId: 7,
    mode: 'move' as const,
    from: { x: 0.3, y: 0.3 },
    start: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
  }
  const source = { width: 1920, height: 1080 }
  const moved = applyCropGesture(gesture, 7, { x: 0.5, y: 0.4 }, source, null)
  assert.deepEqual(moved, { x: 0.3, y: 0.2, w: 0.4, h: 0.4 })
  assert.equal(applyCropGesture(gesture, 8, { x: 0.5, y: 0.4 }, source, null), null)
  assert.equal(applyCropGesture(gesture, 7, { x: 0.5, y: 0.4 }, source, null, true), null)

  const cornerGesture = {
    pointerId: 9,
    mode: 'se' as const,
    from: { x: 0.6, y: 0.6 },
    start: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
  }
  const resized = applyCropGesture(cornerGesture, 9, { x: 0.95, y: 0.95 }, source, 16 / 9)
  assert.ok(resized)
  assert.ok(resized.x >= 0 && resized.y >= 0)
  assert.ok(resized.x + resized.w <= 1 && resized.y + resized.h <= 1)
  assert.ok(Math.abs((resized.w * source.width) / (resized.h * source.height) - 16 / 9) < 1e-9)
})

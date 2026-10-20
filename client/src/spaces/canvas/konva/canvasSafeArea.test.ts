import assert from 'node:assert/strict'
import test from 'node:test'
import { safeViewportFromOcclusions } from './canvasSafeArea'

test('нижний prompt и правая полка уменьшают safe viewport на inset', () => {
  const safe = safeViewportFromOcclusions(
    { x: 100, y: 50, w: 800, h: 600 },
    [
      { edge: 'bottom', rect: { x: 100, y: 520, w: 800, h: 200 } },
      { edge: 'right', rect: { x: 700, y: 50, w: 300, h: 600 } },
    ],
  )

  assert.deepEqual(safe, { x: 100, y: 50, w: 584, h: 454 })
})

test('DOMRect-подобная occlusion за пределами container не выводит safe viewport наружу', () => {
  const domRectLike = { x: 1_500, y: -20, width: 320, height: 1_000 }
  const safe = safeViewportFromOcclusions(
    { x: 100, y: 50, w: 800, h: 600 },
    [
      { edge: 'bottom', rect: domRectLike },
      { edge: 'right', rect: domRectLike },
    ],
  )

  assert.deepEqual(safe, { x: 100, y: 50, w: 800, h: 0 })
})

test('occlusion перед началом container оставляет неотрицательную safe область', () => {
  const safe = safeViewportFromOcclusions(
    { x: 100, y: 50, w: 800, h: 600 },
    [{ edge: 'right', rect: { x: 80, y: 0, w: 20, h: 700 } }],
  )

  assert.deepEqual(safe, { x: 100, y: 50, w: 0, h: 600 })
})

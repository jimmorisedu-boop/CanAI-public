import assert from 'node:assert/strict'
import test from 'node:test'
import { boardNavigatorCameraAt, boardNavigatorLayout, boardNavigatorWorldPoint } from './boardNavigatorMath'

test('mini-map includes distant objects and the current viewport', () => {
  const camera = { x: -200, y: -100, scale: 2 }
  const layout = boardNavigatorLayout(
    [{ x: -800, y: 500, w: 400, h: 200 }, { x: 1600, y: -900, w: 300, h: 500 }],
    camera,
    { w: 1000, h: 600 },
    { w: 208, h: 124 },
  )
  assert.ok(layout)
  assert.deepEqual(layout.viewport, { x: 100, y: 50, w: 500, h: 300 })
  for (const point of [{ x: -800, y: 700 }, { x: 1900, y: -900 }, { x: 100, y: 50 }, { x: 600, y: 350 }]) {
    const mapPoint = { x: point.x * layout.scale + layout.offsetX, y: point.y * layout.scale + layout.offsetY }
    assert.ok(mapPoint.x >= 0 && mapPoint.x <= 208)
    assert.ok(mapPoint.y >= 0 && mapPoint.y <= 124)
    const roundtrip = boardNavigatorWorldPoint(mapPoint, layout)
    assert.ok(Math.abs(roundtrip.x - point.x) < 0.001)
    assert.ok(Math.abs(roundtrip.y - point.y) < 0.001)
  }
})

test('clicking the mini-map centers the camera without changing zoom', () => {
  const camera = boardNavigatorCameraAt({ x: 1200, y: -400 }, { x: 5, y: 8, scale: 1.5 }, { w: 1000, h: 600 })
  assert.deepEqual(camera, { x: -1300, y: 900, scale: 1.5 })
})

test('mini-map ignores unavailable viewport and invalid geometry', () => {
  assert.equal(boardNavigatorLayout([], { x: 0, y: 0, scale: 1 }, { w: 0, h: 600 }, { w: 208, h: 124 }), null)
  const layout = boardNavigatorLayout(
    [{ x: Infinity, y: 0, w: 10, h: 10 }],
    { x: 0, y: 0, scale: 1 },
    { w: 800, h: 600 },
    { w: 208, h: 124 },
  )
  assert.ok(layout)
  assert.ok(Number.isFinite(layout.scale))
})

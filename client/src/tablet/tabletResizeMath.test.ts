import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MIN_RESIZE_PX,
  MAX_RESIZE_PX,
  cornerAnchor,
  localPointToWorld,
  resizeFromCorner,
  worldPointToFrameLocal,
} from './tabletResizeMath.js'

test('corner anchors mark the OPPOSITE fixed corner', () => {
  assert.deepEqual(cornerAnchor('se', 200, 100), { x: 0, y: 0 })
  assert.deepEqual(cornerAnchor('sw', 200, 100), { x: 200, y: 0 })
  assert.deepEqual(cornerAnchor('ne', 200, 100), { x: 0, y: 100 })
  assert.deepEqual(cornerAnchor('nw', 200, 100), { x: 200, y: 100 })
})

test('se drag keeps NW world corner and scales by the dominant signed side', () => {
  const result = resizeFromCorner({ x: 10, y: 20, w: 200, h: 100, rotation: 0 }, 'se', { x: 400, y: 100 })
  assert.equal(result.w, 400)
  assert.equal(result.h, 200)
  assert.equal(result.x, 10)
  assert.equal(result.y, 20)
})

test('se vertical dominance scales the same global factor', () => {
  const result = resizeFromCorner({ x: 10, y: 20, w: 200, h: 100, rotation: 0 }, 'se', { x: 300, y: 320 })
  assert.equal(result.w, 640)
  assert.equal(result.h, 320)
  assert.equal(result.x, 10)
  assert.equal(result.y, 20)
})

test('ne drag keeps SW fixed', () => {
  const result = resizeFromCorner({ x: 0, y: 0, w: 120, h: 60, rotation: 0 }, 'ne', { x: 180, y: 100 })
  // SW local (0,60) stays at world (0,60); top-right scales so W=180 H=90.
  assert.equal(result.w, 180)
  assert.equal(result.h, 90)
  assert.equal(result.x, 0)
  assert.equal(result.y, -30)
})

test('sw drag keeps NE fixed', () => {
  const result = resizeFromCorner({ x: 0, y: 0, w: 120, h: 60, rotation: 0 }, 'sw', { x: 20, y: 120 })
  assert.equal(result.w, 240)
  assert.equal(result.h, 120)
  assert.equal(result.x + result.w, 120) // NE remains at x=120
  assert.equal(result.y, 0)
})

test('inward drag clamps to the single min scale without flipping or regrowing', () => {
  const fromFar = resizeFromCorner({ x: 0, y: 0, w: 200, h: 100, rotation: 0 }, 'se', { x: -50, y: -50 })
  assert.equal(fromFar.w, 48)
  assert.equal(fromFar.h, 24)
  assert.equal(fromFar.x, 0)
  assert.equal(fromFar.y, 0)

  // После переезда через стационарный угол scale остаётся минимальным.
  const crossing = resizeFromCorner({ x: 0, y: 0, w: 200, h: 100, rotation: 0 }, 'se', { x: -10, y: 20 })
  assert.equal(crossing.w, 48)
  assert.equal(crossing.h, 24)
})

test('scale is bounded by the global min and max scale', () => {
  const large = resizeFromCorner({ x: 0, y: 0, w: 200, h: 100, rotation: 0 }, 'se', { x: 5000, y: 5000 })
  assert.equal(large.w, 10000)
  assert.equal(large.h, 5000)
  assert.ok(large.w <= MAX_RESIZE_PX)
  assert.ok(large.h <= MAX_RESIZE_PX)
})

test('rotation maps a rotated world point back into its local frame', () => {
  const item = { x: 100, y: 100, w: 200, h: 100, rotation: 90 }
  const local = { x: 200, y: 100 }
  const world = localPointToWorld(item, local)
  const back = worldPointToFrameLocal(item, world)
  assert.ok(Math.abs(back.x - local.x) < 1e-6)
  assert.ok(Math.abs(back.y - local.y) < 1e-6)
})

test('rotated se keeps its fixed world corner physically fixed', () => {
  const start = { x: 100, y: 100, w: 200, h: 100, rotation: 90 }
  const pointerLocal = { x: 400, y: 300 }
  const fixedWorld = localPointToWorld(start, cornerAnchor('se', start.w, start.h))
  const result = resizeFromCorner(start, 'se', pointerLocal)
  const checkStart = { x: result.x, y: result.y, w: result.w, h: result.h, rotation: 90 }
  const newAnchorWorld = localPointToWorld(checkStart, cornerAnchor('se', checkStart.w, checkStart.h))
  assert.ok(Math.abs(newAnchorWorld.x - fixedWorld.x) < 1e-6)
  assert.ok(Math.abs(newAnchorWorld.y - fixedWorld.y) < 1e-6)
})

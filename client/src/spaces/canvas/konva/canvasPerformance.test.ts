import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canvasCullPadding,
  canvasPixelRatio,
  canvasRenderCamera,
  canvasViewForCamera,
  shouldRebaseCanvasView,
  visibleCanvasEntries,
} from './canvasPerformance'

test('culling prefetch narrows at fit-to-board zoom and widens for normal zoom', () => {
  assert.equal(canvasCullPadding(0.2), 0.125)
  assert.equal(canvasCullPadding(0.35), 0.125)
  assert.ok(canvasCullPadding(0.6) > 0.125)
  assert.equal(canvasCullPadding(1), 0.5)
})

test('adaptive low-zoom culling mounts fewer far-offscreen entries but keeps selection', () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    id: `entry-${index}`,
    x: (index % 5) * 2000,
    y: Math.floor(index / 5) * 1600,
    w: 100,
    h: 100,
  }))
  entries.push({ id: 'selected-offscreen', x: 20000, y: 20000, w: 100, h: 100 })
  const camera = { x: 0, y: 0, scale: 0.2 }
  const viewport = { w: 1000, h: 700 }
  const selected = new Set(['selected-offscreen'])

  const legacy = visibleCanvasEntries(
    entries,
    canvasViewForCamera(camera, viewport, 0.5),
    selected,
  )
  const adaptive = visibleCanvasEntries(
    entries,
    canvasViewForCamera(camera, viewport, canvasCullPadding(camera.scale)),
    selected,
  )

  assert.ok(adaptive.length < legacy.length)
  assert.ok(adaptive.some((entry) => entry.id === 'selected-offscreen'))
})

test('remote collaboration render keeps the live camera during an imperative gesture', () => {
  const stored = { x: -100, y: -80, scale: 1 }
  const live = { x: 240, y: 160, scale: 1.8 }

  assert.equal(canvasRenderCamera(stored, live, true), live)
  assert.equal(canvasRenderCamera(stored, live, false), stored)
})

test('canvas pixel ratio is capped on dense displays', () => {
  assert.equal(canvasPixelRatio(1), 1)
  assert.equal(canvasPixelRatio(2), 1.5)
  assert.equal(canvasPixelRatio(3), 1.5)
})

test('offscreen pending cards are culled like normal canvas items', () => {
  const entries = [
    { id: 'visible', x: 10, y: 10, w: 100, h: 100 },
    { id: 'hidden', x: 5000, y: 5000, w: 100, h: 100 },
    { id: 'selected', x: 5000, y: 5000, w: 100, h: 100 },
  ]
  const visible = visibleCanvasEntries(
    entries,
    { x: 0, y: 0, w: 1000, h: 700 },
    new Set(['selected']),
  )
  assert.deepEqual(visible.map((entry) => entry.id), ['visible', 'selected'])
})

test('camera view converts screen viewport to world coordinates with padding', () => {
  assert.deepEqual(
    canvasViewForCamera({ x: -200, y: -100, scale: 2 }, { w: 1000, h: 600 }, 0.5),
    { x: -150, y: -100, w: 1000, h: 600 },
  )
})

test('wheel preview stays imperative while it remains inside the rendered guard area', () => {
  const rendered = { x: 0, y: 0, scale: 1 }
  const viewport = { w: 1000, h: 600 }

  assert.equal(
    shouldRebaseCanvasView(rendered, { x: -100, y: -50, scale: 0.8 }, viewport, 0.5),
    false,
  )
  assert.equal(
    shouldRebaseCanvasView(rendered, { x: 0, y: 0, scale: 0.45 }, viewport, 0.5),
    true,
  )
})

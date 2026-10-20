import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from './canvasStore'
import { chooseCanvasViewportSize } from './canvasVisibility'

test('viewport resize preserves the same world point in its center', () => {
  const store = new CanvasStore()
  store.setContainerSize(1_000, 800)
  store.setCamera({ x: 100, y: 80, scale: 2 })
  const before = store.getViewportCenter()

  store.resizeViewportPreservingCenter(600, 800)

  assert.deepEqual(store.getViewportCenter(), before)
  assert.deepEqual(store.getCamera(), {
    x: -100,
    y: 80,
    scale: 2,
  })
})

test('hidden canvas keeps its last non-zero viewport size', () => {
  assert.deepEqual(
    chooseCanvasViewportSize(
      { w: 0, h: 0 },
      { w: 1_280, h: 720 },
      { w: 1_280, h: 668 },
    ),
    { w: 1_280, h: 668 },
  )
})

test('canvas uses the window before its first non-zero measurement', () => {
  assert.deepEqual(
    chooseCanvasViewportSize({ w: 0, h: 0 }, { w: 1_280, h: 720 }, null),
    { w: 1_280, h: 720 },
  )
})

test('measured canvas size takes priority when it is usable', () => {
  assert.deepEqual(
    chooseCanvasViewportSize(
      { w: 1_024, h: 640 },
      { w: 1_280, h: 720 },
      { w: 1_280, h: 668 },
    ),
    { w: 1_024, h: 640 },
  )
})

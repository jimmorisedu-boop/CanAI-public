import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { resizeBoardItem } from './TabletResizeEditor'

function makeStore() {
  const store = new CanvasStore()
  store.loadDoc({
    version: 1,
    items: [{ id: 'photo', kind: 'image', src: '/media/photo.png', x: 0, y: 0, w: 400, h: 300 }],
    camera: { x: 0, y: 0, scale: 1 },
    assets: [], archive: [], pending: [],
  })
  return store
}

test('explicit resize changes the existing object and undoes in one history step', () => {
  const store = makeStore()
  assert.equal(resizeBoardItem(store, 'photo', 800, 600), true)
  assert.deepEqual(
    { w: store.getItem('photo')!.w, h: store.getItem('photo')!.h },
    { w: 800, h: 600 },
  )
  assert.equal(store.canUndo(), true)
  store.undo()
  assert.deepEqual(
    { w: store.getItem('photo')!.w, h: store.getItem('photo')!.h },
    { w: 400, h: 300 },
  )
  assert.equal(store.canUndo(), false)
})

test('resize refuses an unknown object without creating history', () => {
  const store = makeStore()
  assert.equal(resizeBoardItem(store, 'missing', 800, 600), false)
  assert.equal(store.canUndo(), false)
})

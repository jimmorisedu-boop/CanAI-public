import assert from 'node:assert/strict'
import test from 'node:test'
import { tabletCropModelForItem } from './TabletCrop.js'
import type { CanvasItem } from '../spaces/canvas/konva/types.js'
import React from 'react'
import { TabletCrop } from './TabletCrop.js'
import { CanvasStore } from '../spaces/canvas/konva/canvasStore.js'

const original: CanvasItem = {
  id: 'image-1',
  kind: 'image',
  x: 100,
  y: 200,
  w: 800,
  h: 600,
  src: '/v3/assets/original',
  assetId: 'ast_original',
  mime: 'image/png',
  naturalWidth: 1600,
  naturalHeight: 1200,
}

test('crop handles resize with a stable opposite corner and ignore unrelated pointers', () => {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, items: [original], camera: { x: 0, y: 0, scale: 1 }, assets: [], archive: [], pending: [] })
  const slots: any[] = []
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const previous = internals.ReactCurrentDispatcher.current
  const render = () => {
    let i = 0
    internals.ReactCurrentDispatcher.current = {
      useState(value: any) { const at = i++; if (!(at in slots)) slots[at] = typeof value === 'function' ? value() : value; return [slots[at], (next: any) => { slots[at] = next }] },
      useRef(value: any) { return slots[i++] ??= { current: value } },
      useCallback(fn: any) { return fn }, useLayoutEffect() {},
      useContext(context: any) { return context._currentValue },
      useSyncExternalStore(_subscribe: any, getSnapshot: () => unknown) { return getSnapshot() },
      useMemo(fn: any) { return fn() },
    }
    try { return TabletCrop({ store, itemId: original.id, upload: async () => { throw Error('unexpected upload') }, onClose() {} }) }
    finally { internals.ReactCurrentDispatcher.current = previous }
  }
  const find = (tree: any, name: string): any => {
    if (!React.isValidElement(tree)) return
    if ((tree.props as any).className === name) return tree
    for (const child of React.Children.toArray((tree.props as any).children)) { const result = find(child, name); if (result) return result }
  }
  let tree = render()
  find(tree, 'tablet-crop-stage').ref.current = { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }) }
  slots[5] = { w: 860, h: 660 } // preview 1:1 after safe margins
  tree = render()
  const events = find(tree, 'tablet-crop-frame').props
  const target = { setPointerCapture() {}, releasePointerCapture() {} }
  const point = (x: number, y: number, id = 1, type = 'pointermove') => ({ clientX: x, clientY: y, pointerId: id, button: 0, type, currentTarget: target, stopPropagation() {}, preventDefault() {} })
  find(tree, 'tablet-crop-handle se').props.onPointerDown(point(815, 615))
  events.onPointerMove(point(615, 465, 2))
  assert.deepEqual(slots[1], { x: 0, y: 0, w: 800, h: 600 })
  events.onPointerMove(point(615, 465))
  assert.deepEqual(slots[1], { x: 0, y: 0, w: 600, h: 450 })
  events.onPointerUp(point(515, 415, 1, 'pointerup'))
  assert.deepEqual(slots[1], { x: 0, y: 0, w: 500, h: 400 }, 'final release coordinates apply without waiting for React')
  events.onPointerMove(point(300, 300))
  assert.deepEqual(slots[1], { x: 0, y: 0, w: 500, h: 400 })
})

test('первый планшетный кроп открывает текущий источник с полной рамкой', () => {
  const model = tabletCropModelForItem(original)

  assert.equal(model.item, original)
  assert.deepEqual(model.bounds, { w: 800, h: 600 })
  assert.deepEqual(model.initialRect, { x: 0, y: 0, w: 800, h: 600 })
})

test('повторный планшетный кроп после reload снова открывает оригинал и прежнюю рамку', () => {
  const persisted: CanvasItem = JSON.parse(JSON.stringify({
    ...original,
    x: 180,
    y: 260,
    w: 640,
    h: 480,
    src: '/v3/assets/cropped',
    assetId: 'ast_cropped',
    naturalWidth: 1280,
    naturalHeight: 960,
    crop: {
      sourceSrc: '/v3/assets/original',
      sourceAssetId: 'ast_original',
      sourceMime: 'image/png',
      sourceNaturalWidth: 1600,
      sourceNaturalHeight: 1200,
      rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    },
  }))

  const model = tabletCropModelForItem(persisted)

  assert.equal(model.item?.src, '/v3/assets/original')
  assert.equal(model.item?.assetId, 'ast_original')
  assert.deepEqual(
    { x: model.item?.x, y: model.item?.y, w: model.item?.w, h: model.item?.h },
    { x: 100, y: 200, w: 800, h: 600 },
  )
  assert.deepEqual(model.initialRect, { x: 80, y: 60, w: 640, h: 480 })
})

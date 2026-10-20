import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from './canvasStore.js'
import { layoutMediaGrid } from './mediaGridLayout.js'

test('batch располагается рядами вокруг точки вставки и сохраняет пропорции', () => {
  assert.deepEqual(
    layoutMediaGrid(
      [
        { width: 400, height: 400 },
        { width: 800, height: 400 },
        { width: 400, height: 800 },
      ],
      { x: 0, y: 0 },
      { columns: 2, gap: 20, itemWidth: 200 },
    ),
    [
      { x: -210, y: -310, w: 200, h: 200 },
      { x: 10, y: -310, w: 200, h: 100 },
      { x: -210, y: -90, w: 200, h: 400 },
    ],
  )
})

test('пустой batch не создаёт координат, а битые размеры дают квадрат', () => {
  assert.deepEqual(layoutMediaGrid([], { x: 10, y: 20 }), [])
  assert.deepEqual(
    layoutMediaGrid([{ width: 0, height: Number.NaN }], { x: 10, y: 20 }, { itemWidth: 100 }),
    [{ x: -40, y: -30, w: 100, h: 100 }],
  )
})

test('перераскладка выделения — один шаг истории и не меняет размеры', () => {
  const store = new CanvasStore()
  const first = store.addItem({ kind: 'image', x: 0, y: 0, w: 100, h: 50, src: '/media/a.png' })
  const second = store.addItem({ kind: 'video', x: 0, y: 0, w: 80, h: 120, src: '/media/b.mp4' })
  store.setSelection([first, second])

  store.arrangeInGrid([first, second], { columns: 2, gap: 20 })
  assert.deepEqual(
    store.getSelectedItems().map(({ x, y, w, h }) => ({ x, y, w, h })),
    [
      { x: -50, y: 0, w: 100, h: 50 },
      { x: 70, y: 0, w: 80, h: 120 },
    ],
  )

  store.undo()
  assert.deepEqual(
    store.getSelectedItems().map(({ x, y, w, h }) => ({ x, y, w, h })),
    [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 0, y: 0, w: 80, h: 120 },
    ],
  )
})

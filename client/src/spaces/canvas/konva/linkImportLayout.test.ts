import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutLinkImport } from './linkImportLayout.js'

test('reserves a five-item carousel in a 4+1 row-major grid beside the link', () => {
  const slots = layoutLinkImport(
    { x: 100, y: 100, w: 360, h: 280 },
    Array.from({ length: 5 }, (_, index) => ({ id: String(index), kind: 'image' as const, title: '', aspectRatio: 1 })),
    [],
  )
  assert.deepEqual(slots.map((slot) => [slot.column, slot.row]), [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1]])
  assert(slots.every((slot) => slot.x >= 484))
})

test('clamps aspect sizes, keeps order and shifts the whole grid beyond obstacles', () => {
  const slots = layoutLinkImport(
    { x: 0, y: 0, w: 360, h: 280 },
    [
      { id: 'wide', kind: 'image', title: '', aspectRatio: 100 },
      { id: 'tall', kind: 'video', title: '', aspectRatio: 0.01 },
    ],
    [{ x: 384, y: 0, w: 700, h: 2_000 }],
  )
  assert.deepEqual(slots.map((slot) => slot.id), ['wide', 'tall'])
  assert.equal(slots[0].h, 64)
  assert.equal(slots[1].h, 1600)
  assert(slots.every((slot) => slot.x >= 1108))
})

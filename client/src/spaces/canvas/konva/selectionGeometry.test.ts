import assert from 'node:assert/strict'
import test from 'node:test'
import { itemAabb } from './geometry.js'
import { alignSelection, arrangeSelection } from './selectionGeometry.js'
import type { CanvasItem } from './types.js'

function item(id: string, patch: Partial<CanvasItem> = {}): CanvasItem {
  return {
    id,
    kind: 'image',
    x: 0,
    y: 0,
    w: 100,
    h: 60,
    src: `/media/${id}.png`,
    ...patch,
  }
}

function apply(itemValue: CanvasItem, patch: { x: number; y: number }): CanvasItem {
  return { ...itemValue, ...patch }
}

function close(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 0.00001, `${message}: ${actual} ≠ ${expected}`)
}

test('alignment uses rotated AABBs and preserves each item size and rotation', () => {
  const selected = [
    item('rotated', { x: 20, y: 10, w: 120, h: 50, rotation: 45 }),
    item('plain', { x: 260, y: 130, w: 80, h: 80, rotation: -12 }),
    item('text', { kind: 'text', x: 430, y: -50, w: 150, h: 32, text: 'label', rotation: 0 }),
  ]
  const patches = alignSelection(selected, 'left')
  assert.equal(patches.length, selected.length)
  const moved = selected.map((value, index) => apply(value, patches[index]!))
  const left = Math.min(...moved.map((value) => itemAabb(value).x))
  moved.forEach((value) => close(itemAabb(value).x, left, `${value.id} left edge`))
  assert.equal(moved[0]!.w, selected[0]!.w)
  assert.equal(moved[0]!.h, selected[0]!.h)
  assert.equal(moved[0]!.rotation, selected[0]!.rotation)
  assert.equal(moved[1]!.rotation, selected[1]!.rotation)
})

test('row and column arrangements use AABB gaps while keeping the original order', () => {
  const selected = [
    item('one', { x: -120, y: 80, w: 120, h: 40, rotation: 20 }),
    item('two', { x: 40, y: -40, w: 80, h: 120 }),
    item('three', { x: 220, y: 90, w: 60, h: 60, rotation: -15 }),
  ]
  const row = arrangeSelection(selected, 'row', { gap: 16 })
  const rowItems = selected.map((value, index) => apply(value, row[index]!))
  const rowAabbs = rowItems.map(itemAabb)
  close(rowAabbs[1]!.x - (rowAabbs[0]!.x + rowAabbs[0]!.w), 16, 'row gap one')
  close(rowAabbs[2]!.x - (rowAabbs[1]!.x + rowAabbs[1]!.w), 16, 'row gap two')
  const rowCentre = rowAabbs[0]!.y + rowAabbs[0]!.h / 2
  rowAabbs.forEach((rect) => close(rect.y + rect.h / 2, rowCentre, 'row centre'))

  const column = arrangeSelection(selected, 'column', { gap: 12 })
  const columnItems = selected.map((value, index) => apply(value, column[index]!))
  const columnAabbs = columnItems.map(itemAabb)
  close(columnAabbs[1]!.y - (columnAabbs[0]!.y + columnAabbs[0]!.h), 12, 'column gap one')
  close(columnAabbs[2]!.y - (columnAabbs[1]!.y + columnAabbs[1]!.h), 12, 'column gap two')
})

test('grid arrangement keeps mixed item kinds and uses the requested columns', () => {
  const selected = [
    item('a', { kind: 'text', w: 50, h: 30, text: 'a' }),
    item('b', { kind: 'video', x: 100, w: 80, h: 120, src: '/media/b.mp4' }),
    item('c', { kind: 'link', x: 200, w: 50, h: 70, link: { url: 'https://example.com', state: 'ready' } }),
    item('d', { kind: 'audio', x: 300, w: 80, h: 40 }),
  ]
  const patches = arrangeSelection(selected, 'grid', { columns: 2, gap: 20 })
  const moved = selected.map((value, index) => apply(value, patches[index]!))
  const rects = moved.map(itemAabb)
  close(rects[1]!.x - (rects[0]!.x + rects[0]!.w), 20, 'grid first row gap')
  const firstRowHeight = Math.max(rects[0]!.h, rects[1]!.h)
  close(rects[2]!.y - (rects[0]!.y + firstRowHeight), 20, 'grid second row gap')
  assert.equal(moved[0]!.kind, 'text')
  assert.equal(moved[1]!.kind, 'video')
  assert.equal(moved[2]!.kind, 'link')
  assert.equal(moved[3]!.kind, 'audio')
})

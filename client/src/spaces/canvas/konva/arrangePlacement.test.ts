import assert from 'node:assert/strict'
import test from 'node:test'
import { placeArrangePanel } from './arrangePlacement.js'

const viewport = { left: 0, top: 0, right: 1280, bottom: 720 }
const panel = { width: 350, height: 320 }

test('arrange panel chooses below for a selection pinned to the top edge', () => {
  const placement = placeArrangePanel({ left: 320, top: 24, right: 760, bottom: 170 }, panel, viewport)
  assert.equal(placement.side, 'below')
  assert.ok(placement.top >= 182)
  assert.ok(placement.left >= 12)
})

test('arrange panel avoids the bottom dock and stays inside viewport at an edge', () => {
  const placement = placeArrangePanel(
    { left: 12, top: 430, right: 220, bottom: 620 },
    panel,
    viewport,
    150,
  )
  assert.ok(placement.left >= 12)
  assert.ok(placement.top >= 12)
  assert.ok(placement.top + panel.height <= viewport.bottom - 150 - 12)
  assert.ok(
    placement.left >= 220 + 12
      || placement.left + panel.width <= 12
      || placement.top + panel.height <= 430
      || placement.top >= 620,
  )
})

test('horizontal clamping does not discard an otherwise clear side of the selection', () => {
  const placement = placeArrangePanel({ left: 20, top: 180, right: 180, bottom: 320 }, panel, viewport)
  assert.equal(placement.side, 'below')
  assert.ok(placement.top >= 332)
})

test('keeps a clear panel position stable, then relocates when preview content crosses it', () => {
  const compactPanel = { width: 280, height: 300 }
  const initial = placeArrangePanel({ left: 300, top: 90, right: 520, bottom: 210 }, compactPanel, viewport)
  const stable = placeArrangePanel({ left: 300, top: 90, right: 520, bottom: 210 }, compactPanel, viewport, 0, initial)
  assert.deepEqual(stable, initial)
  const moved = placeArrangePanel({ left: 300, top: 90, right: 520, bottom: 600 }, compactPanel, viewport, 0, initial)
  assert.notDeepEqual(moved, initial)
  assert.ok(moved.side === 'left' || moved.side === 'right' || moved.side === 'above' || moved.side === 'below')
})

test('prefers a clear full-viewport position over overlapping content when a soft reserve leaves no fit', () => {
  const compactViewport = { left: 0, top: 0, right: 832, bottom: 892 }
  const compactPanel = { width: 280, height: 260 }
  const selection = { left: 194, top: 52, right: 666, bottom: 337 }
  const placement = placeArrangePanel(selection, compactPanel, compactViewport, 329)
  assert.equal(placement.side, 'below')
  assert.ok(placement.top >= selection.bottom + 12)
  assert.ok(placement.left >= compactViewport.left + 12)
  assert.ok(placement.left + compactPanel.width <= compactViewport.right - 12)
  assert.ok(placement.top + compactPanel.height <= compactViewport.bottom - 12)
})

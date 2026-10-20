import assert from 'node:assert/strict'
import test from 'node:test'
import { archiveDisplayPage } from './archiveDisplay'

test('large archive renders a bounded first page and exposes the remainder', () => {
  const entries = Array.from({ length: 121 }, (_, id) => ({ id }))
  const page = archiveDisplayPage(entries, 40)
  assert.equal(page.visible.length, 40)
  assert.equal(page.remaining, 81)
})

test('archive page never slices a short list', () => {
  const entries = [{ id: 1 }, { id: 2 }]
  const page = archiveDisplayPage(entries, 40)
  assert.deepEqual(page.visible, entries)
  assert.equal(page.remaining, 0)
})

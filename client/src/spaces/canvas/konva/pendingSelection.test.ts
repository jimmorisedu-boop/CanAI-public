import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from './canvasStore.js'

test('выделить всё включает карточки ожидания генерации', () => {
  const store = new CanvasStore()
  const pendingIds = store.addPendingRow(2, { kind: 'image', label: 'GPT Image 2' })

  store.selectAll()

  assert.deepEqual(new Set(store.getSelectedIds()), new Set(pendingIds))
})

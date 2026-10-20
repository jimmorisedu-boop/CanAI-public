import assert from 'node:assert/strict'
import test from 'node:test'
import { dragOffsetFor, getCanvasDrag, publishCanvasDrag, subscribeCanvasDrag } from './itemDragBus.js'

test('панель следует только за теми объектами, которых тащат', () => {
  const offset = { ids: ['item_1', 'item_2'], dx: 40, dy: -12 }
  assert.deepEqual(dragOffsetFor(offset, ['item_2']), { dx: 40, dy: -12 })
  assert.deepEqual(dragOffsetFor(offset, ['item_9']), { dx: 0, dy: 0 })
  assert.deepEqual(dragOffsetFor(null, ['item_1']), { dx: 0, dy: 0 })
})

test('подписчик получает смещение и его снятие', () => {
  const seen: Array<{ dx: number; dy: number } | null> = []
  const stop = subscribeCanvasDrag((value) => seen.push(value && { dx: value.dx, dy: value.dy }))
  publishCanvasDrag({ ids: ['a'], dx: 5, dy: 6 })
  assert.deepEqual(getCanvasDrag()?.ids, ['a'])
  publishCanvasDrag(null)
  stop()
  publishCanvasDrag({ ids: ['a'], dx: 1, dy: 1 })
  assert.deepEqual(seen, [{ dx: 5, dy: 6 }, null], 'после отписки уведомлений нет')
  publishCanvasDrag(null)
})

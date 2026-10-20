// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import {
  COMPACT_LAYOUT_QUERY,
  compactLayoutSnapshot,
  subscribeCompactLayout,
} from './useCompactLayout'

test('компактный режим использует границу 600 px', () => {
  assert.equal(COMPACT_LAYOUT_QUERY, '(max-width: 600px)')
  assert.equal(compactLayoutSnapshot({ matches: true }), true)
  assert.equal(compactLayoutSnapshot({ matches: false }), false)
})

test('подписка передаёт изменение и удаляет тот же listener', () => {
  let handler: (() => void) | null = null
  const query = {
    addEventListener: (_type: 'change', next: () => void) => { handler = next },
    removeEventListener: (_type: 'change', next: () => void) => {
      if (handler === next) handler = null
    },
  }
  let changes = 0
  const stop = subscribeCompactLayout(query, () => { changes += 1 })

  handler?.()
  assert.equal(changes, 1)
  stop()
  assert.equal(handler, null)
})

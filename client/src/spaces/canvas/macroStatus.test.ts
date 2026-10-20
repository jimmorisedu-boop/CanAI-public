// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { macroCompletionStatus } from './macroStatus.js'

test('macro without delivered output gets persistent output_missing, not success', () => {
  assert.deepEqual(macroCompletionStatus('Без результата', 0), {
    kind: 'output_missing',
    message: 'Без результата: nothing reached Output',
  })
  assert.deepEqual(macroCompletionStatus('С результатом', 1), {
    kind: 'success',
    message: 'С результатом: ready ✓',
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { registerMediaImportCancelHandler, requestMediaImportCancel } from './mediaImportCancelBus.js'

test('cancel bus calls one current handler and cleanup detaches it', () => {
  const calls: string[] = []
  const cleanupFirst = registerMediaImportCancelHandler((id) => calls.push(`first:${id}`))
  requestMediaImportCancel('a')
  const cleanupSecond = registerMediaImportCancelHandler((id) => calls.push(`second:${id}`))
  requestMediaImportCancel('b')
  cleanupFirst()
  requestMediaImportCancel('c')
  cleanupSecond()
  requestMediaImportCancel('d')
  assert.deepEqual(calls, ['first:a', 'second:b', 'second:c'])
})

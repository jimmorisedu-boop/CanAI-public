// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import {
  connectionErrorAfterAttempt,
  connectionMismatchMessage,
  selfLoopMessage,
} from './connectionDiagnostics.js'

test('explains incompatible port types in English', () => {
  assert.equal(
    connectionMismatchMessage('video', 'text'),
    'Video cannot connect to text input',
  )
  assert.equal(
    connectionMismatchMessage('text', 'image'),
    'Text cannot connect to image input',
  )
  assert.equal(connectionMismatchMessage(null, 'image'), 'Port no longer exists')
  assert.equal(selfLoopMessage(), 'A node cannot connect to itself')
})

test('successful connection clears an earlier connection error', () => {
  assert.equal(connectionErrorAfterAttempt('Типы портов не совпадают', true), null)
  assert.equal(
    connectionErrorAfterAttempt('Типы портов не совпадают', false),
    'Типы портов не совпадают',
  )
})

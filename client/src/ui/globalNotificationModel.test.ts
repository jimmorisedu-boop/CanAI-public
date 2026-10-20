// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import type { ToastMessage } from '../spaces/canvas/toastBus'
import { applyToastEvent } from './globalNotificationModel'

function toast(id: string, replaceKey?: string): ToastMessage {
  return { id, kind: 'error', message: id, replaceKey }
}

test('закрытие удаляет только toast с точным replaceKey', () => {
  const result = applyToastEvent(
    [toast('target', 'generation-result-navigation'), toast('other', 'save'), toast('plain')],
    { type: 'dismiss', replaceKey: 'generation-result-navigation' },
  )

  assert.deepEqual(result.map((item) => item.id), ['other', 'plain'])
})

test('закрытие отсутствующего ключа идемпотентно и не трогает список', () => {
  const current = [toast('other', 'save'), toast('plain')]

  assert.deepEqual(applyToastEvent(current, { type: 'dismiss', replaceKey: 'missing' }), current)
  assert.deepEqual(applyToastEvent(current, { type: 'dismiss', replaceKey: 'missing' }), current)
})

test('новый toast с replaceKey по-прежнему заменяет предыдущий', () => {
  const result = applyToastEvent(
    [toast('old', 'retry'), toast('other')],
    { type: 'show', toast: toast('new', 'retry') },
  )

  assert.deepEqual(result.map((item) => item.id), ['other', 'new'])
})

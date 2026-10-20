import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoardItemView } from './BoardItemView.js'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore.js'
import { tabletHttpError, tabletSystemMessage, tabletSystemStatus } from './tabletSystemMessage.js'

test('tablet presents known upstream errors in English without changing user text', () => {
  assert.equal(tabletSystemMessage('Провайдер не ответил за отведённое время'), 'The provider did not respond in time.')
  assert.equal(tabletSystemMessage('Board “Русское имя” не найден'), 'Request failed. Open the diagnostic log for details.')
  assert.equal(tabletSystemMessage('The board “Русское имя” was not found'), 'The board “Русское имя” was not found')
})

test('tablet unknown Russian system errors point to diagnostics', () => {
  assert.equal(tabletSystemMessage('Неизвестная ошибка сервера'), 'Request failed. Open the diagnostic log for details.')
  assert.equal(tabletSystemMessage('Неизвестная ошибка сервера', 'Could not load board'), 'Could not load board')
  assert.equal(tabletSystemMessage('Неизвестная ошибка сервера', undefined, 'RATE_LIMIT'), 'Too many requests. Try again later.')
})

test('tablet renders persisted Russian progress as English status', () => {
  assert.equal(tabletSystemStatus('Подготовка запроса'), 'Preparing request…')
  assert.equal(tabletSystemStatus({ status: 'Загрузка' }), 'Uploading…')
  assert.equal(tabletSystemStatus('Неизвестная стадия'), 'Working…')
})

test('local HTTP rejection keeps status, code, details, and upstream text', () => {
  const error = tabletHttpError('Нет прав', 403, 'BOARD_FORBIDDEN', { retryable: false })
  assert.equal(error.status, 403)
  assert.equal(error.code, 'BOARD_FORBIDDEN')
  assert.deepEqual(error.details, { retryable: false })
  assert.equal(error.message, 'Нет прав')
  assert.equal(error.originalMessage, 'Нет прав')
  assert.equal(tabletSystemMessage(error), 'You do not have permission to do this.')
})

test('tablet pending card renders translated persisted errors and preserves model labels', () => {
  const html = renderToStaticMarkup(createElement(BoardItemView, {
    item: {
      id: 'pending-1', kind: 'image', x: 0, y: 0, w: 300, h: 200,
      label: 'Модель «Русский лейбл»', status: 'error',
      error: 'Провайдер не ответил за отведённое время', startedAt: 1,
    },
    selected: false,
    scale: 1,
    store: {} as CanvasStore,
  }))
  assert.match(html, /Модель «Русский лейбл»/)
  assert.match(html, /The provider did not respond in time\./)
  assert.doesNotMatch(html, /Провайдер не ответил/)

  const loading = renderToStaticMarkup(createElement(BoardItemView, {
    item: {
      id: 'pending-2', kind: 'image', x: 0, y: 0, w: 300, h: 200,
      label: 'Model', status: 'loading', transient: true,
      stage: 'Подготовка запроса', startedAt: 1,
    },
    selected: false,
    scale: 1,
    store: {} as CanvasStore,
  }))
  assert.match(loading, /Preparing request…/)
  assert.doesNotMatch(loading, /Подготовка запроса/)
})

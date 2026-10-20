import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatModelName,
  mergeBillingEvents,
  shouldLoadNextBillingPage,
} from './BillingHistoryModal'

test('история расходов подписывает новые OpenRouter LLM по-человечески', () => {
  assert.equal(formatModelName('openrouter/router'), 'LLM Text / Vision')
  assert.equal(formatModelName('openrouter/router/vision'), 'LLM Text / Vision')
})

test('следующая страница истории добавляется без повторов', () => {
  const first = [
    { id: 'a', endpoint: 'a', cost: 1, time: '2026-08-11T10:00:00Z' },
    { id: 'b', endpoint: 'b', cost: 2, time: '2026-08-11T09:00:00Z' },
  ]
  const next = [
    { id: 'b', endpoint: 'b', cost: 2, time: '2026-08-11T09:00:00Z' },
    { id: 'c', endpoint: 'c', cost: 3, time: '2026-08-11T08:00:00Z' },
  ]

  assert.deepEqual(mergeBillingEvents(first, next).map((item) => item.id), ['a', 'b', 'c'])
})

test('история запрашивает следующую десятку только у конца прокрутки', () => {
  const ready = { hasMore: true, nextCursor: 'page-2', loading: false }
  assert.equal(shouldLoadNextBillingPage({ scrollTop: 500, clientHeight: 300, scrollHeight: 860 }, ready), true)
  assert.equal(shouldLoadNextBillingPage({ scrollTop: 100, clientHeight: 300, scrollHeight: 860 }, ready), false)
  assert.equal(shouldLoadNextBillingPage({ scrollTop: 500, clientHeight: 300, scrollHeight: 860 }, { ...ready, loading: true }), false)
  assert.equal(shouldLoadNextBillingPage({ scrollTop: 500, clientHeight: 300, scrollHeight: 860 }, { ...ready, hasMore: false }), false)
})

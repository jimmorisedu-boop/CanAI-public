import assert from 'node:assert/strict'
import test from 'node:test'
import {
  conversationStatus,
  filterAndSortConversations,
  modelTransitionMarkers,
  shouldShowConversationSearch,
} from './promptChatViewModel'
import type { PromptChatMessage, PromptChatSummary } from './promptChatTypes'

function makeSummaries(count: number): PromptChatSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `c-${index}`,
    title: index === 3 ? 'Кампания' : `Диалог ${index}`,
    createdAt: index,
    updatedAt: index,
    preview: '',
    attention: 'idle',
  }))
}

function assistant(modelId: string): PromptChatMessage {
  return {
    id: `${modelId}-${Math.random()}`,
    role: 'assistant',
    text: '',
    createdAt: 1,
    status: 'done',
    modelId,
  }
}

test('поиск появляется с восьми диалогов и сортирует по активности', () => {
  const list = makeSummaries(8)
  assert.equal(shouldShowConversationSearch(list), true)
  assert.equal(shouldShowConversationSearch(list.slice(0, 7)), false)
  assert.deepEqual(
    filterAndSortConversations(list, '').map((item) => item.updatedAt),
    [...list].map((item) => item.updatedAt).sort((a, b) => b - a),
  )
  assert.deepEqual(filterAndSortConversations(list, 'камп').map((item) => item.title), ['Кампания'])
})

test('ставит подпись модели только на границе смены', () => {
  assert.deepEqual(modelTransitionMarkers([
    assistant('gemini'),
    assistant('gemini'),
    assistant('claude'),
  ]), [true, false, true])
})

test('показывает индикатор только для действия пользователя', () => {
  assert.deepEqual(conversationStatus({ ...makeSummaries(1)[0], attention: 'idle' }), {
    kind: 'none',
    label: '',
  })
  assert.equal(conversationStatus({ ...makeSummaries(1)[0], attention: 'running' }).label, 'Assistant is responding')
  assert.equal(conversationStatus({ ...makeSummaries(1)[0], attention: 'unread' }).label, 'New response')
  assert.equal(conversationStatus({ ...makeSummaries(1)[0], attention: 'error' }).label, 'Response error')
})

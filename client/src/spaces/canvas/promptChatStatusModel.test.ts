import assert from 'node:assert/strict'
import test from 'node:test'
import {
  promptChatCollapsedLabel,
  promptChatEcho,
  promptChatEstimateLabel,
  promptChatMemoryWarning,
} from './promptChatStatusModel'
import type { PromptChatMessage } from './promptChatTypes'

function assistant(
  id: string,
  status: PromptChatMessage['status'],
  extra: Partial<PromptChatMessage> = {},
): PromptChatMessage {
  return {
    id,
    role: 'assistant',
    text: '',
    createdAt: 1,
    status,
    ...extra,
  }
}

test('collapsed status describes only the latest assistant response', () => {
  const messages = [
    assistant('done', 'done'),
    assistant('failed', 'error'),
  ]

  assert.equal(promptChatCollapsedLabel(messages, 8), null)
  assert.equal(
    promptChatCollapsedLabel([...messages, assistant('running', 'running')], 8),
    'Writing prompt · 8s',
  )
})

test('полоска эха сообщает и о готовом ответе, и об ошибке', () => {
  // главное отличие от свёрнутого статуса: done и error больше не молчат
  assert.deepEqual(
    promptChatEcho([assistant('a', 'done', { reply: 'Уточнил свет и оптику' })], 0),
    { text: 'Уточнил свет и оптику', tone: 'done', total: 1 },
  )
  assert.deepEqual(
    promptChatEcho([assistant('a', 'error', { error: 'Нет связи с fal.ai' })], 0),
    { text: 'Failed to get response', tone: 'error', total: 1 },
  )
  assert.deepEqual(
    promptChatEcho([assistant('a', 'cancelled')], 0),
    { text: 'Stopped', tone: 'error', total: 1 },
  )
})

test('пока помощник думает, эхо показывает секунды и помечается как работающее', () => {
  const echo = promptChatEcho([assistant('a', 'running')], 12)
  assert.equal(echo?.tone, 'working')
  assert.equal(echo?.text, 'Writing prompt · 12s')
})

test('ответ без текста, но с промптами, описывается их числом', () => {
  const echo = promptChatEcho(
    [assistant('a', 'done', { prompts: [
      { title: 'Раз', prompt: 'p1' },
      { title: 'Два', prompt: 'p2' },
    ] })],
    0,
  )
  assert.deepEqual(echo, { text: 'Ready prompts: 2', tone: 'done', total: 1 })
})

test('без ответов помощника эха нет', () => {
  assert.equal(promptChatEcho([], 0), null)
  assert.equal(
    promptChatEcho([{ id: 'u', role: 'user', text: 'привет', createdAt: 1 }], 0),
    null,
  )
  // пустой ответ без промптов тоже нечего показывать
  assert.equal(promptChatEcho([assistant('a', 'done')], 0), null)
})

test('цена чата приходит с сервера, а ошибка памяти показывается только при stale', () => {
  assert.equal(promptChatEstimateLabel(null), null)
  assert.equal(promptChatEstimateLabel({
    modelId: 'gemini',
    inputTokens: 100,
    outputTokens: 200,
    costUsd: 0.0123,
    requiresConfirmation: false,
    contextHealth: 'ready',
  }), '≈ $0.012')
  assert.equal(promptChatMemoryWarning('ready'), null)
  assert.equal(promptChatMemoryWarning('error'), null)
  assert.equal(promptChatMemoryWarning('stale'), 'Memory was not updated')
})

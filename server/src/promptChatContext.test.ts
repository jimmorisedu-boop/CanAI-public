import assert from 'node:assert/strict'
import test from 'node:test'
import { CATALOG, type CatalogModel } from './catalog.js'
import {
  buildPromptChatContext,
  estimateChatRequestCost,
  estimateChatTokens,
  rankRelevantMessages,
} from './promptChatContext.js'
import type { PromptChatContextV1, PromptChatMessageV2 } from './promptChatTypes.js'

function user(id: string, text: string, createdAt = Number(id.replace(/\D/g, '')) || 1): PromptChatMessageV2 {
  return { id, role: 'user', text, createdAt }
}

function assistant(id: string, reply: string, createdAt = Number(id.replace(/\D/g, '')) || 1): PromptChatMessageV2 {
  return { id, role: 'assistant', text: '', reply, createdAt, status: 'done', modelId: 'gemini' }
}

function makeNoiseTurns(count: number): PromptChatMessageV2[] {
  return Array.from({ length: count }, (_, index) => (
    index % 2 === 0
      ? user(`noise-${index}`, `Обсуждение варианта ${index}: ${'обычный текст '.repeat(20)}`, 10 + index)
      : assistant(`noise-${index}`, `Продолжаем вариант ${index}: ${'нейтральный ответ '.repeat(20)}`, 10 + index)
  ))
}

function textModel(id: string): CatalogModel {
  return CATALOG.find((model) => model.id === id)!
}

const checkpoint: PromptChatContextV1 = {
  version: 1,
  revision: 2,
  summary: {
    goal: 'Подготовить кампанию',
    facts: ['Клиент работает в России'],
    decisions: [{ text: 'Формат 4:5', reason: 'Для ленты' }],
    constraints: ['Без синего цвета'],
    preferences: ['Лаконичный стиль'],
    referenceNotes: [],
    openQuestions: ['Нужен ли логотип?'],
    chronology: 'Обсудили аудиторию и выбрали формат.',
  },
  summaryThroughMessageId: 'm2',
  checkpoints: [],
  compaction: { status: 'idle' },
}

test('сохраняет свежий контекст и находит старое редкое решение', () => {
  const messages = [
    user('m1', 'Кодовое слово проекта — вермилион', 1),
    assistant('m2', 'Зафиксировал вермилион', 2),
    ...makeNoiseTurns(300),
    user('latest', 'Какое кодовое слово мы выбрали?', 1_000),
  ]
  const built = buildPromptChatContext({
    messages,
    checkpoint: null,
    throughMessageId: 'latest',
    model: textModel('gemini'),
  })
  assert.match(built.prompt, /вермилион/)
  assert.ok(built.estimatedInputTokens <= 20_000)
  assert.ok(built.includedMessageIds.includes('m1'))
  assert.ok(built.includedMessageIds.includes('latest'))
})

test('оценивает английский и русский текст с запасом 15 процентов', () => {
  assert.equal(estimateChatTokens('a'.repeat(400)), 115)
  assert.equal(estimateChatTokens('я'.repeat(200)), 115)
})

test('не включает ошибки, отмены и сообщения после целевой границы', () => {
  const messages: PromptChatMessageV2[] = [
    user('m1', 'Первый вопрос', 1),
    { ...assistant('m2', 'Секрет из ошибки', 2), status: 'error' },
    { ...assistant('m3', 'Секрет из отмены', 3), status: 'cancelled' },
    user('target', 'Текущий вопрос', 4),
    assistant('future', 'Будущий ответ не должен попасть', 5),
  ]
  const built = buildPromptChatContext({
    messages,
    checkpoint: null,
    throughMessageId: 'target',
    model: textModel('gemini'),
  })
  assert.doesNotMatch(built.prompt, /Секрет из ошибки|Секрет из отмены|Будущий ответ/)
  assert.deepEqual(built.includedMessageIds, ['m1', 'target'])
})

test('не дублирует охваченные резюме сообщения в недавнем диалоге', () => {
  const built = buildPromptChatContext({
    messages: [
      user('m1', 'Старый вопрос', 1),
      assistant('m2', 'Старый ответ', 2),
      user('m3', 'Новый вопрос', 3),
    ],
    checkpoint,
    throughMessageId: 'm3',
    model: textModel('gemini'),
  })
  assert.match(built.prompt, /Подготовить кампанию/)
  assert.doesNotMatch(built.prompt, /Старый вопрос|Старый ответ/)
  assert.deepEqual(built.includedMessageIds, ['m3'])
})

test('сохраняет текущий запрос и не превышает жёсткий бюджет', () => {
  const messages = [
    ...Array.from({ length: 80 }, (_, index) => user(`m${index}`, `уникальный${index} ${'данные '.repeat(900)}`, index)),
    user('latest', `Найди уникальный1 и уникальный2. ${'важно '.repeat(500)}`, 100),
  ]
  const built = buildPromptChatContext({
    messages,
    checkpoint: null,
    throughMessageId: 'latest',
    model: textModel('claude'),
  })
  assert.ok(built.estimatedInputTokens <= 20_000)
  assert.ok(built.includedMessageIds.includes('latest'))
  assert.equal(built.needsCompaction, true)
})

test('лексический рейтинг стабилен и предпочитает редкое точное совпадение', () => {
  const messages = [
    user('a', 'вермилион — утверждённый цвет', 1),
    user('b', 'цвет цвет цвет', 2),
    user('c', 'обычная заметка', 3),
  ]
  const ranked = rankRelevantMessages('Какой цвет вермилион?', messages, new Set())
  assert.equal(ranked[0].message.id, 'a')
})

test('считает токенные тарифы и сохраняет официальный ориентир стоимости вызова', () => {
  assert.equal(estimateChatRequestCost(textModel('gemini'), 8_000, 1_000), 0.0195)
  assert.equal(
    estimateChatRequestCost({ ...textModel('gemini'), textPricing: undefined }, 8_000, 1_000),
    null,
  )
  const historical = { ...textModel('gemini'), textPricing: undefined, pricing: { unit: 'call' as const, usd: 0.07 } }
  assert.equal(estimateChatRequestCost(historical, 8_000, 1_000), 0.07)
  assert.equal(estimateChatRequestCost(historical, 20_000, 4_000), 0.07, 'оценка за вызов не выдаётся за выдуманные токенные ставки')
})

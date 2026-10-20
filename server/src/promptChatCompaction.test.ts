import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  applyCompactionCheckpoint,
  buildCompactionPrompt,
  parseCompactionResponse,
  shouldCompact,
} from './promptChatCompaction.js'
import { PromptChatRepository } from './promptChatStorage.js'
import type { PromptChatMemory, PromptChatMessageV2 } from './promptChatTypes.js'

const memory: PromptChatMemory = {
  goal: 'Серия постеров',
  facts: ['Цвет — вермилион'],
  decisions: [{ text: 'Формат 4:5', reason: 'Для ленты' }],
  constraints: [],
  preferences: [],
  referenceNotes: [],
  openQuestions: ['Нужен ли логотип?'],
  chronology: 'Выбрали направление.',
}

async function fixture(t: test.TestContext) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-compaction-'))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  const repo = new PromptChatRepository({ rootDir, now: () => 100, id: () => 'c1' })
  await repo.createOrReuseEmpty('p1', 'gemini')
  const messages: PromptChatMessageV2[] = [
    { id: 'm1', role: 'user', text: 'Нужны постеры', createdAt: 1 },
    { id: 'm2', role: 'assistant', text: '', reply: 'Начнём', createdAt: 2, status: 'done' },
    { id: 'm3', role: 'assistant', text: '', error: 'Сбой', createdAt: 3, status: 'error' },
    { id: 'm4', role: 'user', text: 'Цвет вермилион', createdAt: 4 },
  ]
  await repo.appendMessages('p1', 'c1', messages)
  return { repo, messages }
}

test('решает пересжимать после 20 сообщений или переполнения 12k', () => {
  assert.equal(shouldCompact({ completedSinceCheckpoint: 19, recentTokens: 11_000 }), false)
  assert.equal(shouldCompact({ completedSinceCheckpoint: 20, recentTokens: 5_000 }), true)
  assert.equal(shouldCompact({ completedSinceCheckpoint: 4, recentTokens: 12_001 }), true)
})

test('строго разбирает JSON и fenced JSON структурированной памяти', () => {
  const parsed = parseCompactionResponse(JSON.stringify(memory))
  assert.equal(parsed.decisions[0].reason, 'Для ленты')
  assert.deepEqual(
    parseCompactionResponse(`\`\`\`json\n${JSON.stringify(memory)}\n\`\`\``),
    parsed,
  )
  assert.throws(() => parseCompactionResponse('Выбрали направление.'), /only JSON/u)
  assert.throws(
    () => parseCompactionResponse(JSON.stringify({ ...memory, facts: ['data:image/png;base64,AAAA'] })),
    /data:/,
  )
})

/**
 * ⚠️ Прежде этот тест требовал ОТКАЗА на любой перебор по размеру — и
 * закреплял ровно ту беду, ради которой писался. Пересжатие истории это
 * отдельный ПЛАТНЫЙ запрос к модели, и он выбрасывался целиком из-за одной
 * длинной строки. В журнале тестировщика (20.09.2026) видно, чем это
 * кончается: одна выжимка не может доставиться 62 раза за десять дней, а
 * счётчик попыток живёт в памяти — значит каждый перезапуск начинает заново, и
 * память диалога не обновляется никогда.
 *
 * Правило теперь такое: СТРУКТУРА — повод отказать, РАЗМЕР — повод подрезать.
 * Пределы никуда не делись, их держит fitMemory (promptChatMemoryFit.ts).
 */
test('перебор по размеру подрезается, а оплаченная выжимка доезжает', () => {
  const long = parseCompactionResponse(JSON.stringify({ ...memory, facts: ['x'.repeat(201)] }))
  assert.equal(long.facts.length, 1)
  assert.equal(long.facts[0].length, 200)

  const many = parseCompactionResponse(JSON.stringify({
    ...memory,
    facts: Array.from({ length: 81 }, (_, index) => `fact-${index}`),
  }))
  const entries = many.facts.length + many.decisions.length + many.constraints.length
    + many.preferences.length + many.referenceNotes.length + many.openQuestions.length
  assert.ok(entries <= 80, `записей ${entries}`)
  assert.equal(many.facts[0], 'fact-0', 'важное модель кладёт первым — режем хвост')

  const huge = parseCompactionResponse(JSON.stringify({ ...memory, chronology: 'я'.repeat(12_001) }))
  assert.ok(JSON.stringify(huge).length <= 12_000, JSON.stringify(huge).length.toString())
})

test('prompt пересжатия включает прежнюю память и только завершённые сообщения', async (t) => {
  const { messages } = await fixture(t)
  const prompt = buildCompactionPrompt(memory, messages)
  assert.match(prompt, /Серия постеров/)
  assert.match(prompt, /Начнём/)
  assert.doesNotMatch(prompt, /Сбой/)
  assert.match(prompt, /Return only JSON/u)
})

test('атомарно меняет summary и сохраняет до трёх прежних точек', async (t) => {
  const { repo } = await fixture(t)
  const contextBefore = await repo.loadContext('p1', 'c1')
  await applyCompactionCheckpoint(repo, {
    projectId: 'p1',
    conversationId: 'c1',
    fromMessageId: null,
    throughMessageId: 'm4',
    expectedContextRevision: contextBefore.revision,
    createdAt: 200,
    modelId: 'qwen',
  }, memory)
  const first = await repo.loadContext('p1', 'c1')
  assert.deepEqual(first.summary, memory)
  assert.equal(first.summaryThroughMessageId, 'm4')
  assert.equal(first.revision, contextBefore.revision + 1)
  assert.deepEqual(first.checkpoints, [])

  await repo.appendMessages('p1', 'c1', [
    { id: 'm5', role: 'user', text: 'Добавить логотип', createdAt: 5 },
  ])
  await applyCompactionCheckpoint(repo, {
    projectId: 'p1',
    conversationId: 'c1',
    fromMessageId: 'm5',
    throughMessageId: 'm5',
    expectedContextRevision: first.revision,
    createdAt: 300,
    modelId: 'qwen',
  }, { ...memory, chronology: 'Добавили логотип.' })
  const second = await repo.loadContext('p1', 'c1')
  assert.equal(second.checkpoints.length, 1)
  assert.deepEqual(second.checkpoints[0].summary, memory)
  assert.equal(second.summaryMeta?.createdAt, 300)
})

test('конфликт ревизии не меняет прежнюю память', async (t) => {
  const { repo } = await fixture(t)
  const contextBefore = await repo.loadContext('p1', 'c1')
  await assert.rejects(() => applyCompactionCheckpoint(repo, {
    projectId: 'p1',
    conversationId: 'c1',
    fromMessageId: null,
    throughMessageId: 'm4',
    expectedContextRevision: contextBefore.revision + 1,
    createdAt: 200,
    modelId: 'qwen',
  }, memory), /context revision conflict/u)
  assert.deepEqual(await repo.loadContext('p1', 'c1'), contextBefore)
})

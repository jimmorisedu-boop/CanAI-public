import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { extractBoardMemory } from './boardMemory.js'
import type { Job } from './jobs.js'
import {
  estimatePromptChatTurn,
  finalizeCompactionJob,
  finalizePromptChatJob,
  prepareCompactionJob,
  preparePromptChatJob,
  schedulePromptChatCompaction,
} from './promptChatDelivery.js'
import { PromptChatRepository } from './promptChatStorage.js'
import type { PromptChatContextV1 } from './promptChatTypes.js'

async function fixture(t: test.TestContext) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-delivery-'))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  const repo = new PromptChatRepository({ rootDir, now: () => 100, id: () => 'c1' })
  await repo.createOrReuseEmpty('p1', 'claude')
  await repo.appendMessages('p1', 'c1', [
    {
      id: 'prior-u1',
      role: 'user',
      text: 'PRIOR_DIALOGUE_SENTINEL',
      createdAt: 0,
    },
    {
      id: 'prior-a1',
      role: 'assistant',
      text: '',
      createdAt: 0.5,
      status: 'done',
      reply: 'PRIOR_DIALOGUE_REPLY_SENTINEL',
    },
    {
      id: 'u1',
      role: 'user',
      text: 'Составь промпт',
      createdAt: 1,
      attachments: [{
        shapeId: 'shape-1',
        kind: 'image',
        label: 'Референс',
        src: '/media/ref.png',
      }],
    },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      createdAt: 2,
      status: 'queued',
      jobId: 'job-1',
      requestMessageId: 'u1',
      modelId: 'claude',
    },
  ])
  await repo.patchMeta('p1', 'c1', { activeJobIds: ['job-1'] })
  const job: Job = {
    id: 'job-1',
    kind: 'text',
    prompt: 'Составь промпт',
    refs: [],
    model: 'claude',
    params: {},
    status: 'done',
    result: {
      text: JSON.stringify({
        reply: 'Готово',
        prompts: [{ title: 'Постер', prompt: 'Красный постер' }],
        referenceNotes: ['Цвет взят из референса'],
      }),
    },
    createdAt: 2,
    finishedAt: 3,
    target: {
      kind: 'prompt-chat',
      projectId: 'p1',
      conversationId: 'c1',
      requestMessageId: 'u1',
      responseMessageId: 'a1',
      requestId: 'send-1',
    },
  }
  return { repo, job }
}

test('готовит длинный prompt и референсы только во время запуска', async (t) => {
  const { repo, job } = await fixture(t)
  const prepared = await preparePromptChatJob(repo, job)
  assert.match(prepared.prompt, /Составь промпт/)
  assert.match(prepared.prompt, /only JSON/u)
  assert.deepEqual(prepared.refs, [{ kind: 'image', src: '/media/ref.png' }])
  assert.ok(prepared.estimatedInputTokens > 0)
  assert.equal(job.prompt, 'Составь промпт')
  assert.deepEqual(job.refs, [])
})

test('выключенная память не читает статистику доски, но сохраняет историю и референсы', async (t) => {
  const { repo, job } = await fixture(t)
  const context: PromptChatContextV1 = {
    version: 1,
    revision: 1,
    summary: {
      goal: 'SUMMARY_MEMORY_SENTINEL',
      facts: [],
      decisions: [],
      constraints: [],
      preferences: [],
      referenceNotes: [],
      openQuestions: [],
      chronology: 'SUMMARY_CHRONOLOGY_SENTINEL',
    },
    summaryThroughMessageId: null,
    checkpoints: [],
    compaction: { status: 'idle' },
  }
  await repo.replaceContext('p1', 'c1', 0, context)
  const boardMemory = extractBoardMemory([{
    kind: 'image',
    modelId: 'claude',
    prompt: 'BOARD_MEMORY_SENTINEL',
    w: 100,
    h: 100,
  }])
  const loaderCalls: string[] = []
  const loader = async (projectId: string) => {
    loaderCalls.push(projectId)
    return boardMemory
  }

  const enabled = await preparePromptChatJob(repo, job, loader)
  assert.match(enabled.prompt, /BOARD_MEMORY_SENTINEL/u)
  assert.match(enabled.prompt, /Составь промпт/u)

  await repo.setBoardMemoryEnabled('p1', false)
  await repo.setBoardMemoryEnabled('p1', true)
  const frozenOff: Job = {
    ...job,
    target: {
      kind: 'prompt-chat',
      projectId: 'p1',
      conversationId: 'c1',
      requestMessageId: 'u1',
      responseMessageId: 'a1',
      requestId: 'send-1',
      boardMemoryEnabled: false,
    },
  }
  const disabled = await preparePromptChatJob(repo, frozenOff, loader)
  assert.doesNotMatch(disabled.prompt, /BOARD_MEMORY_SENTINEL/u)
  assert.match(disabled.prompt, /Составь промпт/u)
  assert.match(disabled.prompt, /PRIOR_DIALOGUE_SENTINEL/u)
  assert.match(disabled.prompt, /SUMMARY_MEMORY_SENTINEL/u)
  assert.match(disabled.prompt, /SUMMARY_CHRONOLOGY_SENTINEL/u)
  assert.deepEqual(disabled.refs, [{ kind: 'image', src: '/media/ref.png' }])
  assert.deepEqual(loaderCalls, ['p1'], 'выключенный job не вызывает загрузчик статистики после re-enable')

  const enabledEstimate = await estimatePromptChatTurn(
    repo, 'p1', 'c1', 'claude', 'Новый вопрос', [], true, loader,
  )
  const disabledEstimate = await estimatePromptChatTurn(
    repo, 'p1', 'c1', 'claude', 'Новый вопрос', [], false, loader,
  )
  assert.ok(enabledEstimate.inputTokens > disabledEstimate.inputTokens)
  assert.ok((enabledEstimate.costUsd ?? 0) >= (disabledEstimate.costUsd ?? 0))
  assert.equal(enabledEstimate.boardMemoryEnabled, true)
  assert.equal(disabledEstimate.boardMemoryEnabled, false)
  assert.deepEqual(loaderCalls, ['p1', 'p1'], 'estimate выключенного режима также не читает статистику')
})

test('доставляет готовый ответ идемпотентно в исходный диалог', async (t) => {
  const { repo, job } = await fixture(t)
  await finalizePromptChatJob(repo, job)
  assert.equal((await repo.findMessage('p1', 'c1', 'a1'))?.status, 'done')
  assert.equal((await repo.findMessage('p1', 'c1', 'a1'))?.reply, 'Готово')
  assert.deepEqual((await repo.findMessage('p1', 'c1', 'a1'))?.referenceNotes, ['Цвет взят из референса'])

  await finalizePromptChatJob(repo, job)
  assert.equal((await repo.loadAll('p1', 'c1')).filter((message) => message.id === 'a1').length, 1)
  assert.deepEqual((await repo.loadMeta('p1', 'c1')).activeJobIds, [])
})

test('доставляет ошибку и снимает активный job', async (t) => {
  const { repo, job } = await fixture(t)
  job.status = 'error'
  job.result = undefined
  job.error = 'потеряна связь с fal'
  await finalizePromptChatJob(repo, job)
  assert.match((await repo.findMessage('p1', 'c1', 'a1'))?.error ?? '', /связь/)
  assert.equal((await repo.findMessage('p1', 'c1', 'a1'))?.status, 'error')
  assert.deepEqual((await repo.loadMeta('p1', 'c1')).activeJobIds, [])
})

test('готовит и применяет внутренний job пересжатия', async (t) => {
  const { repo } = await fixture(t)
  const memory = {
    goal: 'Постер',
    facts: ['Цвет — красный'],
    decisions: [],
    constraints: [],
    preferences: [],
    referenceNotes: [],
    openQuestions: [],
    chronology: 'Выбрали цвет.',
  }
  const job: Job = {
    id: 'compact-1',
    kind: 'text',
    prompt: 'Обновление памяти',
    refs: [],
    model: 'qwen',
    params: {},
    status: 'done',
    result: { text: JSON.stringify(memory) },
    createdAt: 10,
    finishedAt: 11,
    internal: true,
    target: {
      kind: 'prompt-chat-compaction',
      projectId: 'p1',
      conversationId: 'c1',
      fromMessageId: null,
      throughMessageId: 'a1',
      contextRevision: 0,
    },
  }
  const prepared = await prepareCompactionJob(repo, job)
  assert.match(prepared.prompt, /Составь промпт/)
  assert.deepEqual(prepared.refs, [])
  await finalizeCompactionJob(repo, job)
  assert.deepEqual((await repo.loadContext('p1', 'c1')).summary, memory)
})

test('планирует дешёвое пересжатие и фиксирует job в context.json', async (t) => {
  const { repo, job } = await fixture(t)
  await finalizePromptChatJob(repo, job)
  await repo.appendMessages('p1', 'c1', Array.from({ length: 18 }, (_, index) => ({
    id: `extra-${index}`,
    role: 'user' as const,
    text: `Сообщение ${index}`,
    createdAt: 20 + index,
  })))
  let descriptor: { id: string; target: Job['target'] } | null = null
  const scheduled = await schedulePromptChatCompaction(repo, job, {
    confirmCostAboveUsd: 1,
    reserveId: () => 'compact-1',
    createJob: async (value) => {
      descriptor = value
    },
  })
  assert.equal(scheduled, 'queued')
  const createdDescriptor = descriptor as { id: string; target: Job['target'] } | null
  assert.equal(createdDescriptor?.id, 'compact-1')
  assert.equal(createdDescriptor?.target?.kind, 'prompt-chat-compaction')
  assert.equal((await repo.loadContext('p1', 'c1')).compaction.jobId, 'compact-1')
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PromptChatCommands, PromptChatCommandError } from './promptChatCommands.js'
import { PromptChatRepository } from './promptChatStorage.js'

async function fixture(t: test.TestContext, options?: {
  estimateCostUsd?: number
  confirmCostAboveUsd?: number
  createJobError?: Error
  boardMemoryEnabled?: boolean
}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-commands-'))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  let sequence = 0
  const nextId = () => `id-${++sequence}`
  const repo = new PromptChatRepository({ rootDir, now: () => 100 + sequence, id: nextId })
  const createdJobs: unknown[] = []
  const estimatedBoardMemory: Array<boolean | undefined> = []
  const commands = new PromptChatCommands({
    repository: repo,
    now: () => 100 + sequence,
    id: nextId,
    estimateTurn: async (_projectId, _conversationId, modelId, _text, _attachments, boardMemoryEnabled) => {
      estimatedBoardMemory.push(boardMemoryEnabled)
      return {
        modelId,
        inputTokens: 8_000,
        outputTokens: 1_000,
        costUsd: options?.estimateCostUsd ?? 0.01,
        requiresConfirmation: false,
        contextHealth: 'ready',
      }
    },
    getBoardMemoryEnabled: async () => options?.boardMemoryEnabled ?? true,
    getConfirmCostAboveUsd: async () => options?.confirmCostAboveUsd ?? 1,
    createJob: async (descriptor) => {
      createdJobs.push(structuredClone(descriptor))
      if (options?.createJobError) throw options.createJobError
    },
  })
  return { repo, commands, createdJobs, rootDir, estimatedBoardMemory }
}

test('повтор create и send возвращает прежний результат без дублей', async (t) => {
  const { repo, commands, createdJobs } = await fixture(t)
  const first = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'gemini' })
  const repeated = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'gemini' })
  assert.deepEqual(repeated, first)

  const sendPayload = {
    requestId: 'send-1',
    text: 'Составь промпт',
    attachments: [],
  }
  await repo.patchMeta('p1', first.conversation.id, {
    draft: {
      text: 'Составь промпт',
      attachments: [],
      selectionStart: 14,
      selectionEnd: 14,
    },
  })
  const turnA = await commands.beginTurn('p1', first.conversation.id, sendPayload)
  const turnB = await commands.beginTurn('p1', first.conversation.id, sendPayload)
  assert.equal(turnB.jobId, turnA.jobId)
  assert.equal((await repo.loadAll('p1', first.conversation.id)).length, 2)
  assert.equal(createdJobs.length, 1)
  assert.equal(turnA.modelId, 'gemini')
  assert.equal((await repo.loadMeta('p1', first.conversation.id)).title, 'Составь промпт')
  assert.deepEqual((await repo.loadMeta('p1', first.conversation.id)).draft, {
    text: '',
    attachments: [],
    selectionStart: 0,
    selectionEnd: 0,
  })
})

test('первое сообщение переименовывает и старый русский заголовок диалога', async (t) => {
  const { repo, commands } = await fixture(t)
  const created = await commands.create('p1', { requestId: 'create-legacy-title', defaultModelId: 'gemini' })
  await repo.patchMeta('p1', created.conversation.id, { title: 'Новый диалог' })
  await commands.beginTurn('p1', created.conversation.id, {
    requestId: 'send-legacy-title',
    text: 'Use the legacy title',
    attachments: [],
  })
  assert.equal((await repo.loadMeta('p1', created.conversation.id)).title, 'Use the legacy title')
})

test('замораживает выключенную память в оценке, сообщениях и durable job', async (t) => {
  const { repo, commands, createdJobs, estimatedBoardMemory } = await fixture(t)
  const created = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'gemini' })
  const turn = await commands.beginTurn('p1', created.conversation.id, {
    requestId: 'send-memory-off',
    text: 'Ответь без контекста доски',
    attachments: [],
    boardMemoryEnabled: false,
  })

  assert.deepEqual(estimatedBoardMemory, [false])
  assert.deepEqual((createdJobs[0] as { boardMemoryEnabled?: boolean }).boardMemoryEnabled, false)
  const messages = await repo.loadAll('p1', created.conversation.id)
  assert.equal(messages[0]?.boardMemoryEnabled, false)
  assert.equal(messages[1]?.boardMemoryEnabled, false)
  assert.equal(turn.userMessage.boardMemoryEnabled, false)
})

test('без явного флага берёт сохранённую настройку проекта и замораживает её в job', async (t) => {
  const { repo, commands, createdJobs, estimatedBoardMemory } = await fixture(t, { boardMemoryEnabled: false })
  const created = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'gemini' })
  await commands.beginTurn('p1', created.conversation.id, {
    requestId: 'send-persisted-memory',
    text: 'Используй только историю',
    attachments: [],
  })
  assert.deepEqual(estimatedBoardMemory, [false])
  assert.equal((createdJobs[0] as { boardMemoryEnabled?: boolean }).boardMemoryEnabled, false)
  assert.equal((await repo.loadAll('p1', created.conversation.id))[0]?.boardMemoryEnabled, false)
})

test('отвергает повреждённый boardMemoryEnabled до записи истории', async (t) => {
  const { repo, commands } = await fixture(t)
  const created = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'gemini' })
  assert.throws(
    () => commands.beginTurn('p1', created.conversation.id, {
      requestId: 'send-invalid-memory',
      text: 'Ответь',
      attachments: [],
      boardMemoryEnabled: 'false' as never,
    }),
    /Invalid boardMemoryEnabled value/u,
  )
  assert.deepEqual(await repo.loadAll('p1', created.conversation.id), [])
})

test('повтор send восстанавливает результат, если receipt не записался после создания задачи', async (t) => {
  const { repo, commands, createdJobs, rootDir } = await fixture(t)
  const created = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'gemini' })
  const input = { requestId: 'send-after-receipt-failure', text: 'Ответь', attachments: [] }
  const requestsFile = path.join(rootDir, 'p1', 'requests.json')
  const realRename = fs.rename
  const renameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const [source, destination] = args
    if (
      typeof source === 'string'
      && typeof destination === 'string'
      && destination === requestsFile
      && source.startsWith(`${requestsFile}.`)
      && source.endsWith('.tmp')
    ) {
      throw new Error('simulated receipt write failure')
    }
    return realRename(...args)
  })

  await assert.rejects(
    () => commands.beginTurn('p1', created.conversation.id, input),
    /simulated receipt write failure/,
  )
  renameMock.mock.restore()

  const expectedJobId = (await repo.loadAll('p1', created.conversation.id)).at(-1)?.jobId
  const repeated = await commands.beginTurn('p1', created.conversation.id, input)
  assert.equal(repeated.jobId, expectedJobId)
  assert.equal(createdJobs.length, 1)
})

test('фиксирует вход сценария с референсами без запуска модели', async (t) => {
  const { repo, commands, createdJobs } = await fixture(t)
  const created = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'gemini' })
  const input = {
    requestId: 'scenario-input-1',
    text: 'Сделай постер в стиле референса',
    attachments: [{
      shapeId: 'ref-1',
      kind: 'image' as const,
      label: 'Референс',
      src: '/media/reference.png',
    }],
  }

  const first = await commands.recordUserMessage('p1', created.conversation.id, input)
  const repeated = await commands.recordUserMessage('p1', created.conversation.id, input)

  assert.deepEqual(repeated, first)
  assert.deepEqual(await repo.loadAll('p1', created.conversation.id), [first.userMessage])
  assert.deepEqual(first.userMessage.attachments, input.attachments)
  assert.equal(createdJobs.length, 0)
  assert.equal((await repo.loadMeta('p1', created.conversation.id)).title, 'Сделай постер в стиле референса')
})

test('сохраняет события сценария в истории идемпотентно', async (t) => {
  const { repo, commands } = await fixture(t)
  const created = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'gemini' })
  const appendHistoryMessagesMethod = (commands as unknown as {
    appendHistoryMessages?: (projectId: string, conversationId: string, input: {
      requestId: string
      messages: Array<{ role: 'user' | 'assistant'; text: string; reply?: string }>
    }) => Promise<{ messages: Array<{ role: string; text: string; reply?: string }> }>
  }).appendHistoryMessages
  const appendHistoryMessages = appendHistoryMessagesMethod?.bind(commands)

  assert.equal(typeof appendHistoryMessages, 'function')
  if (!appendHistoryMessages) return
  const input = {
    requestId: 'macro-history-1',
    messages: [
      { role: 'user' as const, text: '▶ Цепочка «Бриф»' },
      { role: 'assistant' as const, text: '', reply: 'Готовый бриф для кампании' },
    ],
  }

  const first = await appendHistoryMessages('p1', created.conversation.id, input)
  const repeated = await appendHistoryMessages('p1', created.conversation.id, input)

  assert.deepEqual(repeated, first)
  assert.deepEqual(
    (await repo.loadAll('p1', created.conversation.id)).map((message) => message.reply || message.text),
    ['▶ Цепочка «Бриф»', 'Готовый бриф для кампании'],
  )
})

test('не удаляет диалог с активным ответом, после остановки удаляет и восстанавливает', async (t) => {
  const { repo, commands } = await fixture(t)
  const created = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'gemini' })
  const id = created.conversation.id
  await commands.beginTurn('p1', id, {
    requestId: 'send-1',
    text: 'Ответь',
    attachments: [],
  })

  await assert.rejects(() => commands.trash('p1', id, 'delete-1'), /Stop the response before deleting the chat/)
  await repo.patchMeta('p1', id, { activeJobIds: [] })
  assert.deepEqual(await commands.trash('p1', id, 'delete-2'), { ok: true })
  const restored = await commands.restore('p1', id, 'restore-1')
  assert.equal(restored.conversation.id, id)
})

test('требует подтверждение рассчитанной цены до записи сообщений', async (t) => {
  const { repo, commands } = await fixture(t, {
    estimateCostUsd: 0.5,
    confirmCostAboveUsd: 0.1,
  })
  const created = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'claude' })

  await assert.rejects(
    () => commands.beginTurn('p1', created.conversation.id, {
      requestId: 'send-expensive',
      text: 'Длинный ответ',
      attachments: [],
    }),
    (error: unknown) => (
      error instanceof PromptChatCommandError
      && error.code === 'PROMPT_CHAT_COST_CONFIRM_REQUIRED'
      && error.estimate?.costUsd === 0.5
    ),
  )
  assert.deepEqual(await repo.loadAll('p1', created.conversation.id), [])

  const accepted = await commands.beginTurn('p1', created.conversation.id, {
    requestId: 'send-expensive',
    text: 'Длинный ответ',
    attachments: [],
    confirmedCostUsd: 0.5,
  })
  assert.equal(accepted.modelId, 'claude')
})

test('ошибка создания job снимает вечный спиннер и оставляет повторяемую ошибку', async (t) => {
  const { repo, commands } = await fixture(t, { createJobError: new Error('jobs.json недоступен') })
  const created = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'gemini' })

  await assert.rejects(
    () => commands.beginTurn('p1', created.conversation.id, {
      requestId: 'send-1',
      text: 'Ответь',
      attachments: [],
    }),
    /Could not create the Assistant job/,
  )
  const messages = await repo.loadAll('p1', created.conversation.id)
  assert.equal(messages.at(-1)?.status, 'error')
  assert.deepEqual((await repo.loadPage('p1', created.conversation.id, { limit: 50 })).meta.activeJobIds, [])
})

test('shutdown во время durable create сохраняет специальный 503-код', async (t) => {
  const shuttingDown = new PromptChatCommandError(
    'CanAI завершает работу — повторите после перезапуска',
    'PROMPT_CHAT_SHUTTING_DOWN',
  )
  const { commands } = await fixture(t, { createJobError: shuttingDown })
  const created = await commands.create('p1', { requestId: 'create-1', defaultModelId: 'gemini' })

  await assert.rejects(
    () => commands.beginTurn('p1', created.conversation.id, {
      requestId: 'send-during-shutdown',
      text: 'Ответь',
      attachments: [],
    }),
    (error: unknown) => (
      error instanceof PromptChatCommandError
      && error.code === 'PROMPT_CHAT_SHUTTING_DOWN'
    ),
  )
})

test('ограничивает историю receipt-файла последними 128 командами', async (t) => {
  const { repo, rootDir } = await fixture(t)
  for (let index = 0; index < 140; index += 1) {
    await repo.withIdempotency('p1', 'project', `request-${index}`, 'patch', async () => ({ index }))
  }
  const receipts = JSON.parse(await fs.readFile(path.join(rootDir, 'p1', 'requests.json'), 'utf8')) as {
    receipts: Array<{ requestId: string }>
  }
  assert.equal(receipts.receipts.length, 128)
  assert.equal(receipts.receipts[0].requestId, 'request-12')
})

test('параллельные requestId не теряют receipt друг друга', async (t) => {
  const { repo, rootDir } = await fixture(t)
  await Promise.all(Array.from({ length: 20 }, (_, index) => (
    repo.withIdempotency('p1', 'project', `parallel-${index}`, 'patch', async () => ({ index }))
  )))

  const receipts = JSON.parse(await fs.readFile(path.join(rootDir, 'p1', 'requests.json'), 'utf8')) as {
    receipts: Array<{ requestId: string }>
  }
  assert.equal(receipts.receipts.length, 20)
})

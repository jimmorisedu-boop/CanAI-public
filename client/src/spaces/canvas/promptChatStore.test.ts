import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../api'
import type { Job } from '../../types'
import type { GenerationSink, GenerationTarget } from './generationRegistry'
import {
  boardMemoryToggleShown,
  createPromptChatStore,
  type PromptChatStoreDeps,
} from './promptChatStore'
import type {
  BeginTurnInput,
  BeginTurnResult,
  ConversationPage,
  ConversationPatch,
  PromptChatDraft,
  PromptChatEstimate,
  PromptChatIndexV2,
  PromptChatMetaV2,
  PromptChatSummary,
} from './promptChatTypes'

const emptyDraft = (): PromptChatDraft => ({
  text: '',
  attachments: [],
  selectionStart: 0,
  selectionEnd: 0,
})

function summary(id: string, updatedAt: number, attention: PromptChatSummary['attention'] = 'idle'): PromptChatSummary {
  return {
    id,
    title: `Диалог ${id}`,
    createdAt: updatedAt,
    updatedAt,
    preview: '',
    attention,
  }
}

function meta(projectId: string, id: string, modelId = 'gemini'): PromptChatMetaV2 {
  return {
    version: 2,
    revision: 0,
    id,
    projectId,
    title: `Диалог ${id}`,
    selectedModelId: modelId,
    createdAt: 1,
    updatedAt: 1,
    draft: emptyDraft(),
    activeJobIds: [],
  }
}

function page(value: PromptChatMetaV2, messages: ConversationPage['messages'] = []): ConversationPage {
  return { meta: structuredClone(value), messages: structuredClone(messages), before: null, contextHealth: 'ready' }
}

function fakeDeps() {
  const projectId = 'p1'
  let idCounter = 0
  const conversations = new Map<string, ConversationPage>()
  conversations.set('c1', page(meta(projectId, 'c1')))
  conversations.set('c2', page(meta(projectId, 'c2', 'claude')))
  let activeId = 'c1'
  let boardMemoryEnabled = true
  let trash: PromptChatSummary[] = []
  let sink: GenerationSink | null = null
  const calls: Array<{ name: string; args: unknown[] }> = []
  const tracked: Array<{ target: GenerationTarget; jobId: string }> = []
  const timers = new Map<number, () => void>()
  let timerId = 0

  function listIndex(): PromptChatIndexV2 {
    return {
      version: 2,
      revision: 1,
      activeConversationId: activeId,
      conversations: [...conversations.values()]
        .map(({ meta: item, messages }) => ({
          ...summary(item.id, item.updatedAt),
          title: item.title,
          preview: messages.at(-1)?.reply || messages.at(-1)?.text || '',
          attention: item.activeJobIds.length ? 'running' : 'idle',
        }))
        .sort((left, right) => right.updatedAt - left.updatedAt),
      hasTrash: trash.length > 0,
      boardMemoryEnabled,
    }
  }

  const deps: PromptChatStoreDeps = {
    listPromptChats: async () => {
      calls.push({ name: 'list', args: [] })
      return { index: listIndex(), boardMemoryControlSupported: true }
    },
    setPromptChatPreferences: async (_projectId, patch) => {
      calls.push({ name: 'preference', args: [structuredClone(patch)] })
      boardMemoryEnabled = patch.boardMemoryEnabled
      return { index: listIndex(), boardMemoryControlSupported: true }
    },
    createPromptChat: async (_projectId, requestId) => {
      calls.push({ name: 'create', args: [requestId] })
      const reusable = [...conversations.values()].find((item) => item.messages.length === 0 && !item.meta.draft.text)
      if (reusable) {
        activeId = reusable.meta.id
        return { conversation: structuredClone(reusable.meta) }
      }
      const id = `c${conversations.size + 1}`
      const created = meta(projectId, id)
      conversations.set(id, page(created))
      activeId = id
      return { conversation: structuredClone(created) }
    },
    loadPromptChatPage: async (_projectId, conversationId, before) => {
      calls.push({ name: 'page', args: [conversationId, before] })
      const current = conversations.get(conversationId)
      assert.ok(current)
      return structuredClone(current)
    },
    patchPromptChat: async (_projectId, conversationId, requestId, patch: ConversationPatch) => {
      calls.push({ name: 'patch', args: [conversationId, requestId, structuredClone(patch)] })
      const current = conversations.get(conversationId)
      assert.ok(current)
      current.meta = {
        ...current.meta,
        ...structuredClone(patch),
        revision: current.meta.revision + 1,
        updatedAt: current.meta.updatedAt + 1,
      }
      return { meta: structuredClone(current.meta) }
    },
    activatePromptChat: async (_projectId, conversationId, requestId) => {
      calls.push({ name: 'activate', args: [conversationId, requestId] })
      activeId = conversationId
      const current = conversations.get(conversationId)
      assert.ok(current)
      const lastDone = [...current.messages].reverse().find((message) => (
        message.role === 'assistant' && message.status === 'done'
      ))
      if (lastDone) current.meta.lastReadAssistantMessageId = lastDone.id
      return { meta: structuredClone(current.meta) }
    },
    estimatePromptChatMessage: async (_projectId, conversationId, text, attachments, boardMemoryEnabled) => {
      calls.push({ name: 'estimate', args: [conversationId, text, structuredClone(attachments), boardMemoryEnabled] })
      return {
        modelId: conversations.get(conversationId)!.meta.selectedModelId,
        inputTokens: 100,
        outputTokens: 200,
        costUsd: 0.02,
        requiresConfirmation: false,
        contextHealth: 'ready',
        boardMemoryEnabled,
      }
    },
    sendPromptChatMessage: async (_projectId, conversationId, input: BeginTurnInput) => {
      calls.push({ name: 'send', args: [conversationId, structuredClone(input)] })
      const current = conversations.get(conversationId)
      assert.ok(current)
      const jobId = `job-${++idCounter}`
      const userMessage = {
        id: `user-${idCounter}`,
        role: 'user' as const,
        text: input.text,
        createdAt: 10 + idCounter,
        attachments: structuredClone(input.attachments),
      }
      const assistantMessage = {
        id: `assistant-${idCounter}`,
        role: 'assistant' as const,
        text: '',
        createdAt: 11 + idCounter,
        status: 'queued' as const,
        jobId,
        requestMessageId: userMessage.id,
        modelId: current.meta.selectedModelId,
      }
      current.messages.push(userMessage, assistantMessage)
      current.meta.activeJobIds = [jobId]
      return {
        revision: ++current.meta.revision,
        jobId,
        userMessage,
        assistantMessage,
        modelId: current.meta.selectedModelId,
      } satisfies BeginTurnResult
    },
    recordPromptChatMessage: async (_projectId, conversationId, input) => {
      calls.push({ name: 'record', args: [conversationId, structuredClone(input)] })
      const current = conversations.get(conversationId)
      assert.ok(current)
      const userMessage = {
        id: `record-${++idCounter}`,
        role: 'user' as const,
        text: input.text,
        createdAt: 10 + idCounter,
        attachments: structuredClone(input.attachments),
      }
      current.messages.push(userMessage)
      current.meta = {
        ...current.meta,
        revision: current.meta.revision + 1,
        updatedAt: userMessage.createdAt,
        draft: emptyDraft(),
      }
      return { userMessage, meta: structuredClone(current.meta) }
    },
    appendPromptChatHistoryMessages: async (_projectId, conversationId, input) => {
      calls.push({ name: 'append-history', args: [conversationId, structuredClone(input)] })
      const current = conversations.get(conversationId)
      assert.ok(current)
      const messages = input.messages.map((message) => ({
        id: `history-${++idCounter}`,
        role: message.role,
        text: message.text,
        createdAt: 10 + idCounter,
        ...(message.role === 'assistant' ? { reply: message.reply } : {}),
      }))
      current.messages.push(...messages)
      current.meta = {
        ...current.meta,
        revision: current.meta.revision + 1,
        updatedAt: messages.at(-1)?.createdAt ?? current.meta.updatedAt,
      }
      return { messages: structuredClone(messages), meta: structuredClone(current.meta) }
    },
    rebuildPromptChatContext: async (_projectId, conversationId) => {
      calls.push({ name: 'rebuild-context', args: [conversationId] })
      const current = conversations.get(conversationId)
      assert.ok(current)
      current.contextHealth = 'ready'
      return { status: 'queued' }
    },
    trashPromptChat: async (_projectId, conversationId, requestId) => {
      calls.push({ name: 'trash', args: [conversationId, requestId] })
      const current = conversations.get(conversationId)
      assert.ok(current)
      trash.unshift(summary(conversationId, current.meta.updatedAt))
      conversations.delete(conversationId)
      activeId = conversations.keys().next().value ?? ''
      return { ok: true }
    },
    listPromptChatTrash: async () => ({ conversations: structuredClone(trash) }),
    restorePromptChat: async (_projectId, conversationId, requestId) => {
      calls.push({ name: 'restore', args: [conversationId, requestId] })
      const restored = meta(projectId, conversationId)
      conversations.set(conversationId, page(restored))
      trash = trash.filter((item) => item.id !== conversationId)
      activeId = conversationId
      return { conversation: structuredClone(restored) }
    },
    deletePromptChatPermanent: async (_projectId, conversationId, requestId) => {
      calls.push({ name: 'permanent', args: [conversationId, requestId] })
      trash = trash.filter((item) => item.id !== conversationId)
      return { ok: true }
    },
    cancelGeneration: async (jobId) => {
      calls.push({ name: 'cancel', args: [jobId] })
    },
    trackGeneration: (target, jobId) => {
      tracked.push({ target, jobId })
    },
    registerSink: (_projectId, nextSink) => {
      sink = nextSink
      return () => {
        if (sink === nextSink) sink = null
      }
    },
    confirmCost: async () => true,
    schedule: (callback) => {
      const id = ++timerId
      timers.set(id, callback)
      return id
    },
    unschedule: (id) => {
      timers.delete(id as number)
    },
    id: () => `request-${++idCounter}`,
  }

  return {
    deps,
    calls,
    tracked,
    conversations,
    listIndex,
    get sink() {
      return sink
    },
    async flushTimers() {
      const pending = [...timers.values()]
      timers.clear()
      for (const callback of pending) {
        callback()
        await Promise.resolve()
      }
      await Promise.resolve()
    },
    async deliver(job: Job, target: GenerationTarget) {
      assert.ok(sink)
      await sink(job, target)
      await Promise.resolve()
    },
  }
}

test('переключатель памяти доски сохраняется в индексе и замораживает false для оценки и отправки', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')

  assert.equal(store.getSnapshot('p1').boardMemoryControlSupported, true)
  await store.setBoardMemoryEnabled('p1', false)
  assert.equal(store.getSnapshot('p1').boardMemoryEnabled, false)
  assert.deepEqual(fake.calls.find((call) => call.name === 'preference')?.args[0], { boardMemoryEnabled: false })
  const reloaded = createPromptChatStore(fake.deps)
  await reloaded.loadProject('p1')
  assert.equal(reloaded.getSnapshot('p1').boardMemoryEnabled, false, 'значение приходит из индекса после reload')

  await store.estimate('p1', 'Проверь', [])
  await store.send('p1', 'Сделай', [])
  const estimate = fake.calls.find((call) => call.name === 'estimate')
  const send = fake.calls.find((call) => call.name === 'send')
  assert.equal(estimate?.args[3], false)
  assert.equal((send?.args[1] as BeginTurnInput).boardMemoryEnabled, false)
})

test('сохранение памяти доски блокирует отправку до ответа сервера и откатывает после сбоя', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const originalSet = fake.deps.setPromptChatPreferences!
  fake.deps.setPromptChatPreferences = async (...args) => {
    await waiting
    return originalSet(...args)
  }

  const saving = store.setBoardMemoryEnabled('p1', false)
  await Promise.resolve()
  assert.equal(store.getSnapshot('p1').boardMemorySaving, true)
  const sending = store.send('p1', 'Не отправляй пока сохраняется', [])
  await Promise.resolve()
  assert.equal(fake.calls.filter((call) => call.name === 'send').length, 0)
  release()
  await Promise.all([saving, sending])
  assert.equal((fake.calls.find((call) => call.name === 'send')?.args[1] as BeginTurnInput).boardMemoryEnabled, false)

  fake.deps.setPromptChatPreferences = async (...args) => {
    // The PATCH reached the server, but its response was lost. Reloading the
    // index must win over the optimistic value/error path.
    await originalSet(...args)
    throw new Error('Ответ потерян')
  }
  await assert.rejects(() => store.setBoardMemoryEnabled('p1', true), /Ответ потерян/u)
  assert.equal(store.getSnapshot('p1').boardMemoryEnabled, true, 'после потерянного ответа берём durable index')
  assert.equal(store.getSnapshot('p1').boardMemorySaving, false)
})

test('обычная отправка закрепляет исходный диалог во время ожидания памяти доски', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const originalSet = fake.deps.setPromptChatPreferences!
  fake.deps.setPromptChatPreferences = async (...args) => {
    await waiting
    return originalSet(...args)
  }

  const saving = store.setBoardMemoryEnabled('p1', false)
  await Promise.resolve()
  const sending = store.send('p1', 'Закреплённый вопрос', [])
  await store.selectConversation('p1', 'c2')
  release()
  await Promise.all([saving, sending])

  const send = fake.calls.find((call) => call.name === 'send')
  assert.equal(send?.args[0], 'c1', 'смена активного диалога не должна перенаправить уже начатый вопрос')
})

test('адресная отправка отказывается, если закреплённый диалог удалили', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  await store.trash('p1', 'c1')

  await assert.rejects(
    () => store.sendToConversation('p1', 'c1', 'Не отправляй', []),
    /selected chat is no longer available/u,
  )
  assert.equal(fake.calls.filter((call) => call.name === 'send').length, 0)
})

test('старый local server без capability leaves the switch unsupported while requests stay enabled', async () => {
  const fake = fakeDeps()
  fake.deps.listPromptChats = async () => ({ index: { ...fake.listIndex(), boardMemoryEnabled: false } })
  const store = createPromptChatStore(fake.deps)
  await assert.rejects(() => store.setBoardMemoryEnabled('p1', false), /does not support board memory switch/u)
  await store.loadProject('p1')
  const snapshot = store.getSnapshot('p1')
  assert.equal(snapshot.boardMemoryControlSupported, false)
  assert.equal(snapshot.boardMemoryEnabled, true, 'unsupported envelope cannot turn memory off')
  await store.send('p1', 'Legacy request', [])
  assert.equal((fake.calls.find((call) => call.name === 'send')?.args[1] as BeginTurnInput).boardMemoryEnabled, true)
})

test('ошибка pending save отменяет ожидающие estimate и send', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  let rejectSave!: (error: Error) => void
  fake.deps.setPromptChatPreferences = () => new Promise((_, reject) => { rejectSave = reject })

  const saving = store.setBoardMemoryEnabled('p1', false)
  for (let attempt = 0; attempt < 4 && !rejectSave; attempt += 1) await Promise.resolve()
  assert.equal(typeof rejectSave, 'function')
  const estimating = store.estimate('p1', 'Проверь', [])
  const sending = store.send('p1', 'Не отправляй', [])
  rejectSave(new Error('Сервер недоступен'))
  await assert.rejects(saving, /Сервер недоступен/u)
  await assert.rejects(estimating, /Сервер недоступен/u)
  await assert.rejects(sending, /Сервер недоступен/u)
  assert.equal(fake.calls.filter((call) => call.name === 'estimate').length, 0)
  assert.equal(fake.calls.filter((call) => call.name === 'send').length, 0)
  assert.equal(store.getSnapshot('p1').boardMemoryEnabled, true)
})

test('переключает диалоги и сохраняет независимые модель и черновик', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')

  await store.patchDraft('p1', {
    text: 'Первый',
    attachments: [],
    selectionStart: 6,
    selectionEnd: 6,
  })
  await fake.flushTimers()
  await store.selectConversation('p1', 'c2')
  await store.setModel('p1', 'qwen')
  await store.patchDraft('p1', {
    text: 'Второй',
    attachments: [],
    selectionStart: 6,
    selectionEnd: 6,
  })
  await fake.flushTimers()
  await store.selectConversation('p1', 'c1')

  assert.equal(store.getSnapshot('p1').active?.meta.draft.text, 'Первый')
  assert.equal(store.getSnapshot('p1').active?.meta.selectedModelId, 'gemini')
  await store.selectConversation('p1', 'c2')
  assert.equal(store.getSnapshot('p1').active?.meta.draft.text, 'Второй')
  assert.equal(store.getSnapshot('p1').active?.meta.selectedModelId, 'qwen')
})

test('не создаёт дубликат пустого диалога', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  const first = store.getSnapshot('p1').activeId

  const created = await store.createConversation('p1')

  assert.equal(created.id, first)
  assert.equal(store.getSnapshot('p1').list.length, 2)
})

test('смена модели относится только к следующей отправке', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')

  const first = await store.send('p1', 'Первый', [])
  await store.setModel('p1', 'claude')

  assert.equal(first.assistantMessage.modelId, 'gemini')
  assert.equal(store.getSnapshot('p1').active?.messages.at(-1)?.modelId, 'gemini')
  assert.equal(store.getSnapshot('p1').active?.meta.selectedModelId, 'claude')
})

test('сохраняет вход сценария с референсами без запроса к помощнику', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  const attachments = [{
    shapeId: 'ref-1',
    kind: 'image' as const,
    label: 'Референс',
    src: '/media/reference.png',
  }]

  await store.recordUserMessage('p1', 'Сделай постер в стиле референса', attachments)

  assert.equal(fake.calls.filter((call) => call.name === 'send').length, 0)
  assert.equal(fake.calls.filter((call) => call.name === 'record').length, 1)
  const message = store.getSnapshot('p1').active?.messages.at(-1)
  assert.equal(message?.role, 'user')
  assert.equal(message?.text, 'Сделай постер в стиле референса')
  assert.deepEqual(message?.attachments, attachments)
})

test('сохраняет результаты сценария в истории после перезагрузки страницы', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')

  await store.appendMessages('p1', 'c1', [
    { role: 'user', text: '▶ Цепочка «Бриф»' },
    { role: 'assistant', text: '', reply: 'Готовый бриф для кампании' },
  ])

  const reloadedStore = createPromptChatStore(fake.deps)
  await reloadedStore.loadProject('p1')

  assert.deepEqual(
    reloadedStore.getSnapshot('p1').active?.messages.map((message) => message.reply || message.text),
    ['▶ Цепочка «Бриф»', 'Готовый бриф для кампании'],
  )
})

test('успешная отправка очищает только отправленный черновик', async () => {
  const fake = fakeDeps()
  const originalSend = fake.deps.sendPromptChatMessage
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  fake.deps.sendPromptChatMessage = async (...args) => {
    await waiting
    return originalSend(...args)
  }
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  await store.patchDraft('p1', {
    text: 'Отправляю',
    attachments: [],
    selectionStart: 9,
    selectionEnd: 9,
  })

  const sending = store.send('p1', 'Отправляю', [])
  await store.patchDraft('p1', {
    text: 'Уже следующий вопрос',
    attachments: [],
    selectionStart: 19,
    selectionEnd: 19,
  })
  release()
  await sending

  assert.equal(store.getSnapshot('p1').active?.meta.draft.text, 'Уже следующий вопрос')
})

test('loadOlder добавляет ранние сообщения без дублей', async () => {
  const fake = fakeDeps()
  const active = fake.conversations.get('c1')!
  active.messages = [{
    id: 'm2',
    role: 'user',
    text: 'Позднее',
    createdAt: 2,
  }]
  active.before = '000001.json:1'
  let olderLoaded = false
  fake.deps.loadPromptChatPage = async (_projectId, _conversationId, before) => {
    if (!before) return structuredClone(active)
    olderLoaded = true
    return {
      ...structuredClone(active),
      messages: [
        { id: 'm1', role: 'user', text: 'Ранее', createdAt: 1 },
        { id: 'm2', role: 'user', text: 'Позднее', createdAt: 2 },
      ],
      before: null,
    }
  }
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')

  await store.loadOlder('p1')

  assert.equal(olderLoaded, true)
  assert.deepEqual(store.getSnapshot('p1').active?.messages.map((item) => item.id), ['m1', 'm2'])
})

test('готовая фоновая задача обновляет исходный диалог и помечает его непрочитанным', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  await store.send('p1', 'Фоновый вопрос', [])
  const target = fake.tracked.at(-1)!.target
  await store.selectConversation('p1', 'c2')
  const original = fake.conversations.get('c1')!
  original.meta.activeJobIds = []
  original.messages[1] = {
    ...original.messages[1],
    status: 'done',
    reply: 'Фоновый ответ',
  }

  await fake.deliver({
    id: fake.tracked.at(-1)!.jobId,
    kind: 'text',
    prompt: '',
    status: 'done',
    result: { text: 'ignored by client' },
  }, target)

  assert.equal(store.getSnapshot('p1').activeId, 'c2')
  assert.equal(store.getSnapshot('p1').list.find((item) => item.id === 'c1')?.attention, 'unread')
  await store.selectConversation('p1', 'c1')
  assert.equal(store.getSnapshot('p1').active?.messages.at(-1)?.reply, 'Фоновый ответ')
  await store.refreshList('p1')
  assert.equal(store.getSnapshot('p1').list.find((item) => item.id === 'c1')?.attention, 'idle')
})

test('повторяет чтение готового ответа после обрыва, без новой отправки вопроса', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  await store.send('p1', 'Вопрос с планшета', [])
  const { target, jobId } = fake.tracked.at(-1)!
  const original = fake.conversations.get('c1')!
  original.meta.activeJobIds = []
  original.messages[1] = { ...original.messages[1], status: 'done', reply: 'Сохранённый ответ' }
  const read = fake.deps.loadPromptChatPage
  let fail = true
  fake.deps.loadPromptChatPage = (...args) => {
    if (fail) return Promise.reject(new Error('Сеть оборвалась'))
    return read(...args)
  }
  await fake.deliver({ id: jobId, kind: 'text', prompt: '', status: 'done' }, target)
  assert.notEqual(store.getSnapshot('p1').active?.messages.at(-1)?.status, 'done')
  fail = false
  await fake.flushTimers()
  for (let i = 0; i < 20; i++) await Promise.resolve()
  assert.equal(store.getSnapshot('p1').active?.messages.at(-1)?.reply, 'Сохранённый ответ')
  assert.equal(store.getSnapshot('p1').localError, undefined)
  assert.equal(fake.calls.filter((call) => call.name === 'send').length, 1)
})

test('после перезапуска регистрирует activeJobIds открытого и фонового диалога', async () => {
  const fake = fakeDeps()
  fake.conversations.get('c1')!.meta.activeJobIds = ['job-active']
  fake.conversations.get('c2')!.meta.activeJobIds = ['job-background']
  fake.deps.listPromptChats = async () => ({
    index: {
      version: 2,
      revision: 2,
      activeConversationId: 'c1',
      conversations: [summary('c1', 2, 'running'), summary('c2', 1, 'running')],
      hasTrash: false,
    },
  })
  const store = createPromptChatStore(fake.deps)

  await store.loadProject('p1')

  assert.deepEqual(fake.tracked.map((item) => item.jobId).sort(), ['job-active', 'job-background'])
})

test('удаляет в корзину и восстанавливает без потери списка', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')

  await store.trash('p1', 'c1')
  assert.equal(store.getSnapshot('p1').list.some((item) => item.id === 'c1'), false)
  assert.equal(store.getSnapshot('p1').trash.some((item) => item.id === 'c1'), true)

  await store.restore('p1', 'c1')
  assert.equal(store.getSnapshot('p1').list.some((item) => item.id === 'c1'), true)
  assert.equal(store.getSnapshot('p1').trash.some((item) => item.id === 'c1'), false)
})

test('debounce черновика объединяет частые изменения в одну запись', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')

  for (let index = 1; index <= 10; index += 1) {
    const text = 'а'.repeat(index)
    await store.patchDraft('p1', {
      text,
      attachments: [],
      selectionStart: index,
      selectionEnd: index,
    })
  }
  assert.equal(fake.calls.filter((call) => call.name === 'patch').length, 0)

  await fake.flushTimers()

  const patches = fake.calls.filter((call) => call.name === 'patch')
  assert.equal(patches.length, 1)
  assert.equal((patches[0].args[2] as ConversationPatch).draft?.text, 'а'.repeat(10))
})

test('повтор памяти обновляет только активный диалог', async () => {
  const fake = fakeDeps()
  fake.conversations.get('c1')!.contextHealth = 'stale'
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')

  await store.rebuildContext('p1')

  assert.deepEqual(
    fake.calls.filter((call) => call.name === 'rebuild-context').map((call) => call.args[0]),
    ['c1'],
  )
  assert.equal(store.getSnapshot('p1').active?.contextHealth, 'ready')
})

test('подтверждает серверную цену и повторяет тот же requestId', async () => {
  const fake = fakeDeps()
  const sends: BeginTurnInput[] = []
  let attempt = 0
  fake.deps.sendPromptChatMessage = async (_projectId, _conversationId, input) => {
    sends.push(structuredClone(input))
    if (attempt++ === 0) {
      const error = new ApiError('Подтвердите стоимость', 'PROMPT_CHAT_COST_CONFIRM_REQUIRED', 409)
      error.estimate = {
        modelId: 'gemini',
        inputTokens: 100,
        outputTokens: 200,
        costUsd: 0.07,
        requiresConfirmation: true,
        contextHealth: 'ready',
      } satisfies PromptChatEstimate
      throw error
    }
    return {
      revision: 1,
      jobId: 'job-confirmed',
      modelId: 'gemini',
      userMessage: { id: 'u', role: 'user', text: input.text, createdAt: 1 },
      assistantMessage: {
        id: 'a',
        role: 'assistant',
        text: '',
        createdAt: 2,
        status: 'queued',
        jobId: 'job-confirmed',
        requestMessageId: 'u',
        modelId: 'gemini',
      },
    }
  }
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')

  await store.send('p1', 'Дорогой запрос', [])

  assert.equal(sends.length, 2)
  assert.equal(sends[0].requestId, sends[1].requestId)
  assert.equal(sends[1].confirmedCostUsd, 0.07)
})

// ⚠️ 02.10.2026. Диалоги доски просят сразу двое (окно помощника и полка; в
// разработке — двойной запуск эффектов). Обе загрузки видели пустой список и
// обе заводили первый диалог: на новой доске оказывались два «Новых диалога».
test('две загрузки доски разом заводят один первый диалог', async () => {
  const fake = fakeDeps()
  fake.conversations.clear()
  const store = createPromptChatStore(fake.deps)

  await Promise.all([store.loadProject('p1'), store.loadProject('p1'), store.loadProject('p1')])

  assert.equal(fake.calls.filter((call) => call.name === 'create').length, 1)
  assert.equal(store.getSnapshot('p1').loadState, 'ready')
  assert.equal(store.getSnapshot('p1').list.length, 1)
})

test('принудительная загрузка ждёт идущую и перечитывает список после неё', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)

  await Promise.all([store.loadProject('p1'), store.loadProject('p1', true)])

  // первая загрузка и повтор по требованию — по списку на каждую, не вперемешку
  assert.equal(fake.calls.filter((call) => call.name === 'list').length, 2)
  assert.equal(store.getSnapshot('p1').loadState, 'ready')
})

// ⚠️ Кто ответит, решает сервер: на сетевой доске — включённый помощник со своей
// моделью. В шапке диалога оставалась прежняя модель: стояло «Gemini», а вопрос
// уходил помощнику с Claude, и после ответа надпись не менялась.
test('после отправки в шапке диалога — модель, которой вопрос ушёл на деле', async () => {
  const fake = fakeDeps()
  const send = fake.deps.sendPromptChatMessage
  fake.deps.sendPromptChatMessage = async (projectId, conversationId, input) => ({
    ...(await send(projectId, conversationId, input)),
    modelId: 'claude',
  })
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  assert.equal(store.getSnapshot('p1').active?.meta.selectedModelId, 'gemini')

  await store.send('p1', 'Вопрос', [])

  assert.equal(store.getSnapshot('p1').active?.meta.selectedModelId, 'claude')
})

// ⚠️ 09.10.2026. Одна негодная страница активного диалога выбрасывала и уже
// полученный список: в ящике пусто, открыть соседний исправный диалог нельзя, и
// спасал только «+». Список и корзина обязаны остаться.
test('не загрузилась страница активного диалога: список и корзина остаются в снимке', async () => {
  const fake = fakeDeps()
  const original = fake.deps.loadPromptChatPage
  fake.deps.loadPromptChatPage = async (projectId, conversationId, before) => {
    if (conversationId === 'c1') throw new Error('сервер не вернул диалог')
    return original(projectId, conversationId, before)
  }
  const store = createPromptChatStore(fake.deps)

  await store.loadProject('p1')

  const snapshot = store.getSnapshot('p1')
  assert.equal(snapshot.loadState, 'error')
  assert.equal(snapshot.localError, 'сервер не вернул диалог')
  assert.equal(snapshot.active, undefined)
  assert.deepEqual(snapshot.list.map((item) => item.id).sort(), ['c1', 'c2'])
  assert.ok(fake.sink, 'подписка на результаты заведена сразу после получения списка')
})

test('из ошибки загрузки: открыть другой диалог — плашка уходит, помощник оживает', async () => {
  const fake = fakeDeps()
  const original = fake.deps.loadPromptChatPage
  let broken = true
  fake.deps.loadPromptChatPage = async (projectId, conversationId, before) => {
    if (broken && conversationId === 'c1') throw new Error('сервер не вернул диалог')
    return original(projectId, conversationId, before)
  }
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  assert.equal(store.getSnapshot('p1').loadState, 'error')

  await store.selectConversation('p1', 'c2')

  const snapshot = store.getSnapshot('p1')
  assert.equal(snapshot.loadState, 'ready')
  assert.equal(snapshot.localError, undefined)
  assert.equal(snapshot.active?.meta.id, 'c2')
  assert.ok(fake.sink)
  // исправное состояние не перечитывается лишний раз: loadProject без force молчит
  const listsBefore = fake.calls.filter((call) => call.name === 'list').length
  await store.loadProject('p1')
  assert.equal(fake.calls.filter((call) => call.name === 'list').length, listsBefore)
  // и сам повтор по требованию по-прежнему перечитывает всё
  broken = false
  await store.loadProject('p1', true)
  assert.equal(store.getSnapshot('p1').loadState, 'ready')
})

test('из ошибки загрузки: новый диалог тоже снимает плашку и заводит подписку', async () => {
  const fake = fakeDeps()
  const list = fake.deps.listPromptChats
  let failures = 1
  fake.deps.listPromptChats = async (projectId) => {
    if (failures-- > 0) throw new Error('нет связи')
    return list(projectId)
  }
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  const failed = store.getSnapshot('p1')
  assert.equal(failed.loadState, 'error')
  assert.deepEqual(failed.list, [], 'списка нет — показывать нечего')
  assert.equal(fake.sink, null, 'до списка подписку не заводили')

  const created = await store.createConversation('p1')

  const snapshot = store.getSnapshot('p1')
  assert.equal(snapshot.loadState, 'ready')
  assert.equal(snapshot.localError, undefined)
  assert.equal(snapshot.activeId, created.id)
  assert.ok(snapshot.list.length > 0)
  assert.ok(fake.sink, 'без подписки ответы нового диалога некому принять')
})

test('идущая загрузка не перебивается: вне ошибки открытие диалога состояние не трогает', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('p1')
  const sinkBefore = fake.sink

  await store.selectConversation('p1', 'c2')

  assert.equal(store.getSnapshot('p1').loadState, 'ready')
  assert.equal(fake.sink, sinkBefore, 'подписку второй раз не регистрируем')
})

// Жалоба 19.10.2026: на сетевой доске выключатель памяти был всегда погашен,
// но красился как включённый — выглядел рабочим и не нажимался. Теперь сервер
// команды память доски умеет, и выключатель там появляется по ЕГО подтверждению.
test('выключатель памяти на сетевой доске — только когда сервер команды подтвердил память', async () => {
  assert.equal(boardMemoryToggleShown('local', false), true, 'своя доска — как раньше, кнопка гаснет лишь на загрузку')
  assert.equal(boardMemoryToggleShown('local', true), true)
  assert.equal(boardMemoryToggleShown('cloud', false), false, 'прежний сервер команды — мёртвой кнопки нет')
  assert.equal(boardMemoryToggleShown('cloud', true), true)
  const { readFileSync } = await import('node:fs')
  for (const [file, snapshot] of [['./PromptBar.tsx', 'promptChatSnapshot'], ['../../tablet/TabletPrompt.tsx', 'chat']]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.ok(source.includes(`boardMemoryToggleShown(projectSource, ${snapshot}.boardMemoryControlSupported) && (`), file)
  }
})

test('сетевая доска: подтверждение сервера команды включает выключатель, и он сохраняется', async () => {
  const fake = fakeDeps()
  const store = createPromptChatStore(fake.deps)
  await store.loadProject('cloud:prj_1')

  assert.equal(store.getSnapshot('cloud:prj_1').boardMemoryControlSupported, true,
    'вид доски больше не отменяет то, что подтвердил сервер')
  await store.setBoardMemoryEnabled('cloud:prj_1', false)
  assert.equal(store.getSnapshot('cloud:prj_1').boardMemoryEnabled, false)
  assert.deepEqual(fake.calls.find((call) => call.name === 'preference')?.args[0], { boardMemoryEnabled: false })
  await store.send('cloud:prj_1', 'Без памяти', [])
  assert.equal((fake.calls.find((call) => call.name === 'send')?.args[1] as BeginTurnInput).boardMemoryEnabled, false)
})

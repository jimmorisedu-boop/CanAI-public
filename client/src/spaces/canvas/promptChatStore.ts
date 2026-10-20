import { api, ApiError } from '../../api'
import type { Job, ProjectSource } from '../../types'
import { askConfirm } from '../../ui/confirmBus'
import {
  cancelGeneration,
  registerGenerationSink,
  trackGeneration,
  type GenerationSink,
  type GenerationTarget,
} from './generationRegistry'
import type {
  AppendHistoryMessagesInput,
  AppendHistoryMessagesResult,
  BeginTurnInput,
  BeginTurnResult,
  ConversationPage,
  ConversationPatch,
  PromptChatAttachment,
  PromptChatDraft,
  PromptChatEstimate,
  PromptChatIndexEnvelope,
  PromptChatMessage,
  PromptChatMetaV2,
  PromptChatSummary,
  RecordUserMessageInput,
  RecordUserMessageResult,
} from './promptChatTypes'
import { newId } from '../../ui/ids'
import { createPromptChatTransport } from './promptChatTransport'
import { createPromptChatDelivery } from './promptChatDelivery'

const DRAFT_DEBOUNCE_MS = 300

export interface PromptChatProjectSnapshot {
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  list: PromptChatSummary[]
  activeId: string | null
  active?: ConversationPage
  trash: PromptChatSummary[]
  drawerOpen: boolean
  localError?: string
  /** Board-scoped assistant context preference; legacy indexes default to true. */
  boardMemoryEnabled: boolean
  /** Only an acknowledged server capability enables the switch. */
  boardMemoryControlSupported: boolean
  boardMemorySaving: boolean
}

export type PromptChatSnapshot = PromptChatProjectSnapshot

export interface PromptChatStoreDeps {
  listPromptChats(projectId: string): Promise<PromptChatIndexEnvelope>
  createPromptChat(projectId: string, requestId: string): Promise<{ conversation: PromptChatMetaV2 }>
  loadPromptChatPage(projectId: string, conversationId: string, before?: string): Promise<ConversationPage>
  patchPromptChat(
    projectId: string,
    conversationId: string,
    requestId: string,
    patch: ConversationPatch,
  ): Promise<{ meta: PromptChatMetaV2 }>
  activatePromptChat(
    projectId: string,
    conversationId: string,
    requestId: string,
  ): Promise<{ meta: PromptChatMetaV2 }>
  estimatePromptChatMessage(
    projectId: string,
    conversationId: string,
    text: string,
    attachments: PromptChatAttachment[],
    boardMemoryEnabled?: boolean,
  ): Promise<PromptChatEstimate>
  sendPromptChatMessage(
    projectId: string,
    conversationId: string,
    input: BeginTurnInput,
  ): Promise<BeginTurnResult>
  setPromptChatPreferences?(
    projectId: string,
    patch: { boardMemoryEnabled: boolean },
  ): Promise<PromptChatIndexEnvelope>
  recordPromptChatMessage(
    projectId: string,
    conversationId: string,
    input: RecordUserMessageInput,
  ): Promise<RecordUserMessageResult>
  appendPromptChatHistoryMessages(
    projectId: string,
    conversationId: string,
    input: AppendHistoryMessagesInput,
  ): Promise<AppendHistoryMessagesResult>
  rebuildPromptChatContext(
    projectId: string,
    conversationId: string,
  ): Promise<{ status: 'skipped' | 'confirmation-required' | 'queued' }>
  trashPromptChat(projectId: string, conversationId: string, requestId: string): Promise<{ ok: true }>
  listPromptChatTrash(projectId: string): Promise<{ conversations: PromptChatSummary[] }>
  restorePromptChat(
    projectId: string,
    conversationId: string,
    requestId: string,
  ): Promise<{ conversation: PromptChatMetaV2 }>
  deletePromptChatPermanent(
    projectId: string,
    conversationId: string,
    requestId: string,
  ): Promise<{ ok: true }>
  cancelGeneration(jobId: string): Promise<void> | void
  trackGeneration(target: GenerationTarget, jobId: string): void
  registerSink(projectId: string, sink: GenerationSink): () => void
  confirmCost(estimate: PromptChatEstimate): Promise<boolean> | boolean
  schedule(callback: () => void, delayMs: number): unknown
  unschedule(timer: unknown): void
  id(): string
}

interface ProjectState {
  snapshot: PromptChatProjectSnapshot
  pages: Map<string, ConversationPage>
  listeners: Set<() => void>
  patchChains: Map<string, Promise<void>>
  draftTimers: Map<string, unknown>
  unregisterSink?: () => void
  loadAttempt: number
  boardMemoryPreferenceSave?: Promise<void>
  boardMemoryPreferenceRevision: number
  /** Идущая загрузка доски: вторая её ждёт, а не начинается рядом. */
  loading?: Promise<void>
}

export interface PromptChatStore {
  getSnapshot(projectId: string): PromptChatProjectSnapshot
  subscribe(projectId: string, listener: () => void): () => void
  loadProject(projectId: string, force?: boolean): Promise<void>
  refreshList(projectId: string): Promise<void>
  refreshConversation(projectId: string, conversationId: string): Promise<ConversationPage>
  createConversation(projectId: string): Promise<PromptChatMetaV2>
  selectConversation(projectId: string, conversationId: string): Promise<void>
  loadOlder(projectId: string): Promise<void>
  setModel(projectId: string, modelId: string): Promise<void>
  patchDraft(projectId: string, draft: PromptChatDraft): Promise<void>
  send(
    projectId: string,
    text: string,
    attachments: PromptChatAttachment[],
    boardMemoryEnabled?: boolean,
  ): Promise<BeginTurnResult>
  /** Send to a conversation chosen before any asynchronous preparation. */
  sendToConversation(
    projectId: string,
    conversationId: string,
    text: string,
    attachments: PromptChatAttachment[],
    boardMemoryEnabled?: boolean,
  ): Promise<BeginTurnResult>
  recordUserMessage(
    projectId: string,
    text: string,
    attachments: PromptChatAttachment[],
  ): Promise<void>
  estimate(
    projectId: string,
    text: string,
    attachments: PromptChatAttachment[],
    boardMemoryEnabled?: boolean,
  ): Promise<PromptChatEstimate>
  setBoardMemoryEnabled(projectId: string, enabled: boolean): Promise<void>
  waitForBoardMemoryPreference(projectId: string): Promise<void>
  rebuildContext(projectId: string): Promise<void>
  cancel(projectId: string, messageId: string): void
  retry(projectId: string, messageId: string): Promise<void>
  rename(projectId: string, conversationId: string, title: string): Promise<void>
  trash(projectId: string, conversationId: string): Promise<void>
  restore(projectId: string, conversationId: string): Promise<void>
  permanentDelete(projectId: string, conversationId: string): Promise<void>
  setDrawerOpen(projectId: string, open: boolean): void
  flush(projectId: string): Promise<void>

  appendMessages(
    projectId: string,
    conversationId: string,
    messages: Array<Partial<PromptChatMessage> & { role: 'user' | 'assistant'; text: string }>,
  ): Promise<void>
}

function initialSnapshot(): PromptChatProjectSnapshot {
  return {
    loadState: 'idle',
    list: [],
    activeId: null,
    trash: [],
    drawerOpen: false,
    boardMemoryEnabled: true,
    // A local project still needs an explicit capability acknowledgement from
    // the loaded server. This keeps old running servers from exposing a
    // switch that would only look persistent.
    boardMemoryControlSupported: false,
    boardMemorySaving: false,
  }
}

/**
 * Выключатель памяти доски на сетевой доске показываем, только когда сервер
 * команды подтвердил, что память доски умеет.
 *
 * ⚠️ У прежнего сервера команды памяти доски нет вовсе, и мост отвечает
 * `boardMemoryControlSupported: false`. Кнопка там всегда была погашена, но
 * стиль включённой красил её акцентом — она выглядела рабочей и не нажималась
 * (жалоба 19.10.2026 «как будто кнопка памяти не работает»). Мёртвый
 * выключатель хуже отсутствующего. Своя доска память умеет всегда: там кнопка
 * видна и гаснет лишь на время загрузки — как раньше.
 */
export function boardMemoryToggleShown(source: ProjectSource, supported: boolean): boolean {
  return source !== 'cloud' || supported
}

function boardMemoryEnvelope(
  envelope: PromptChatIndexEnvelope,
): Pick<PromptChatProjectSnapshot, 'boardMemoryEnabled' | 'boardMemoryControlSupported'> {
  // ⚠️ Прежде здесь стояло `&& !projectId.startsWith('cloud:')`, и сетевой доске
  // поддержку не давали, что бы ни ответил сервер. Теперь решает его ответ:
  // мост говорит «умею», только когда это подтвердил сервер команды.
  const boardMemoryControlSupported = envelope.boardMemoryControlSupported === true
  return {
    // Missing is intentionally enabled for legacy boards. This affects the
    // effective request only; the switch remains disabled without an explicit
    // capability acknowledgement (including old local servers).
    boardMemoryEnabled: boardMemoryControlSupported
      ? envelope.index.boardMemoryEnabled !== false
      : true,
    boardMemoryControlSupported,
  }
}

function clonePage(value: ConversationPage): ConversationPage {
  return structuredClone(value)
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function targetFor(
  projectId: string,
  conversationId: string,
  messageId: string,
): GenerationTarget {
  return { kind: 'prompt-chat', projectId, conversationId, messageId }
}

function mergeMessages(
  earlier: PromptChatMessage[],
  later: PromptChatMessage[],
): PromptChatMessage[] {
  const byId = new Map<string, PromptChatMessage>()
  for (const message of [...earlier, ...later]) byId.set(message.id, message)
  return [...byId.values()].sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ))
}

export function createPromptChatStore(deps: PromptChatStoreDeps): PromptChatStore {
  const states = new Map<string, ProjectState>()
  const delivery = createPromptChatDelivery({
    read: (job, target) => handleJob(target.projectId, job, target),
    failed: (error, target) => {
      notify(target.projectId, { localError: errorText(error, "Failed to update helper response") })
      return !(error instanceof ApiError && (error.status === 404 || error.status === 410))
    },
    schedule: deps.schedule,
    unschedule: deps.unschedule,
  })
  // Кэш состояний ограничен: раньше Map проектов рос весь сеанс и держал
  // ВСЕ прочитанные беседы каждого проекта (pages дублируются structuredClone).
  // Map хранит порядок вставки — touch двигает проект в конец, выталкиваются
  // старейшие без подписчиков и незавершённых фоновых операций.
  const MAX_PROJECT_STATES = 8

  function stateFor(projectId: string): ProjectState {
    let state = states.get(projectId)
    if (!state) {
      state = {
        snapshot: initialSnapshot(),
        pages: new Map(),
        listeners: new Set(),
        patchChains: new Map(),
        draftTimers: new Map(),
        loadAttempt: 0,
        boardMemoryPreferenceRevision: 0,
      }
    }
    states.delete(projectId)
    states.set(projectId, state)
    evictStaleStates()
    return state
  }

  function evictStaleStates(): void {
    for (const [projectId, state] of states) {
      if (states.size <= MAX_PROJECT_STATES) return
      // Вытесняем только «спящий» проект: с активным UI, летящими патчами,
      // черновиками на таймере или зарегистрированным sink ничего не делаем.
      if (
        state.listeners.size > 0
        || state.patchChains.size > 0
        || state.draftTimers.size > 0
        || state.unregisterSink
      ) continue
      states.delete(projectId)
    }
  }

  function notify(projectId: string, patch: Partial<PromptChatProjectSnapshot> = {}): void {
    const state = stateFor(projectId)
    const next = { ...state.snapshot, ...patch }
    next.active = next.activeId ? state.pages.get(next.activeId) : undefined
    state.snapshot = next
    for (const listener of state.listeners) listener()
  }

  function setPage(projectId: string, value: ConversationPage): void {
    const state = stateFor(projectId)
    state.pages.set(value.meta.id, clonePage(value))
    notify(projectId)
  }

  function enqueuePatch(
    projectId: string,
    conversationId: string,
    patch: ConversationPatch,
  ): Promise<void> {
    const state = stateFor(projectId)
    const previous = state.patchChains.get(conversationId) ?? Promise.resolve()
    const run = async () => {
      notify(projectId, { localError: undefined })
      try {
        const { meta } = await deps.patchPromptChat(
          projectId,
          conversationId,
          deps.id(),
          structuredClone(patch),
        )
        const current = state.pages.get(conversationId)
        if (current) {
          const preserveDraft = patch.draft
            && JSON.stringify(current.meta.draft) !== JSON.stringify(patch.draft)
          current.meta = {
            ...meta,
            ...(preserveDraft ? { draft: current.meta.draft } : {}),
          }
        }
        notify(projectId)
      } catch (error) {
        notify(projectId, {
          localError: errorText(error, "Failed to save chat changes"),
        })
        throw error
      }
    }
    const next = previous.then(run, run)
    state.patchChains.set(conversationId, next)
    void next.finally(() => {
      if (state.patchChains.get(conversationId) === next) {
        state.patchChains.delete(conversationId)
      }
    }).catch(() => {})
    return next
  }

  function registerJobs(projectId: string, value: ConversationPage): void {
    for (const jobId of value.meta.activeJobIds) {
      const messageId = value.messages.find((message) => message.jobId === jobId)?.id ?? jobId
      deps.trackGeneration(targetFor(projectId, value.meta.id, messageId), jobId)
    }
  }

  async function refreshList(projectId: string): Promise<void> {
    const [listed, deleted] = await Promise.all([
      deps.listPromptChats(projectId),
      deps.listPromptChatTrash(projectId),
    ])
    const state = stateFor(projectId)
    const { index } = listed
    const preference = state.snapshot.boardMemorySaving
      ? {}
      : boardMemoryEnvelope(listed)
    const list = index.conversations.map((item) => (
      item.id === state.snapshot.activeId && item.attention === 'unread'
        ? { ...item, attention: 'idle' as const }
        : item
    ))
    notify(projectId, { list, trash: deleted.conversations, ...preference })
  }

  async function refreshConversation(
    projectId: string,
    conversationId: string,
  ): Promise<ConversationPage> {
    const state = stateFor(projectId)
    const fresh = await deps.loadPromptChatPage(projectId, conversationId)
    const cached = state.pages.get(conversationId)
    const merged = cached
      ? { ...fresh, messages: mergeMessages(cached.messages, fresh.messages) }
      : fresh
    setPage(projectId, merged)
    registerJobs(projectId, merged)
    return clonePage(merged)
  }

  async function handleJob(projectId: string, job: Job, target: GenerationTarget): Promise<void> {
    if (target.kind !== 'prompt-chat') return
    if (job.status !== 'done' && job.status !== 'error') return
    const page = await refreshConversation(projectId, target.conversationId)
    const response = page.messages.find((message) => message.id === target.messageId || message.jobId === job.id)
    if (response && ['submitting', 'queued', 'running'].includes(response.status ?? '')) {
      if (job.status === 'error') {
        response.status = 'error'
        response.error = job.error ?? "Failed to get response"
        setPage(projectId, page)
      } else throw new Error("The response is being prepared for delivery. Let's check again...")
    }
    await refreshList(projectId)
    notify(projectId, { localError: undefined })
    const state = stateFor(projectId)
    if (state.snapshot.activeId !== target.conversationId) {
      const attention = job.status === 'done' ? 'unread' : 'error'
      notify(projectId, {
        list: state.snapshot.list.map((item) => (
          item.id === target.conversationId ? { ...item, attention } : item
        )),
      })
    }
  }

  // ⚠️ Одна загрузка на доску разом. Две подряд (окно помощника и полка просят
  // диалоги одновременно; в разработке — двойной запуск эффектов) обе видели
  // пустой список и обе заводили первый диалог: на новой доске оказывались два
  // «Новых диалога». Вторая ждёт первую и берёт её итог.
  async function loadProject(projectId: string, force = false): Promise<void> {
    const state = stateFor(projectId)
    while (state.loading) await state.loading
    if (state.snapshot.loadState === 'ready' && !force) return
    const run = loadProjectNow(projectId, state)
    state.loading = run
    try {
      await run
    } finally {
      if (state.loading === run) state.loading = undefined
    }
  }

  // Подписка на результаты заводится один раз: после сбоя загрузки её мог ещё не
  // завести никто, а оживший помощник (выбрали другой диалог, завели новый) без
  // неё не получил бы ни одного ответа.
  function ensureSink(projectId: string, state: ProjectState): void {
    if (!state.unregisterSink) {
      state.unregisterSink = deps.registerSink(projectId, delivery.deliver)
    }
  }

  // ⚠️ Плашка «Диалог не загрузился» висела над уже работающим диалогом, пока не
  // нажмёшь «Повторить»: открыть другой диалог или завести новый — это и есть
  // успешная загрузка, просто другим путём. Из 'loading' ничего не трогаем:
  // идущая загрузка сама скажет итог.
  function recoveredFromLoadError(
    projectId: string,
    state: ProjectState,
  ): Partial<PromptChatProjectSnapshot> {
    if (state.snapshot.loadState !== 'error') return {}
    ensureSink(projectId, state)
    return { loadState: 'ready', localError: undefined }
  }

  async function loadProjectNow(projectId: string, state: ProjectState): Promise<void> {
    const attempt = ++state.loadAttempt
    notify(projectId, { loadState: 'loading', localError: undefined })
    // Что уже получено до сбоя: список — это дорога к исправным диалогам, и
    // выбрасывать его из-за одной негодной страницы нельзя.
    let known: { list: PromptChatSummary[]; trash: PromptChatSummary[] } | null = null
    try {
      let [listed, deleted] = await Promise.all([
        deps.listPromptChats(projectId),
        deps.listPromptChatTrash(projectId),
      ])
      let { index } = listed
      if (index.conversations.length === 0) {
        await deps.createPromptChat(projectId, deps.id())
        listed = await deps.listPromptChats(projectId)
        ;({ index } = listed)
      }
      if (attempt !== state.loadAttempt) return
      known = { list: index.conversations, trash: deleted.conversations }
      const activeId = index.activeConversationId ?? index.conversations[0]?.id ?? null
      state.unregisterSink?.()
      state.unregisterSink = deps.registerSink(projectId, delivery.deliver)

      const idsToLoad = new Set(
        index.conversations
          .filter((item) => item.id === activeId || item.attention === 'running')
          .map((item) => item.id),
      )
      const pages = await Promise.all(
        [...idsToLoad].map((id) => deps.loadPromptChatPage(projectId, id)),
      )
      if (attempt !== state.loadAttempt) return
      for (const loaded of pages) {
        state.pages.set(loaded.meta.id, clonePage(loaded))
        registerJobs(projectId, loaded)
      }
      if (activeId) {
        const { meta } = await deps.activatePromptChat(projectId, activeId, deps.id())
        const loaded = state.pages.get(activeId)
        if (loaded) loaded.meta = structuredClone(meta)
      }
      if (attempt !== state.loadAttempt) return
      notify(projectId, {
        loadState: 'ready',
        list: index.conversations.map((item) => (
          item.id === activeId && item.attention === 'unread'
            ? { ...item, attention: 'idle' as const }
            : item
        )),
        activeId,
        trash: deleted.conversations,
        localError: undefined,
        ...(state.snapshot.boardMemorySaving ? {} : boardMemoryEnvelope(listed)),
      })
    } catch (error) {
      if (attempt !== state.loadAttempt) return
      notify(projectId, {
        loadState: 'error',
        localError: errorText(error, "Failed to load chats"),
        // Список получен, а страница активного диалога нет: в ящике должны
        // остаться остальные диалоги и корзина, иначе кроме «+» выхода нет.
        ...(known ?? {}),
      })
    }
  }

  async function selectConversation(projectId: string, conversationId: string): Promise<void> {
    const state = stateFor(projectId)
    if (!state.snapshot.list.some((item) => item.id === conversationId)) {
      throw new Error("Chat not found")
    }
    if (!state.pages.has(conversationId)) {
      const loaded = await deps.loadPromptChatPage(projectId, conversationId)
      state.pages.set(conversationId, clonePage(loaded))
      registerJobs(projectId, loaded)
    }
    const { meta } = await deps.activatePromptChat(projectId, conversationId, deps.id())
    const page = state.pages.get(conversationId)
    if (page) page.meta = structuredClone(meta)
    notify(projectId, {
      ...recoveredFromLoadError(projectId, state),
      activeId: conversationId,
      list: state.snapshot.list.map((item) => (
        item.id === conversationId && item.attention === 'unread'
          ? { ...item, attention: 'idle' as const }
          : item
      )),
    })
  }

  async function createConversation(projectId: string): Promise<PromptChatMetaV2> {
    await flush(projectId)
    const { conversation } = await deps.createPromptChat(projectId, deps.id())
    const loaded = await deps.loadPromptChatPage(projectId, conversation.id)
    const state = stateFor(projectId)
    state.pages.set(conversation.id, clonePage(loaded))
    await refreshList(projectId)
    notify(projectId, {
      ...recoveredFromLoadError(projectId, state),
      activeId: conversation.id,
    })
    return structuredClone(conversation)
  }

  async function loadOlder(projectId: string): Promise<void> {
    const state = stateFor(projectId)
    const active = state.snapshot.active
    if (!active?.before) return
    const older = await deps.loadPromptChatPage(projectId, active.meta.id, active.before)
    setPage(projectId, {
      ...active,
      meta: older.meta,
      contextHealth: older.contextHealth,
      before: older.before,
      messages: mergeMessages(older.messages, active.messages),
    })
  }

  async function setModel(projectId: string, modelId: string): Promise<void> {
    const state = stateFor(projectId)
    const active = state.snapshot.active
    if (!active) throw new Error("No chat selected")
    active.meta = { ...active.meta, selectedModelId: modelId }
    setPage(projectId, active)
    await enqueuePatch(projectId, active.meta.id, { selectedModelId: modelId })
  }

  async function patchDraft(projectId: string, draft: PromptChatDraft): Promise<void> {
    const state = stateFor(projectId)
    const active = state.snapshot.active
    if (!active) throw new Error("No chat selected")
    const conversationId = active.meta.id
    active.meta = { ...active.meta, draft: structuredClone(draft) }
    setPage(projectId, active)
    const oldTimer = state.draftTimers.get(conversationId)
    if (oldTimer !== undefined) deps.unschedule(oldTimer)
    const timer = deps.schedule(() => {
      state.draftTimers.delete(conversationId)
      void enqueuePatch(projectId, conversationId, {
        draft: structuredClone(state.pages.get(conversationId)?.meta.draft ?? draft),
      }).catch(() => {})
    }, DRAFT_DEBOUNCE_MS)
    state.draftTimers.set(conversationId, timer)
  }

  async function waitForBoardMemoryPreference(projectId: string): Promise<void> {
    const pending = stateFor(projectId).boardMemoryPreferenceSave
    if (pending) await pending
  }

  async function setBoardMemoryEnabled(projectId: string, enabled: boolean): Promise<void> {
    const state = stateFor(projectId)
    if (!state.snapshot.boardMemoryControlSupported) {
      throw new Error("This server does not support board memory switch")
    }
    const previousEnabled = state.snapshot.boardMemoryEnabled
    const sequence = ++state.boardMemoryPreferenceRevision
    const previous = state.boardMemoryPreferenceSave ?? Promise.resolve()
    // Optimistic UI is safe here because send/estimate wait for this chain;
    // the frozen request is never sent while the server still stores the old
    // value.
    notify(projectId, { boardMemoryEnabled: enabled, boardMemorySaving: true, localError: undefined })
    const run = previous.catch(() => {}).then(async () => {
      try {
        if (!deps.setPromptChatPreferences) {
          throw new Error("This server does not support board memory switch")
        }
        const response = await deps.setPromptChatPreferences(projectId, { boardMemoryEnabled: enabled })
        const preference = boardMemoryEnvelope(response)
        if (!preference.boardMemoryControlSupported) {
          throw new Error("This server has not confirmed board memory retention")
        }
        if (state.boardMemoryPreferenceRevision === sequence) {
          notify(projectId, { ...preference, boardMemorySaving: false })
        }
      } catch (error) {
        // A failed PATCH may have reached the server. Re-read the index before
        // rolling back so the UI never claims an unacknowledged local value.
        if (state.boardMemoryPreferenceRevision === sequence) {
          try {
            const latest = await deps.listPromptChats(projectId)
            const preference = boardMemoryEnvelope(latest)
            notify(projectId, { ...preference, boardMemorySaving: false })
          } catch {
            notify(projectId, { boardMemoryEnabled: previousEnabled, boardMemorySaving: false })
          }
        }
        throw error
      }
    })
    state.boardMemoryPreferenceSave = run
    void run.finally(() => {
      if (state.boardMemoryPreferenceSave === run) {
        state.boardMemoryPreferenceSave = undefined
        if (state.snapshot.boardMemorySaving && state.boardMemoryPreferenceRevision === sequence) {
          notify(projectId, { boardMemorySaving: false })
        }
      }
    }).catch(() => {})
    await run
  }

  async function estimate(
    projectId: string,
    text: string,
    attachments: PromptChatAttachment[],
    boardMemoryEnabled?: boolean,
  ): Promise<PromptChatEstimate> {
    await waitForBoardMemoryPreference(projectId)
    const activeId = stateFor(projectId).snapshot.activeId
    if (!activeId) throw new Error("No chat selected")
    const enabled = boardMemoryEnabled ?? stateFor(projectId).snapshot.boardMemoryEnabled
    return deps.estimatePromptChatMessage(projectId, activeId, text, structuredClone(attachments), enabled)
  }

  async function sendToConversation(
    projectId: string,
    conversationId: string,
    text: string,
    attachments: PromptChatAttachment[],
    boardMemoryEnabled?: boolean,
  ): Promise<BeginTurnResult> {
    await waitForBoardMemoryPreference(projectId)
    const state = stateFor(projectId)
    const active = state.pages.get(conversationId)
    if (!active || !state.snapshot.list.some((item) => item.id === conversationId)) {
      throw new Error("The selected chat is no longer available")
    }
    const trimmed = text.trim()
    if (!trimmed) throw new Error("Message is empty")
    const requestId = deps.id()
    const input: BeginTurnInput = {
      requestId,
      text: trimmed,
      attachments: structuredClone(attachments),
      boardMemoryEnabled: boardMemoryEnabled ?? state.snapshot.boardMemoryEnabled,
    }
    let result: BeginTurnResult
    try {
      result = await deps.sendPromptChatMessage(projectId, active.meta.id, input)
    } catch (error) {
      if (
        error instanceof ApiError
        && error.code === 'PROMPT_CHAT_COST_CONFIRM_REQUIRED'
        && error.estimate
        && error.estimate.costUsd !== null
        && await deps.confirmCost(error.estimate)
      ) {
        result = await deps.sendPromptChatMessage(projectId, active.meta.id, {
          ...input,
          confirmedCostUsd: error.estimate.costUsd,
        })
      } else {
        throw error
      }
    }
    const current = state.pages.get(active.meta.id)
    if (current) {
      const draftStillMatchesSent =
        current.meta.draft.text.trim() === trimmed
        && JSON.stringify(current.meta.draft.attachments) === JSON.stringify(attachments)
      current.messages = mergeMessages(current.messages, [result.userMessage, result.assistantMessage])
      current.meta = {
        ...current.meta,
        revision: result.revision,
        // Кто ответит, решает сервер (на сетевой доске — включённый помощник):
        // в шапке диалога обязана стоять модель, которой вопрос ушёл на деле.
        ...(result.modelId ? { selectedModelId: result.modelId } : {}),
        activeJobIds: [result.jobId],
        ...(draftStillMatchesSent
          ? {
              draft: {
                text: '',
                attachments: [],
                selectionStart: 0,
                selectionEnd: 0,
              },
            }
          : {}),
      }
      setPage(projectId, current)
    }
    deps.trackGeneration(
      targetFor(projectId, active.meta.id, result.assistantMessage.id),
      result.jobId,
    )
    return result
  }

  async function send(
    projectId: string,
    text: string,
    attachments: PromptChatAttachment[],
    boardMemoryEnabled?: boolean,
  ): Promise<BeginTurnResult> {
    // Pin the active conversation before waiting for a preference save. The
    // assistant uses sendToConversation directly because frame preparation can
    // add another asynchronous gap before this call.
    const conversationId = stateFor(projectId).snapshot.activeId
    if (!conversationId) throw new Error("No chat selected")
    return sendToConversation(projectId, conversationId, text, attachments, boardMemoryEnabled)
  }

  async function recordUserMessage(
    projectId: string,
    text: string,
    attachments: PromptChatAttachment[],
  ): Promise<void> {
    const state = stateFor(projectId)
    const active = state.snapshot.active
    if (!active) throw new Error("No chat selected")
    const trimmed = text.trim()
    if (!trimmed) throw new Error("Message is empty")
    const result = await deps.recordPromptChatMessage(projectId, active.meta.id, {
      requestId: deps.id(),
      text: trimmed,
      attachments: structuredClone(attachments),
    })
    const current = state.pages.get(active.meta.id)
    if (!current) return
    current.messages = mergeMessages(current.messages, [result.userMessage])
    current.meta = structuredClone(result.meta)
    setPage(projectId, current)
    notify(projectId, {
      list: state.snapshot.list.map((item) => (
        item.id === current.meta.id
          ? {
              ...item,
              title: current.meta.title,
              updatedAt: current.meta.updatedAt,
              preview: result.userMessage.text,
            }
          : item
      )),
    })
  }

  async function rebuildContext(projectId: string): Promise<void> {
    const active = stateFor(projectId).snapshot.active
    if (!active) throw new Error("No chat selected")
    await deps.rebuildPromptChatContext(projectId, active.meta.id)
    await refreshConversation(projectId, active.meta.id)
  }

  function cancel(projectId: string, messageId: string): void {
    const active = stateFor(projectId).snapshot.active
    const message = active?.messages.find((item) => item.id === messageId)
    if (!active || !message?.jobId) return
    message.status = 'cancelled'
    message.error = "Stopping…"
    setPage(projectId, active)
    void Promise.resolve(deps.cancelGeneration(message.jobId)).catch((error) => {
      notify(projectId, {
        localError: errorText(error, "Failed to stop reply"),
      })
    })
  }

  async function retry(projectId: string, messageId: string): Promise<void> {
    const active = stateFor(projectId).snapshot.active
    const assistant = active?.messages.find((item) => item.id === messageId)
    const user = active?.messages.find((item) => item.id === assistant?.requestMessageId)
    if (!user) throw new Error("Original request not found")
    await send(projectId, user.text, user.attachments ?? [], user.boardMemoryEnabled ?? assistant?.boardMemoryEnabled)
  }

  async function rename(
    projectId: string,
    conversationId: string,
    title: string,
  ): Promise<void> {
    const state = stateFor(projectId)
    const current = state.pages.get(conversationId)
    if (current) {
      current.meta = { ...current.meta, title: title.trim() }
      setPage(projectId, current)
    }
    notify(projectId, {
      list: state.snapshot.list.map((item) => (
        item.id === conversationId ? { ...item, title: title.trim() } : item
      )),
    })
    await enqueuePatch(projectId, conversationId, { title })
  }

  async function trashConversation(projectId: string, conversationId: string): Promise<void> {
    await flush(projectId)
    await deps.trashPromptChat(projectId, conversationId, deps.id())
    delivery.cancel(projectId, conversationId)
    const state = stateFor(projectId)
    state.pages.delete(conversationId)
    await refreshList(projectId)
    if (state.snapshot.activeId === conversationId) {
      const nextId = state.snapshot.list[0]?.id ?? null
      if (nextId) await selectConversation(projectId, nextId)
      else {
        const created = await createConversation(projectId)
        notify(projectId, { activeId: created.id })
      }
    }
  }

  async function restore(projectId: string, conversationId: string): Promise<void> {
    const { conversation } = await deps.restorePromptChat(projectId, conversationId, deps.id())
    const loaded = await deps.loadPromptChatPage(projectId, conversation.id)
    stateFor(projectId).pages.set(conversation.id, clonePage(loaded))
    await refreshList(projectId)
    notify(projectId, { activeId: conversation.id })
  }

  async function permanentDelete(projectId: string, conversationId: string): Promise<void> {
    await deps.deletePromptChatPermanent(projectId, conversationId, deps.id())
    delivery.cancel(projectId, conversationId)
    await refreshList(projectId)
  }

  function setDrawerOpen(projectId: string, open: boolean): void {
    notify(projectId, { drawerOpen: open })
  }

  async function flush(projectId: string): Promise<void> {
    const state = stateFor(projectId)
    for (const [conversationId, timer] of [...state.draftTimers]) {
      deps.unschedule(timer)
      state.draftTimers.delete(conversationId)
      const draft = state.pages.get(conversationId)?.meta.draft
      if (draft) await enqueuePatch(projectId, conversationId, { draft: structuredClone(draft) })
    }
    await Promise.all([...state.patchChains.values()])
  }

  return {
    getSnapshot: (projectId) => stateFor(projectId).snapshot,
    subscribe(projectId, listener) {
      const state = stateFor(projectId)
      state.listeners.add(listener)
      return () => state.listeners.delete(listener)
    },
    loadProject,
    refreshList,
    refreshConversation,
    createConversation,
    selectConversation,
    loadOlder,
    setModel,
    patchDraft,
    send,
    sendToConversation,
    recordUserMessage,
    estimate,
    setBoardMemoryEnabled,
    waitForBoardMemoryPreference,
    rebuildContext,
    cancel,
    retry,
    rename,
    trash: trashConversation,
    restore,
    permanentDelete,
    setDrawerOpen,
    flush,
    async appendMessages(projectId, conversationId, messages): Promise<void> {
      const state = stateFor(projectId)
      const conversation = state.pages.get(conversationId)
      if (!conversation) return
      const input: AppendHistoryMessagesInput = {
        requestId: deps.id(),
        messages: messages.map((message) => ({
          role: message.role,
          text: message.text,
          ...(message.role === 'assistant' ? { reply: message.reply ?? '' } : {}),
        })),
      }
      const result = await deps.appendPromptChatHistoryMessages(
        projectId,
        conversationId,
        input,
      )
      const current = state.pages.get(conversationId)
      if (!current) return
      current.messages = mergeMessages(current.messages, result.messages)
      current.meta = structuredClone(result.meta)
      setPage(projectId, current)
      await refreshList(projectId)
    },
  }
}

export function setBrowserCloudPromptChatTransport(_next: unknown): void {}

const promptTransport = createPromptChatTransport(api, api)

const browserDeps: PromptChatStoreDeps = {
  ...promptTransport,
  cancelGeneration,
  trackGeneration: (target, jobId) => trackGeneration(target, jobId, 'text'),
  registerSink: (projectId, sink) => registerGenerationSink('prompt-chat', projectId, sink),
  // порог здесь серверный: он сам присылает PROMPT_CHAT_COST_CONFIRM_REQUIRED,
  // когда ответ дороже настройки
  confirmCost: (estimate) => askConfirm({
    title: `Send for ~$${estimate.costUsd?.toFixed(3)}?`,
    detail: "This request only pays for the assistant's response. Images and videos are launched separately by explicit command and confirmed before the expensive series.",
    confirmLabel: `Send for ~$${estimate.costUsd?.toFixed(3)}`,
  }),
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  unschedule: (timer) => window.clearTimeout(timer as number),
  id: () => newId(),
}

export const promptChatStore = createPromptChatStore(browserDeps)

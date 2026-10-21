import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  IconChats,
  IconCopy,
  IconEdit,
  IconExact,
  IconGenerate,
  IconPlus,
  IconRefresh,
  IconToCanvas,
} from '../../ui/icons'
import { InlineNotice } from '../../ui/InlineNotice'
import type { CatalogModel } from '../../types'
import {
  requestGenerationComposerFill,
} from './generationComposerBus'
import type { CanvasStore } from './konva/canvasStore'
import type { SelectionRef } from './konva/selection'
import { detectGenerationIntent } from './assistantIntent'
import { BoardMemoryCache } from './boardMemoryCache'
import { useContentVersion } from './konva/useStore'
import { promptChatStore } from './promptChatStore'
import { PromptChatDrawer } from './PromptChatDrawer'
import { planRefPick } from './assistantRefPick'
import { requestAddPromptAsset } from './promptAssetBus'
import { showToast } from './toastBus'
import { PromptChatReferenceHistory } from './PromptChatReferenceHistory'
import { refsForAssistantMessage, selectionFromAttachment } from './assistantAsk'
import { clampShelfHeight, resizeShelfHeight, SHELF_MIN_HEIGHT } from './assistantShelfHeight'
import { assistantModelOptions, modelSelectHint } from './assistantModelHint'
import { promptChatMemoryWarning } from './promptChatStatusModel'
import { modelTransitionMarkers } from './promptChatViewModel'
import { systemErrorMessage } from '../../ui/systemMessage'
import type {
  PromptChatMessage,
  PromptChatSuggestion,
} from './promptChatTypes'
import { useT, type Translate } from '../../i18n/context.js'


function usePromptChatSnapshot(projectId: string) {
  const subscribe = useCallback(
    (listener: () => void) => promptChatStore.subscribe(projectId, listener),
    [projectId],
  )
  const getSnapshot = useCallback(
    () => promptChatStore.getSnapshot(projectId),
    [projectId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function statusLabel(message: PromptChatMessage, elapsed: number, translate: Translate): string {
  if (message.status === 'submitting') return translate('Sending...')
  if (message.status === 'queued') return translate('Queued…')
  if (message.status === 'running') return translate('Writing prompt… · {0}s', { 0: elapsed })
  if (message.status === 'cancelled') return translate('Stopped')
  if (message.status === 'error') return systemErrorMessage(message.error, translate('Failed to get response'))
  return ''
}

function useElapsed(active: boolean, createdAt: number): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!active) {
      setElapsed(0)
      return
    }
    const update = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() - createdAt) / 1_000)))
    }
    update()
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  }, [active, createdAt])
  return elapsed
}

function parseInlineFormatting(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*|__|\*|_|`)/g)
  const result: ReactNode[] = []

  let isBold = false
  let isItalic = false
  let isCode = false

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '**' || token === '__') {
      isBold = !isBold
    } else if (token === '*' || token === '_') {
      isItalic = !isItalic
    } else if (token === '`') {
      isCode = !isCode
    } else {
      if (isCode) {
        result.push(<code key={i} className="chat-inline-code">{token}</code>)
      } else if (isBold && isItalic) {
        result.push(<strong key={i}><em>{token}</em></strong>)
      } else if (isBold) {
        result.push(<strong key={i}>{token}</strong>)
      } else if (isItalic) {
        result.push(<em key={i}>{token}</em>)
      } else {
        result.push(token)
      }
    }
  }

  return result
}

function parseInlineMarkdown(text: string): ReactNode[] {
  const linkRegex = /(\[[^\]]+\]\([^)]+\))/g
  const parts = text.split(linkRegex)
  const result: ReactNode[] = []

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i % 2 === 1) {
      const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
      if (match) {
        const label = match[1]
        const url = match[2]
        result.push(
          <a key={`link-${i}`} href={url} target="_blank" rel="noopener noreferrer" className="chat-link">
            {label}
          </a>
        )
      } else {
        result.push(part)
      }
    } else {
      result.push(...parseInlineFormatting(part))
    }
  }
  return result
}

function renderMarkdown(
  text: string,
  store: CanvasStore,
  refs: SelectionRef[],
  onError: (message: string) => void,
  translate: Translate,
  onCanvasAction?: () => void,
): ReactNode {
  const parts = text.split(/```/g)
  const elements: ReactNode[] = []

  const copyCode = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
    } catch {
      onError(translate('Failed to copy'))
    }
  }

  const fillCode = (content: string) => {
    if (!requestGenerationComposerFill({ prompt: content, refs })) {
      onError(translate('Generation input is currently unavailable'))
    }
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i % 2 === 1) {
      const lines = part.split('\n')
      const firstLine = lines[0].trim()
      const hasLang = lines.length > 1 && /^[a-zA-Z0-9+#-]+$/.test(firstLine)
      const lang = hasLang ? firstLine : ''
      const code = hasLang ? lines.slice(1).join('\n') : part
      const trimmedCode = code.trim()
      elements.push(
        <div key={`code-wrapper-${i}`} className="chat-code-block-wrapper">
          <pre className={`chat-code-block ${lang ? `lang-${lang}` : ''}`}>
            <code>{trimmedCode}</code>
          </pre>
          {/* Роль канона — та же тихая кнопка, что у готового промпта: своих
              стилей у `.prompt-chat-action` больше нет (сведены в controls.css),
              и без класса кнопка рисовалась браузерным прямоугольником. */}
          <div className="chat-code-block-actions">
            <button className="ui-btn quiet prompt-chat-action icon-tab" onClick={() => fillCode(trimmedCode)}>
              <IconEdit size={14} /> {translate('Use prompt')}
            </button>
            <button className="ui-btn quiet prompt-chat-action icon-tab" onClick={() => void copyCode(trimmedCode)}>
              <IconCopy size={14} /> {translate('Copy')}
            </button>
            <button className="ui-btn quiet prompt-chat-action icon-tab" onClick={() => { store.placeText(trimmedCode); onCanvasAction?.() }}>
              <IconToCanvas size={14} /> {translate('Add to canvas')}
            </button>
          </div>
        </div>
      )
    } else {
      const blocks = part.split(/\n\n+/g)
      for (let j = 0; j < blocks.length; j++) {
        const block = blocks[j].trim()
        if (!block) continue

        const headerMatch = /^(#{1,6})\s+(.+)$/.exec(block)
        if (headerMatch) {
          const level = headerMatch[1].length
          const titleText = headerMatch[2]
          const HeaderTag = `h${level}` as keyof JSX.IntrinsicElements
          elements.push(
            <HeaderTag key={`h-${i}-${j}`} className="chat-header">
              {parseInlineMarkdown(titleText)}
            </HeaderTag>
          )
          continue
        }

        const lines = block.split('\n')
        const firstLine = lines[0].trim()
        const isUnordered = /^[*-]\s+/.test(firstLine)
        const isOrdered = /^\d+\.\s+/.test(firstLine)

        if (isUnordered || isOrdered) {
          const listItems = lines.map((line, idx) => {
            const cleanLine = line.trim().replace(/^[*-]\s+|^\d+\.\s+/, '')
            return <li key={idx}>{parseInlineMarkdown(cleanLine)}</li>
          })
          if (isUnordered) {
            elements.push(<ul key={`ul-${i}-${j}`} className="chat-list">{listItems}</ul>)
          } else {
            elements.push(<ol key={`ol-${i}-${j}`} className="chat-list">{listItems}</ol>)
          }
          continue
        }

        elements.push(
          <p key={`p-${i}-${j}`} className="chat-paragraph">
            {parseInlineMarkdown(block)}
          </p>
        )
      }
    }
  }

  return <>{elements}</>
}


function PromptResult({
  suggestion,
  refs,
  store,
  onGenerate,
  onError,
  onCanvasAction,
}: {
  suggestion: PromptChatSuggestion
  refs: SelectionRef[]
  store: CanvasStore
  onGenerate?(prompts: Array<{ title?: string; prompt: string }>): void
  onError(message: string): void
  onCanvasAction?(): void
}) {
  const t = useT()
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(suggestion.prompt)
    } catch {
      onError(t('Failed to copy prompt'))
    }
  }

  function fill(): void {
    if (!requestGenerationComposerFill({ prompt: suggestion.prompt, refs })) {
      onError(t('Generation input is currently unavailable'))
    }
  }

  return (
    <section className="prompt-chat-result" aria-label={suggestion.title}>
      <div className="prompt-chat-result-title">{suggestion.title}</div>
      <p>{suggestion.prompt}</p>
      <div className="prompt-chat-result-actions">
        <button className="prompt-chat-action icon-tab primary" onClick={fill}>
          <IconEdit size={16} />  {t('Use prompt')}
        </button>
        <button className="prompt-chat-action icon-tab" onClick={() => void copy()}>
          <IconCopy size={16} />  {t('Copy')}
        </button>
        <button
          className="prompt-chat-action icon-tab"
          onClick={() => { store.placeText(suggestion.prompt); onCanvasAction?.() }}
          title={t('Add as text to canvas')}
        >
          <IconToCanvas size={16} />  {t('Add to canvas')}
        </button>
      </div>
    </section>
  )
}

function AssistantMessage({
  message,
  refs,
  store,
  dispatchedSlots,
  preferredModelLabel,
  onGenerate,
  onFocusSlots,
  onRetry,
  onError,
  onCanvasAction,
}: {
  message: PromptChatMessage
  // ⚠️ Референсы ВОПРОСА, а не ответа: у ответа вложений не бывает (см.
  // refsForAssistantMessage). Считает их родитель — только он видит всю ленту.
  refs: SelectionRef[]
  store: CanvasStore
  dispatchedSlots?: string[]
  // Метка основной модели доски — считает родитель один раз по contentVersion,
  // а не каждый ответ (память доски не должна пересчитываться на тик таймера).
  preferredModelLabel?: string
  onGenerate?(prompts: Array<{ title?: string; prompt: string }>): void
  onFocusSlots?(slotIds: string[]): void
  onRetry(message: PromptChatMessage): void
  onError(message: string): void
  onCanvasAction?(): void
}) {
  const t = useT()
  const active =
    message.status === 'submitting' ||
    message.status === 'queued' ||
    message.status === 'running'
  const elapsed = useElapsed(active, message.createdAt)
  const isDispatched = Boolean(dispatchedSlots && dispatchedSlots.length > 0)

  return (
    <div className={`prompt-chat-message assistant ${message.status ?? ''}`}>
      {message.reply && <div className="prompt-chat-reply">{renderMarkdown(message.reply, store, refs, onError, t, onCanvasAction)}</div>}

      {/* Панель запуска на холсте: статус запуска или кнопка пакетной генерации */}
      {message.prompts && message.prompts.length > 0 && (
        <div className="prompt-chat-batch-action-bar">
          {isDispatched ? (
            <div className="prompt-chat-dispatched-row">
              <span className="prompt-chat-dispatched-badge">
                <IconGenerate size={14} /> {t('Generation started on canvas ({0})', { 0: dispatchedSlots!.length })}
              </span>
              {onFocusSlots && (
                <button
                  type="button"
                  className="ui-btn quiet prompt-chat-focus-btn"
                  onClick={() => { onFocusSlots(dispatchedSlots!); onCanvasAction?.() }}
                  title={t('Show generated results on the canvas')}
                >
                  <IconExact size={14} />  {t('Show on canvas')}
                </button>
              )}
            </div>
          ) : onGenerate ? (
            <div className="prompt-chat-batch-pending-row">
              <span className="prompt-chat-batch-title">
                {message.prompts.length > 1
                  ? t('Prepared {0} variants', { 0: message.prompts.length })
                  : t('Ready to generate on canvas')}
                {preferredModelLabel && (
                  <span
                    className="prompt-chat-board-memory-tag"
                    title={t('Assistant uses {0} (the main model on this board)', { 0: preferredModelLabel })}
                  >
                    ★ {preferredModelLabel}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="ui-btn primary prompt-chat-batch-btn"
                onClick={() => onGenerate(message.prompts!)}
                title={t('Generate on canvas and focus the results')}
              >
                <IconGenerate size={14} />
                {message.prompts.length > 1
                  ? t('Generate all ({0})', { 0: message.prompts.length })
                  : t('Generate on canvas')}
              </button>
            </div>
          ) : null}
        </div>

      )}

      {message.prompts?.map((suggestion, index) => (
        <PromptResult
          key={`${message.id}:${index}`}
          suggestion={suggestion}
          refs={refs}
          store={store}
          onError={onError}
          onCanvasAction={onCanvasAction}
        />
      ))}
      {active && (
        <div className="prompt-chat-progress" role="status">
          <span className="prompt-chat-spinner" aria-hidden="true" />
          <span>{statusLabel(message, elapsed, t)}</span>
        </div>
      )}
      {(message.status === 'error' || message.status === 'cancelled') && (
        <div className={`prompt-chat-message-state ${message.status}`} role="alert">
          <span>{statusLabel(message, elapsed, t)}</span>
          <button
            className="prompt-chat-inline-action icon-tab"
            onClick={() => onRetry(message)}
          >
            <IconRefresh size={14} />  {t('Retry')}
          </button>
        </div>
      )}
    </div>
  )
}

export function collectHistoricalAssistantMessageIds(messages: PromptChatMessage[]): Set<string> {
  return new Set(
    messages
      // Legacy V1 turns may have no status at all.  They are still history;
      // otherwise a later render (or completion of a newly opened chat) could
      // mistake their prompts for a fresh generation order.  A response that
      // is currently in flight stays eligible so it can finish and dispatch
      // once; cancelled turns are terminal and must never restart.
      .filter((m) => m.role === 'assistant' && (
        m.status === undefined
        || m.status === 'done'
        || m.status === 'error'
        || m.status === 'cancelled'
      ))
      .map((m) => m.id),
  )
}

/**
 * Claims the one paid canvas dispatch allowed for an assistant response.
 *
 * The automatic path and the per-message button can run in the same render
 * window.  Keeping the claim in one synchronous helper makes the async
 * boundary harmless: the second caller sees the in-flight id and does not
 * create a duplicate paid generation.
 */
export function claimAssistantDispatch(
  messageId: string,
  inFlight: Set<string>,
  dispatched: Record<string, string[]>,
): boolean {
  if (inFlight.has(messageId) || Boolean(dispatched[messageId])) return false
  inFlight.add(messageId)
  return true
}

// Ручка живёт на верхней кромке промпт-бара, отдельно от ленты помощника.
export function AssistantShelfResizeGrip({ height, onHeightChange }: {
  height: number
  onHeightChange(height: number): void
}) {
  const t = useT()
  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanup.current?.(), [])
  const viewportHeight = typeof window === 'undefined' ? 720 : window.innerHeight

  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    resizeCleanup.current?.()
    const startY = event.clientY
    const startHeight = height
    const pointerId = event.pointerId
    const handle = event.currentTarget
    try { handle.setPointerCapture(pointerId) } catch { /* window listeners still resize */ }
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      onHeightChange(resizeShelfHeight(startHeight, startY, next.clientY, window.innerHeight))
    }
    const stop = (next?: PointerEvent) => {
      if (next && next.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      try { handle.releasePointerCapture(pointerId) } catch { /* capture is optional */ }
      resizeCleanup.current = null
    }
    resizeCleanup.current = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  return (
    <div
      className="prompt-bar-grip"
      role="separator"
      aria-label={t('Change assistant window height')}
      aria-orientation="horizontal"
      aria-valuenow={Math.round(height)}
      aria-valuemin={SHELF_MIN_HEIGHT}
      aria-valuemax={clampShelfHeight(Number.MAX_SAFE_INTEGER, viewportHeight)}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={(event) => {
        // Стрелки ручки не должны двигать выделенные объекты на холсте.
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          onHeightChange(height + 24)
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          onHeightChange(height - 24)
        }
        if (event.key === 'Home') {
          event.preventDefault()
          onHeightChange(SHELF_MIN_HEIGHT)
        }
      }}
    >
      <i aria-hidden="true" />
    </div>
  )
}

// Лента всегда смонтирована: переключение режима сохраняет её прокрутку.
export function AssistantShelf({
  projectId,
  store,
  models,
  height,
  pause,
  hidden = false,
  onGenerateOnCanvas,
  onFocusSlots,
  onCanvasAction,
}: {
  projectId: string
  store: CanvasStore
  models: CatalogModel[]
  height: number
  // плашка активной паузы рисуется владельцем (PromptBar),
  // потому что ответ на паузу вводится в общее поле под лентой
  pause?: ReactNode
  // прячем стилем, а не размонтированием: окно всегда смонтировано, чтобы
  // scrollTop ленты не сбрасывался при переключении вкладок «Промпт ↔ Чат»
  hidden?: boolean
  onGenerateOnCanvas?(
    prompts: Array<{ title?: string; prompt: string }>,
    mediaKind?: 'image' | 'video',
    refs?: SelectionRef[],
    boardMemoryEnabled?: boolean,
  ): Promise<string[]>
  onFocusSlots?(slotIds: string[]): void
  onCanvasAction?(): void
}) {
  const t = useT()
  const snapshot = usePromptChatSnapshot(projectId)
  const [localError, setLocalError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [dispatchedMessages, setDispatchedMessages] = useState<Record<string, string[]>>({})
  const currentConversationId = snapshot.active?.meta.id ?? null
  const seenHistoricalIdsRef = useRef<Set<string> | null>(null)
  const lastConversationIdRef = useRef<string | null>(null)
  const inFlightDispatchesRef = useRef<Set<string>>(new Set())

  // Память доски считаем на один шельф ОДИН раз на изменение холста
  // (contentVersion), а не в каждом ответе/тике таймера сообщения. Общий
  // BoardMemoryCache — memo/incremental selector: полный обход items случается
  // только при реальной смене содержимого; пан/зум/выделение и ре-рендер ленты
  // версию не трогают, поэтому обхода не бывает (счётчик recomputeCount читают
  // регрессионные тесты, план строки 574/665).
  const contentVersion = useContentVersion(store)
  const boardMemoryCacheRef = useRef<BoardMemoryCache | null>(null)
  if (boardMemoryCacheRef.current === null) {
    boardMemoryCacheRef.current = new BoardMemoryCache()
  }
  const boardMemory = snapshot.boardMemoryEnabled
    ? boardMemoryCacheRef.current.get(store.getItems(), contentVersion)
    : null

  function requestBoardMemoryEnabled(message: PromptChatMessage): boolean {
    // Current board OFF is authoritative for late/manual clicks. A response
    // created while OFF keeps its frozen false choice after re-enabling.
    return snapshot.boardMemoryEnabled && message.boardMemoryEnabled !== false
  }

  // При переключении диалога сбрасываем снимок исторических сообщений
  if (lastConversationIdRef.current !== currentConversationId) {
    lastConversationIdRef.current = currentConversationId
    seenHistoricalIdsRef.current = null
  }

  const collapsed = height <= SHELF_MIN_HEIGHT

  // Автоматический запуск на холсте, если пользователь давал прямое поручение
  // («сделай 10 фото или видео») и помощник подготовил готовые промпты.
  // ⚠️ Старые сообщения из истории никогда не запускаются повторно при загрузке страницы!
  useEffect(() => {
    if (!onGenerateOnCanvas) return
    // A preference write freezes the request contract. Wait for its durable
    // result before any automatic response launch can reach the canvas.
    if (snapshot.boardMemorySaving) return
    const msgs = snapshot.active?.messages
    if (!msgs || msgs.length === 0) return

    // При первой инициализации списка сообщений в этом диалоге
    // помечаем ВСЕ существующие сообщения со статусом 'done' / 'error' как исторические,
    // чтобы они никогда не запускались автоматически при открытии диалога или страницы!
    if (seenHistoricalIdsRef.current === null) {
      seenHistoricalIdsRef.current = collectHistoricalAssistantMessageIds(msgs)
      return
    }

    const lastMsg = msgs[msgs.length - 1]
    if (lastMsg.role !== 'assistant') return
    if (lastMsg.status === 'running' || lastMsg.status === 'submitting' || lastMsg.status === 'queued') return
    if (!lastMsg.prompts || lastMsg.prompts.length === 0) return
    if (seenHistoricalIdsRef.current.has(lastMsg.id)) return
    if (inFlightDispatchesRef.current.has(lastMsg.id)) return
    if (dispatchedMessages[lastMsg.id]) return

    const intent = detectGenerationIntent(msgs, msgs.length - 1)
    if (intent.isGenerationOrder) {
      // Синхронно блокируем повторный запуск в этом же сеансе
      if (!claimAssistantDispatch(lastMsg.id, inFlightDispatchesRef.current, dispatchedMessages)) return
      seenHistoricalIdsRef.current.add(lastMsg.id)

      void (async () => {
        try {
          const slots = await onGenerateOnCanvas(
            lastMsg.prompts!,
            intent.mediaKind,
            refsForAssistantMessage(msgs, lastMsg),
            requestBoardMemoryEnabled(lastMsg),
          )
          if (slots && slots.length > 0) {
            setDispatchedMessages((prev) => ({ ...prev, [lastMsg.id]: slots }))
          } else {
            inFlightDispatchesRef.current.delete(lastMsg.id)
          }
        } catch {
          // Ошибки запуска обрабатываются вызывающим
          inFlightDispatchesRef.current.delete(lastMsg.id)
        }
      })()
    }
  }, [snapshot.active?.messages, snapshot.boardMemorySaving, onGenerateOnCanvas, dispatchedMessages])

  /** Клик по миниатюре в ленте: объект возвращается в работу. Выделение на
   *  доске и есть добавление в референсы — чипы промпт-бара его зеркалят. */
  function pickHistoryRef(ref: SelectionRef, additive: boolean): void {
    const action = planRefPick(ref, {
      onBoard: Boolean(store.getItem(ref.shapeId)),
      additive,
      selected: [...store.getSelectedIds()],
    })
    if (action.kind === 'select') {
      store.setSelection(action.ids)
      return
    }
    if (action.kind === 'manual') {
      // Объекта на доске уже нет — кладём ручным чипом по ссылке, как с полки.
      requestAddPromptAsset(action.ref)
      showToast(t('The object is not on the board - added a reference via the link'))
    }
  }

  const [rebuildingContext, setRebuildingContext] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const followBottomRef = useRef(true)
  const messages = snapshot.active?.messages ?? []
  const transitionMarkers = modelTransitionMarkers(messages)
  const memoryWarning = promptChatMemoryWarning(snapshot.active?.contextHealth ?? 'ready')
  const modelNames = new Map(models.map((model) => [model.id, model.name]))

  useEffect(() => {
    const list = listRef.current
    if (!list || !followBottomRef.current) return
    list.scrollTop = list.scrollHeight
  }, [messages])

  async function retry(message: PromptChatMessage): Promise<void> {
    setLocalError(null)
    try {
      await promptChatStore.retry(projectId, message.id)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Failed to retry request")
    }
  }

  async function loadOlder(): Promise<void> {
    const list = listRef.current
    if (!list || loadingOlder || !snapshot.active?.before) return
    const previousHeight = list.scrollHeight
    setLoadingOlder(true)
    try {
      await promptChatStore.loadOlder(projectId)
      requestAnimationFrame(() => {
        const current = listRef.current
        if (current) current.scrollTop += current.scrollHeight - previousHeight
      })
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Failed to load earlier messages")
    } finally {
      setLoadingOlder(false)
    }
  }

  async function rebuildContext(): Promise<void> {
    if (rebuildingContext) return
    setRebuildingContext(true)
    setLocalError(null)
    try {
      await promptChatStore.rebuildContext(projectId)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Failed to update memory")
    } finally {
      setRebuildingContext(false)
    }
  }

  return (
    <section
      className={`assistant-shelf ${collapsed ? 'is-collapsed' : ''}`}
      style={{ height, display: hidden ? 'none' : 'flex' }}
      aria-label={t('Assistant')}
      aria-hidden={hidden}
    >
      <header className="assistant-shelf-head">
        <button
          className="icon-btn"
          aria-label={t('Chats')}
          aria-expanded={snapshot.drawerOpen}
          onClick={() => promptChatStore.setDrawerOpen(projectId, !snapshot.drawerOpen)}
        >
          <IconChats size={18} />
        </button>
        <strong title={snapshot.active?.meta.title}>
          {snapshot.active?.meta.title || "New chat"}
        </strong>
        <select
          aria-label={t('Chat model')}
          title={snapshot.active ? undefined : modelSelectHint(snapshot.loadState)}
          value={snapshot.active?.meta.selectedModelId ?? ''}
          disabled={!snapshot.active}
          onChange={(event) => {
            setLocalError(null)
            void promptChatStore.setModel(projectId, event.target.value).catch((error) => {
              setLocalError(error instanceof Error ? error.message : "Failed to change model")
            })
          }}
        >
          {assistantModelOptions({
            models,
            selectedModelId: snapshot.active?.meta.selectedModelId,
            chatLoadState: snapshot.loadState,
          }).map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled} title={option.title}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          className="icon-btn"
          aria-label={t('New chat')}
          onClick={() => {
            setLocalError(null)
            void promptChatStore.createConversation(projectId).catch((error) => {
              setLocalError(error instanceof Error ? error.message : "Failed to create chat")
            })
          }}
        >
          <IconPlus size={18} />
        </button>
      </header>

      <PromptChatDrawer
        open={snapshot.drawerOpen}
        conversations={snapshot.list}
        activeId={snapshot.activeId}
        trash={snapshot.trash}
        onClose={() => promptChatStore.setDrawerOpen(projectId, false)}
        onCreate={() => {
          void promptChatStore.createConversation(projectId).catch((error) => {
            setLocalError(error instanceof Error ? error.message : "Failed to create chat")
          })
        }}
        onSelect={(id) => {
          void promptChatStore.selectConversation(projectId, id).catch((error) => {
            setLocalError(error instanceof Error ? error.message : "Failed to open chat")
          })
        }}
        onRename={(id, title) => {
          void promptChatStore.rename(projectId, id, title).catch((error) => {
          setLocalError(error instanceof Error ? error.message : "Failed to rename chat")
          })
        }}
        onTrash={(id) => promptChatStore.trash(projectId, id).catch((error) => {
          setLocalError(error instanceof Error ? error.message : "Failed to delete chat")
        })}
        onRestore={(id) => promptChatStore.restore(projectId, id).catch((error) => {
          setLocalError(error instanceof Error ? error.message : "Failed to restore chat")
        })}
        onPermanentDelete={(id) => promptChatStore.permanentDelete(projectId, id).catch((error) => {
          setLocalError(error instanceof Error ? error.message : "Failed to delete the chat permanently")
        })}
      />

      {snapshot.loadState === 'loading' && (
        <InlineNotice
          className="prompt-chat-inline-notice"
          tone="info"
          title={t('Loading chat...')}
        />
      )}
      {snapshot.loadState === 'error' && (
        <InlineNotice
          className="prompt-chat-inline-notice"
          tone="error"
          title={t('Chat didn\'t load')}
          detail={snapshot.localError || undefined}
          action={{
            label: "Retry",
            onClick: () => void promptChatStore.loadProject(projectId, true),
          }}
        />
      )}
      {memoryWarning && (
        <InlineNotice
          className="prompt-chat-inline-notice"
          tone="warning"
          title={t('Chat memory is out of date')}
          detail={memoryWarning}
          action={{
            label: rebuildingContext ? "Updating..." : "Retry",
            disabled: rebuildingContext,
            onClick: () => void rebuildContext(),
          }}
        />
      )}

      <div
        className="prompt-chat-messages"
        style={{ display: collapsed ? 'none' : undefined }}
        ref={listRef}
        role="log"
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget
          followBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80
          if (element.scrollTop <= 24 && snapshot.active?.before && !loadingOlder) {
            void loadOlder()
          }
        }}
      >
        {snapshot.active?.before && (
          <button
            type="button"
            className="prompt-chat-load-older"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? t('Loading…') : t('Show earlier messages')}
          </button>
        )}
        {snapshot.loadState === 'ready' && messages.length === 0 && (
          <div className="prompt-chat-empty">
            <strong>{t('Where do we start?')}</strong>
            <p>{t('Discuss an idea, write a prompt, or create something on the board.')}</p>
          </div>
        )}
        {messages.map((message, messageIndex) => {
          const isSystem = message.role === 'user' && message.text.startsWith('▶')
          return message.role === 'user' ? (
            <div key={message.id} className={`prompt-chat-message user ${isSystem ? 'system-action' : ''}`}>
              {isSystem ? <p>{message.text}</p> : renderMarkdown(message.text, store, [], setLocalError, t)}
              {message.attachments && message.attachments.length > 0 && (
                <PromptChatReferenceHistory
                  refs={message.attachments.map(selectionFromAttachment)}
                  onPick={(ref, additive) => pickHistoryRef(ref, additive)}
                />
              )}
            </div>
          ) : (
            <div key={message.id} className="prompt-chat-assistant-turn">
              {transitionMarkers[messageIndex] && (
                <div className="prompt-chat-model-marker">
                  {modelNames.get(message.modelId ?? '') ?? message.modelId ?? "Model"}
                </div>
              )}
              <AssistantMessage
                message={message}
                refs={refsForAssistantMessage(messages, message)}
                store={store}
                dispatchedSlots={dispatchedMessages[message.id]}
                preferredModelLabel={boardMemory?.preferredImageModel?.modelName}
                onGenerate={onGenerateOnCanvas && !snapshot.boardMemorySaving ? (prompts) => {
                  if (!claimAssistantDispatch(message.id, inFlightDispatchesRef.current, dispatchedMessages)) return
                  void onGenerateOnCanvas(
                    prompts,
                    detectGenerationIntent(messages, messageIndex).mediaKind,
                    refsForAssistantMessage(messages, message),
                    requestBoardMemoryEnabled(message),
                  ).then((slots) => {
                    if (slots && slots.length > 0) {
                      setDispatchedMessages((prev) => ({ ...prev, [message.id]: slots }))
                      onCanvasAction?.()
                    } else {
                      inFlightDispatchesRef.current.delete(message.id)
                    }
                  }).catch(() => {
                    inFlightDispatchesRef.current.delete(message.id)
                  })
                } : undefined}
                onFocusSlots={onFocusSlots}
                onRetry={(target) => void retry(target)}
                onError={setLocalError}
                onCanvasAction={onCanvasAction}
              />
            </div>
          )
        })}
      </div>

      {pause}

      {(localError || (snapshot.loadState === 'ready' ? snapshot.localError : null)) && (
        <InlineNotice
          className="prompt-chat-inline-notice prompt-chat-local-notice"
          tone="error"
          title={t('Action failed')}
          detail={localError || snapshot.localError || undefined}
          onDismiss={localError ? () => setLocalError(null) : undefined}
        />
      )}
    </section>
  )
}

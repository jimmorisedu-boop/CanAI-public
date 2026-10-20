import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { InlineNotice } from '../ui/InlineNotice'
import { IconCopy, IconMagic, IconToCanvas } from '../ui/icons'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { useActiveAssistantMessageId, useAssistantMessages } from '../spaces/canvas/assistantAsk'
import { promptChatStore } from '../spaces/canvas/promptChatStore'
import type { PromptChatMessage, PromptChatSuggestion } from '../spaces/canvas/promptChatTypes'
import { notify } from '../spaces/canvas/notifications'
import { copyText } from '../ui/ids'
import { isReadingLatest } from './assistantReading'
import { assistantPromptVariants } from './assistantPromptVariants'
import { tabletSystemMessage } from './tabletSystemMessage'

// Лента разговора с помощником.
//
// Вторая вкладка того же поля ввода, что и промпт, — так же, как на
// компьютере: поле ввода в приложении ОДНО. Готовый промпт приходит карточкой
// с четырьмя действиями, и «Сгенерировать» среди них платное только по
// нажатию: сам помощник картинок не заказывает.

export function TabletAssistant({
  store,
  projectId,
  onUsePrompt,
}: {
  store: CanvasStore
  projectId: string
  /** Подставить готовый промпт в поле ввода (вкладка «Промпт»). */
  onUsePrompt(text: string): void
}) {
  const messages = useAssistantMessages(projectId)
  const active = useActiveAssistantMessageId(projectId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const [unread, setUnread] = useState(false)
  const showLatest = () => {
    const view = scrollRef.current
    if (view) view.scrollTop = view.scrollHeight
    followLatest.current = true
    setUnread(false)
  }
  const chat = useSyncExternalStore(
    useCallback((listener: () => void) => promptChatStore.subscribe(projectId, listener), [projectId]),
    useCallback(() => promptChatStore.getSnapshot(projectId), [projectId]),
  )
  // ⚠️ Не загрузившийся диалог обязан предлагать повтор, как на компьютере:
  // без него вопрос уходил в никуда («Диалог не выбран»), а лента молчала —
  // со стороны это и есть «помощник не реагирует» (14.09.2026).
  const errorNotice = chat.loadState === 'error'
    ? (
      <InlineNotice
        tone="error"
        title="Conversation did not load"
        detail={chat.localError ? tabletSystemMessage(chat.localError) : undefined}
        action={{ label: 'Retry', onClick: () => void promptChatStore.loadProject(projectId, true) }}
      />
    )
    : chat.localError
      ? <InlineNotice tone="error" title={tabletSystemMessage(chat.localError)} />
      : null

  useEffect(() => {
    void promptChatStore.loadProject(projectId)
  }, [projectId])

  useLayoutEffect(() => {
    if (followLatest.current) showLatest()
    else setUnread(true)
  }, [messages, active])
  useEffect(() => {
    followLatest.current = true
    showLatest()
  }, [projectId])
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !scrollRef.current || !contentRef.current) return
    const observer = new ResizeObserver(() => { if (followLatest.current) showLatest() })
    observer.observe(scrollRef.current)
    observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="tablet-assistant-reading">
    <div className={`tablet-assistant ${messages.length === 0 ? 'empty' : ''}`} ref={scrollRef} onScroll={() => {
      if (!scrollRef.current) return
      followLatest.current = isReadingLatest(scrollRef.current)
      if (followLatest.current) setUnread(false)
    }}>
      <div className="tablet-assistant-messages" ref={contentRef}>
      {errorNotice}
      {messages.length === 0 && <><IconMagic size={22} /><p>Ask about lighting, angle, or composition. The assistant answers in words and suggests ready prompts only when asked.</p></>}
      {messages.map((message) => (
        <Message
          key={message.id}
          message={message}
          store={store}
          onUsePrompt={onUsePrompt}
        />
      ))}
      </div>
    </div>
    {unread && <button className="ui-btn tablet-assistant-unread" type="button" onClick={showLatest}>New response ↓</button>}
    </div>
  )
}

function Message({
  message,
  store,
  onUsePrompt,
}: {
  message: PromptChatMessage
  store: CanvasStore
  onUsePrompt(text: string): void
}) {
  const mine = message.role === 'user'
  const working = message.status === 'submitting' || message.status === 'queued' || message.status === 'running'
  const answer = [message.text, message.reply].filter(Boolean).join('\n\n')
  const suggestions = message.prompts?.length ? message.prompts : assistantPromptVariants(answer)

  return (
    <div className={`tablet-msg ${mine ? 'me' : 'ai'}`}>
      <span className="tablet-msg-who">{mine ? 'I' : <IconMagic size={14} />}</span>
      <div className="tablet-msg-body">
        {message.text && <p>{message.text}</p>}
        {message.reply && <p>{message.reply}</p>}
        {working && <p className="tablet-msg-status">Formulating…</p>}
        {message.status === 'error' && (
          <p className="tablet-msg-error">{tabletSystemMessage(message.error, 'Could not get a response')}</p>
        )}
        {!mine && suggestions.map((suggestion, index) => (
          <PromptCard
            key={index}
            suggestion={suggestion}
            store={store}
            onUsePrompt={onUsePrompt}
          />
        ))}
        {!mine && !working && answer && <div className="tablet-prompt-card-actions">
          {suggestions.length === 0 && <button className="ui-btn" type="button" onClick={() => onUsePrompt(answer)}>To prompt</button>}
          <button className="ui-btn" type="button" onClick={() => {
            void copyText(answer).then(() => notify({ kind: 'success', message: 'Response copied' }))
              .catch(() => notify({ kind: 'error', message: 'Could not copy' }))
          }}><IconCopy size={16} /> Copy</button>
        </div>}
      </div>
    </div>
  )
}

function PromptCard({
  suggestion,
  store,
  onUsePrompt,
}: {
  suggestion: PromptChatSuggestion
  store: CanvasStore
  onUsePrompt(text: string): void
}) {
  return (
    <div className="tablet-prompt-card">
      {suggestion.title && <strong>{suggestion.title}</strong>}
      <p>{suggestion.prompt}</p>
      <div className="tablet-prompt-card-actions">
        <button type="button" className="ui-btn" onClick={() => onUsePrompt(suggestion.prompt)}>
          To line
        </button>
        <button
          type="button"
          className="ui-btn"
          onClick={() => {
            void copyText(suggestion.prompt)
              .then(() => notify({ kind: 'success', message: 'Prompt copied' }))
              .catch(() => notify({ kind: 'error', message: 'Could not copy' }))
          }}
        >
          <IconCopy size={16} /> Copy
        </button>
        <button
          type="button"
          className="ui-btn"
          onClick={() => {
            const id = store.placeText(suggestion.prompt)
            store.setSelection([id])
            notify({ kind: 'success', message: 'Text added to canvas' })
          }}
        >
          <IconToCanvas size={16} /> To canvas
        </button>
      </div>
    </div>
  )
}

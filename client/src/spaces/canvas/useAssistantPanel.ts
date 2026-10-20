import { useEffect, useState, type RefObject } from 'react'
import type { SelectionRef } from './konva/selection'
import {
  useActiveAssistantMessageId,
  useAssistantMessages,
} from './assistantAsk'
import { SHELF_DEFAULT_HEIGHT } from './assistantShelfHeight'
import {
  assistantSignal,
  assistantSignalLabel,
  latestAssistantId,
  type AssistantSignal,
} from './assistantUnseen'
import { draftFromComposer } from './promptChatComposer'
import { promptChatStore } from './promptChatStore'
import type { PromptChatEstimate } from './promptChatTypes'

const ESTIMATE_DEBOUNCE_MS = 300

// Состояние окна помощника: высота ленты, подсветка при перетаскивании,
// индикатор непрочитанного ответа, оценка цены вопроса и запущенная цепочка.
// Шесть состояний с общей темой — в теле PromptBar они лежали вперемешку с
// референсами, моделью и запуском генерации.
export function useAssistantPanel(input: {
  projectId: string
  chatOpen: boolean
  prompt: string
  composerRefs: SelectionRef[]
  // стабильный ключ состава референсов: сами массивы создаются каждый рендер
  composerRefsKey: string
  activeConversationId: string | null
  hasConversation: boolean
  boardMemoryEnabled: boolean
  boardMemorySaving: boolean
  textareaRef: RefObject<HTMLTextAreaElement>
}) {
  const {
    projectId,
    chatOpen,
    prompt,
    composerRefs,
    composerRefsKey,
    activeConversationId,
    hasConversation,
    boardMemoryEnabled,
    boardMemorySaving,
    textareaRef,
  } = input

  const [shelfHeight, setShelfHeight] = useState(SHELF_DEFAULT_HEIGHT)
  const [dropActive, setDropActive] = useState(false)
  const [estimate, setEstimate] = useState<PromptChatEstimate | null>(null)
  // какой ответ пользователь уже видел — чтобы «ответил» не горел вечно
  const [seenAssistantId, setSeenAssistantId] = useState<string | null>(null)

  const activeAssistantId = useActiveAssistantMessageId(projectId)
  const messages = useAssistantMessages(projectId)
  const signal: AssistantSignal = assistantSignal(messages, seenAssistantId, chatOpen)
  const signalLabel = assistantSignalLabel(signal)

  // пока окно помощника открыто, свежий ответ сразу считается просмотренным
  useEffect(() => {
    if (!chatOpen) return
    setSeenAssistantId(latestAssistantId(messages))
  }, [chatOpen, messages])


  // цена вопроса считается с задержкой: набор текста не должен слать запрос
  // на каждый символ
  useEffect(() => {
    if (!chatOpen || !hasConversation || activeAssistantId || boardMemorySaving || !prompt.trim()) {
      setEstimate(null)
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      const draft = draftFromComposer(
        prompt,
        composerRefs,
        textareaRef.current?.selectionStart ?? prompt.length,
        textareaRef.current?.selectionEnd ?? prompt.length,
      )
      void promptChatStore
        .estimate(projectId, prompt, draft.attachments)
        .then((next) => {
          if (alive) setEstimate(next)
        })
        .catch(() => {
          if (alive) setEstimate(null)
        })
    }, ESTIMATE_DEBOUNCE_MS)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAssistantId, boardMemoryEnabled, boardMemorySaving, chatOpen, composerRefsKey, projectId, prompt, activeConversationId])

  // уход с доски и размонтирование не должны оставить цепочку висеть

  return {
    shelfHeight,
    setShelfHeight,
    dropActive,
    setDropActive,
    estimate,
    activeAssistantId,
    signal,
    signalLabel,
  }
}

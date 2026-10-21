import { useCallback, useSyncExternalStore } from 'react'
import type { SelectionRef } from './konva/selection'
import { promptChatStore } from './promptChatStore'
import { t } from '../../i18n/translate'

import type { PromptChatAttachment, PromptChatMessage } from './promptChatTypes'

const EMPTY_MESSAGES: PromptChatMessage[] = []

// Отправка вопроса помощнику из ЕДИНОГО композера (промпт-бар). Раньше эта
// логика жила только внутри панели помощника; теперь поле ввода одно на всё
// приложение, поэтому она вынесена сюда и используется обеими сторонами.
export function attachmentFromSelection(ref: SelectionRef): PromptChatAttachment {
  return {
    shapeId: ref.shapeId,
    assetId: ref.assetId,
    kind: ref.kind,
    label: ref.label,
    src: ref.src,
    text: ref.text,
    width: ref.w,
    height: ref.h,
  }
}

export function selectionFromAttachment(ref: PromptChatAttachment): SelectionRef {
  return {
    shapeId: ref.shapeId,
    assetId: ref.assetId,
    kind: ref.kind,
    label: ref.label,
    src: ref.src,
    text: ref.text,
    w: ref.width,
    h: ref.height,
  }
}

// Референсы замораживаются копией: последующее изменение выделения на канвасе
// не должно менять уже отправленное сообщение.
export async function askAssistant(
  projectId: string,
  text: string,
  refs: SelectionRef[],
): Promise<void> {
  const frozen = refs.map((ref) => ({ ...ref }))
  // Pin the chat before frame capture/upload. The active chat can change while
  // a cloud video is being prepared; sending through the active-chat wrapper
  // after that await would put this question into the newly selected chat.
  const targetConversationId = promptChatStore.getSnapshot(projectId).activeId
  if (!targetConversationId) throw new Error('No chat selected')
  const prepared = frozen
  await promptChatStore.sendToConversation(
    projectId,
    targetConversationId,
    text,
    prepared.map(attachmentFromSelection),
  )
}

// Вход сценария становится обычным сообщением в истории, но не создаёт
// отдельный запрос к LLM: дальше его обработает сам граф сценария.
export async function recordAssistantScenarioInput(
  projectId: string,
  text: string,
  refs: SelectionRef[],
): Promise<void> {
  const frozen = refs.map((ref) => ({ ...ref }))
  await promptChatStore.recordUserMessage(
    projectId,
    text,
    frozen.map(attachmentFromSelection),
  )
}

// Активный (ещё не завершённый) ответ помощника — по нему кнопка «Спросить»
// превращается в «Стоп». Поле ввода при этом НЕ блокируется никогда:
// пользователь должен иметь возможность жать «Сгенерировать» сериями.
export function activeAssistantMessageId(projectId: string): string | null {
  const messages = promptChatStore.getSnapshot(projectId).active?.messages ?? EMPTY_MESSAGES
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    if (
      message.status === 'submitting' ||
      message.status === 'queued' ||
      message.status === 'running'
    ) {
      return message.id
    }
  }
  return null
}

// Лента сообщений для индикации на вкладке помощника.
export function useAssistantMessages(projectId: string): PromptChatMessage[] {
  const subscribe = useCallback(
    (listener: () => void) => promptChatStore.subscribe(projectId, listener),
    [projectId],
  )
  const getSnapshot = useCallback(
    () => promptChatStore.getSnapshot(projectId).active?.messages ?? EMPTY_MESSAGES,
    [projectId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// Реактивная версия для промпт-бара: кнопка «Спросить» ↔ «Стоп».
export function useActiveAssistantMessageId(projectId: string): string | null {
  const subscribe = useCallback(
    (listener: () => void) => promptChatStore.subscribe(projectId, listener),
    [projectId],
  )
  const getSnapshot = useCallback(
    () => activeAssistantMessageId(projectId),
    [projectId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Референсы, к которым относится ответ помощника.
 *
 * ⚠️ Их надо брать у ВОПРОСА, а не у ответа. Кнопка «В строку» на готовом
 * промпте живёт в сообщении помощника, а вложения замораживаются в сообщение
 * пользователя (см. askAssistant) — у ответа их нет никогда. Из-за этого
 * «В строку» молча не переносила ни одного референса: `request.refs` приходил
 * пустым, и промпт-бар оставлял на месте то, что было раньше. Человек видел
 * либо своё старое выделение (в другом порядке — отсюда жалоба «поменялись
 * местами»), либо вообще ничего, если выделение он уже снял (жалоба 27.08.2026).
 *
 * Связь ответа с вопросом даёт `requestMessageId`; у старых историй его может
 * не быть — тогда берём ближайший вопрос выше.
 */
export function refsForAssistantMessage(
  messages: readonly PromptChatMessage[],
  assistant: PromptChatMessage,
): SelectionRef[] {
  const own = assistant.attachments ?? []

  const byId = assistant.requestMessageId
    ? messages.find((item) => item.id === assistant.requestMessageId)
    : undefined
  if (byId?.attachments?.length) return byId.attachments.map(selectionFromAttachment)

  const index = messages.findIndex((item) => item.id === assistant.id)
  for (let i = (index < 0 ? messages.length : index) - 1; i >= 0; i--) {
    const candidate = messages[i]
    if (candidate?.role !== 'user') continue
    const questionRefs = candidate.attachments ?? []
    if (questionRefs.length > 0) return questionRefs.map(selectionFromAttachment)
    break
  }
  // Некоторые адаптеры могут продублировать в ответ только последнее
  // вложение. Оно не должно заслонять полный набор связанного вопроса, но для
  // старой/повреждённой истории без исходного сообщения остаётся полезным
  // запасным источником.
  return own.map(selectionFromAttachment)
}

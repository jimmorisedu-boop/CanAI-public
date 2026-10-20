import { createHash } from 'node:crypto'
import type { PromptChatMessageV2 } from './promptChatTypes.js'
import type { PromptChatDocumentV1 } from './promptChats.js'
import { ID_RE } from './promptChatValidation.js'

// Перенос диалогов из старого одиночного файла в поразговорное хранилище.
// Живёт отдельно: это разовая миграция, а не часть повседневной работы.
export function deterministicLegacyId(
  projectId: string,
  sourceId: string,
  ordinal: number,
  kind: 'conversation' | 'message',
): string {
  const digest = createHash('sha256')
    .update(`${projectId}\0${kind}\0${ordinal}\0${sourceId}`)
    .digest('hex')
    .slice(0, 24)
  return `legacy-${kind}-${digest}`
}

export function normalizeLegacyMessages(
  projectId: string,
  conversationId: string,
  messages: PromptChatDocumentV1['messages'],
): PromptChatMessageV2[] {
  const used = new Set<string>()
  const firstIdMap = new Map<string, string>()
  const normalized = messages.map((message, index) => {
    let id = message.id
    if (!ID_RE.test(id) || used.has(id)) {
      id = deterministicLegacyId(projectId, `${conversationId}\0${message.id}`, index, 'message')
    }
    while (used.has(id)) id = `${id}-${index}`
    used.add(id)
    if (!firstIdMap.has(message.id)) firstIdMap.set(message.id, id)
    return {
      ...structuredClone(message),
      id,
      ...(message.role === 'assistant' ? { modelId: null } : {}),
    } satisfies PromptChatMessageV2
  })
  return normalized.map((message) => ({
    ...message,
    ...(message.requestMessageId
      ? { requestMessageId: firstIdMap.get(message.requestMessageId) ?? message.requestMessageId }
      : {}),
  }))
}


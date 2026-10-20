import type {
  PromptChatMessage,
  PromptChatSummary,
} from './promptChatTypes'

export type ConversationIndicator =
  | { kind: 'none'; label: '' }
  | { kind: 'running'; label: "Assistant is responding" }
  | { kind: 'unread'; label: "New response" }
  | { kind: 'error'; label: "Response error" }

export function shouldShowConversationSearch(list: PromptChatSummary[]): boolean {
  return list.length >= 8
}

export function filterAndSortConversations(
  list: PromptChatSummary[],
  query: string,
): PromptChatSummary[] {
  const normalized = query.trim().toLocaleLowerCase('en-US')
  return [...list]
    .filter((item) => !normalized || item.title.toLocaleLowerCase('en-US').includes(normalized))
    .sort((left, right) => (
      right.updatedAt - left.updatedAt || left.title.localeCompare(right.title, 'en-US')
    ))
}

export function conversationStatus(summary: PromptChatSummary): ConversationIndicator {
  if (summary.attention === 'running') return { kind: 'running', label: "Assistant is responding" }
  if (summary.attention === 'unread') return { kind: 'unread', label: "New response" }
  if (summary.attention === 'error') return { kind: 'error', label: "Response error" }
  return { kind: 'none', label: '' }
}

export function modelTransitionMarkers(messages: PromptChatMessage[]): boolean[] {
  let previous: string | null | undefined
  return messages.map((message) => {
    const changed = message.role === 'assistant'
      && Boolean(message.modelId)
      && message.modelId !== previous
    if (message.role === 'assistant' && message.modelId) previous = message.modelId
    return changed
  })
}

export function relativeConversationTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000))
  if (seconds < 60) return "Now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} d`
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' }).format(timestamp)
}

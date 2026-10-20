// Проверки данных диалога: что считается сообщением, вложением, черновиком,
// корректным индексом и мета-записью. Вынесено из promptChatStorage — там это
// лежало вперемешку с работой с диском и самим репозиторием на 1035 строк.
//
// Здесь же живёт священный запрет на base64: containsInlineData не пускает в
// историю ни одну строку data:, иначе разговор раздувал бы файл проекта.
import {
  EMPTY_PROMPT_CHAT_CONTEXT,
  type PromptChatAttachment,
  type PromptChatContextV1,
  type PromptChatDraft,
  type PromptChatIndexV2,
  type PromptChatMessageV2,
  type PromptChatMetaV2,
  type PromptChatCommandName,
  type PromptChatRequestReceipt,
  type PromptChatSummary,
  SHAPE_ID_RE,
} from './promptChatTypes.js'

export const ID_RE = /^[A-Za-z0-9_-]{1,80}$/
export const MAX_TEXT = 12_000
// The shared prompt-chat parser keeps at most ten suggestions.  V2 storage
// must accept that same package, otherwise a valid answer disappears on append.
const MAX_PROMPTS = 10

export function emptyIndex(): PromptChatIndexV2 {
  return {
    version: 2,
    revision: 0,
    activeConversationId: null,
    conversations: [],
    hasTrash: false,
    boardMemoryEnabled: true,
  }
}

export function assertSafeId(value: string, label: string): void {
  if (!ID_RE.test(value)) throw new Error(`prompt-chat: invalid ${label}`)
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function containsInlineData(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value).toLowerCase()
    return serialized.includes('data:') || serialized.includes(';base64,')
  } catch {
    return true
  }
}

export function isAttachment(value: unknown): value is PromptChatAttachment {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<PromptChatAttachment>
  return typeof raw.shapeId === 'string'
    && SHAPE_ID_RE.test(raw.shapeId)
    && (raw.kind === 'image' || raw.kind === 'video' || raw.kind === 'text')
    && typeof raw.label === 'string'
    && raw.label.length <= 500
    && (raw.src === undefined || (
      typeof raw.src === 'string'
      && raw.src.startsWith('/media/')
      && !raw.src.includes('..')
      && raw.src.length <= 2_000
    ))
    && (raw.text === undefined || (typeof raw.text === 'string' && raw.text.length <= 8_000))
    && (raw.width === undefined || (Number.isFinite(raw.width) && raw.width >= 0))
    && (raw.height === undefined || (Number.isFinite(raw.height) && raw.height >= 0))
}

export function isMessage(value: unknown): value is PromptChatMessageV2 {
  if (!value || typeof value !== 'object' || containsInlineData(value)) return false
  const raw = value as Partial<PromptChatMessageV2>
  if (
    typeof raw.id !== 'string'
    || !ID_RE.test(raw.id)
    || (raw.role !== 'user' && raw.role !== 'assistant')
    || typeof raw.text !== 'string'
    || raw.text.length > MAX_TEXT
    || typeof raw.createdAt !== 'number'
    || !Number.isFinite(raw.createdAt)
    || raw.createdAt < 0
  ) return false
  if (raw.boardMemoryEnabled !== undefined && typeof raw.boardMemoryEnabled !== 'boolean') return false
  if (
    raw.status !== undefined
    && !['submitting', 'queued', 'running', 'done', 'error', 'cancelled'].includes(raw.status)
  ) return false
  if (raw.requestId !== undefined && (typeof raw.requestId !== 'string' || !ID_RE.test(raw.requestId))) {
    return false
  }
  if (raw.reply !== undefined && (typeof raw.reply !== 'string' || raw.reply.length > MAX_TEXT)) return false
  if (raw.attachments !== undefined && (
    !Array.isArray(raw.attachments)
    || raw.attachments.length > 8
    || !raw.attachments.every(isAttachment)
  )) return false
  if (raw.prompts !== undefined && (
    !Array.isArray(raw.prompts)
    || raw.prompts.length > MAX_PROMPTS
    || !raw.prompts.every((item) => (
      item
      && typeof item === 'object'
      && typeof item.title === 'string'
      && item.title.length <= 200
      && typeof item.prompt === 'string'
      && item.prompt.length <= MAX_TEXT
      && Boolean(item.prompt.trim())
    ))
  )) return false
  if (raw.referenceNotes !== undefined && (
    !Array.isArray(raw.referenceNotes)
    || raw.referenceNotes.length > 8
    || !raw.referenceNotes.every((note) => typeof note === 'string' && note.length <= 200)
  )) return false
  return true
}

export function assertMessages(messages: PromptChatMessageV2[]): void {
  if (containsInlineData(messages)) {
    throw new Error('prompt-chat: base64 and data: forbidden')
  }
  if (!Array.isArray(messages) || !messages.every(isMessage)) {
    throw new Error('prompt-chat: invalid message format')
  }
}

export function isDraft(value: unknown): value is PromptChatDraft {
  if (!value || typeof value !== 'object' || containsInlineData(value)) return false
  const raw = value as Partial<PromptChatDraft>
  return typeof raw.text === 'string'
    && raw.text.length <= MAX_TEXT
    && Array.isArray(raw.attachments)
    && raw.attachments.length <= 8
    && raw.attachments.every(isAttachment)
    && Number.isInteger(raw.selectionStart)
    && Number.isInteger(raw.selectionEnd)
    && raw.selectionStart! >= 0
    && raw.selectionEnd! >= raw.selectionStart!
    && raw.selectionEnd! <= raw.text.length
}

export function validateIndex(value: unknown): PromptChatIndexV2 {
  if (!value || typeof value !== 'object') throw new Error('prompt-chat: corrupted index.json')
  const raw = value as Partial<PromptChatIndexV2>
  if (
    raw.version !== 2
    || !Number.isInteger(raw.revision)
    || raw.revision! < 0
    || (raw.activeConversationId !== null && (
      typeof raw.activeConversationId !== 'string' || !ID_RE.test(raw.activeConversationId)
    ))
    || !Array.isArray(raw.conversations)
    || typeof raw.hasTrash !== 'boolean'
    || (raw.boardMemoryEnabled !== undefined && typeof raw.boardMemoryEnabled !== 'boolean')
  ) throw new Error('prompt-chat: corrupted index.json')
  return raw as PromptChatIndexV2
}

export function validateMeta(value: unknown): PromptChatMetaV2 {
  if (!value || typeof value !== 'object' || containsInlineData(value)) {
    throw new Error('prompt-chat: corrupted meta.json')
  }
  const raw = value as Partial<PromptChatMetaV2>
  if (
    raw.version !== 2
    || !Number.isInteger(raw.revision)
    || raw.revision! < 0
    || typeof raw.id !== 'string'
    || !ID_RE.test(raw.id)
    || typeof raw.projectId !== 'string'
    || !ID_RE.test(raw.projectId)
    || typeof raw.title !== 'string'
    || raw.title.length > 200
    || typeof raw.selectedModelId !== 'string'
    || !ID_RE.test(raw.selectedModelId)
    || typeof raw.createdAt !== 'number'
    || !Number.isFinite(raw.createdAt)
    || typeof raw.updatedAt !== 'number'
    || !Number.isFinite(raw.updatedAt)
    || !isDraft(raw.draft)
    || !Array.isArray(raw.activeJobIds)
    || !raw.activeJobIds.every((id) => typeof id === 'string' && ID_RE.test(id))
    || (raw.lastReadAssistantMessageId !== undefined && (
      typeof raw.lastReadAssistantMessageId !== 'string'
      || !ID_RE.test(raw.lastReadAssistantMessageId)
    ))
  ) throw new Error('prompt-chat: corrupted meta.json')
  return raw as PromptChatMetaV2
}

export function validateReceipts(value: unknown): PromptChatRequestReceipt[] {
  if (!value || typeof value !== 'object') throw new Error('prompt-chat: corrupted requests.json')
  const raw = value as { version?: unknown; receipts?: unknown }
  if (
    raw.version !== 1
    || !Array.isArray(raw.receipts)
    || raw.receipts.length > 128
    || !raw.receipts.every((receipt) => {
      if (!receipt || typeof receipt !== 'object' || containsInlineData(receipt)) return false
      const item = receipt as Partial<PromptChatRequestReceipt>
      return typeof item.scope === 'string'
        && item.scope.length <= 100
        && typeof item.requestId === 'string'
        && ID_RE.test(item.requestId)
        && ['create', 'activate', 'patch', 'record', 'append-history', 'send', 'trash', 'restore', 'permanent-delete'].includes(String(item.command))
        && typeof item.createdAt === 'number'
        && Number.isFinite(item.createdAt)
    })
  ) throw new Error('prompt-chat: corrupted requests.json')
  return raw.receipts as PromptChatRequestReceipt[]
}

export function validateContext(value: unknown): PromptChatContextV1 {
  if (!value || typeof value !== 'object' || containsInlineData(value)) {
    throw new Error('prompt-chat: corrupted context.json')
  }
  const raw = value as Partial<PromptChatContextV1>
  if (
    raw.version !== 1
    || !Number.isInteger(raw.revision)
    || raw.revision! < 0
    || (raw.summary !== null && (typeof raw.summary !== 'object' || Array.isArray(raw.summary)))
    || (raw.summaryThroughMessageId !== null && (
      typeof raw.summaryThroughMessageId !== 'string' || !ID_RE.test(raw.summaryThroughMessageId)
    ))
    || !Array.isArray(raw.checkpoints)
    || raw.checkpoints.length > 3
    || !raw.compaction
    || !['idle', 'queued', 'running', 'confirmation-required', 'error'].includes(raw.compaction.status)
  ) throw new Error('prompt-chat: corrupted context.json')
  if (raw.summaryMeta !== undefined && (
    !raw.summaryMeta
    || typeof raw.summaryMeta !== 'object'
    || (raw.summaryMeta.fromMessageId !== null && !ID_RE.test(raw.summaryMeta.fromMessageId))
    || !ID_RE.test(raw.summaryMeta.throughMessageId)
    || !Number.isFinite(raw.summaryMeta.createdAt)
    || !ID_RE.test(raw.summaryMeta.modelId)
  )) throw new Error('prompt-chat: corrupted context.json')
  return raw as PromptChatContextV1
}

export function previewOf(messages: PromptChatMessageV2[]): string {
  const last = messages.at(-1)
  if (!last) return ''
  const value = last.reply || last.text || last.prompts?.[0]?.prompt || ''
  return value.trim().replace(/\s+/g, ' ').slice(0, 200)
}

export function attentionOf(
  messages: PromptChatMessageV2[],
  lastReadAssistantMessageId?: string,
): PromptChatSummary['attention'] {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  if (lastAssistant?.status === 'queued' || lastAssistant?.status === 'running' || lastAssistant?.status === 'submitting') {
    return 'running'
  }
  if (lastAssistant?.status === 'error') return 'error'
  if (
    lastAssistant?.status === 'done'
    && lastAssistant.id !== lastReadAssistantMessageId
  ) return 'unread'
  return 'idle'
}


export type PromptChatAttention = 'idle' | 'running' | 'unread' | 'error'

// shapeId ссылается либо на объект холста (uuid), либо на слот полки ассетов
// («asset:3»), поэтому двоеточие допустимо. В отличие от id диалогов и досок,
// в пути файлов он НЕ попадает — каталоги фильтруются своим ID_RE.
// Без двоеточия любой ассет в чате ронял сохранение черновика.
export const SHAPE_ID_RE = /^[A-Za-z0-9_:-]{1,80}$/

export interface PromptChatAttachment {
  shapeId: string
  assetId?: string
  kind: 'image' | 'video' | 'text' | 'audio'
  label: string
  src?: string
  text?: string
  width?: number
  height?: number
}

export interface PromptChatSuggestion {
  title: string
  prompt: string
}

export type PromptChatMessageStatus =
  | 'submitting'
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'

export interface PromptChatMessageV2 {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  status?: PromptChatMessageStatus
  jobId?: string
  requestMessageId?: string
  requestId?: string
  reply?: string
  prompts?: PromptChatSuggestion[]
  attachments?: PromptChatAttachment[]
  error?: string
  modelId?: string | null
  referenceNotes?: string[]
  /** Whether this turn included automatic board memory (history stays intact). */
  boardMemoryEnabled?: boolean
}

export interface PromptChatSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  preview: string
  attention: PromptChatAttention
}

export interface PromptChatIndexV2 {
  version: 2
  revision: number
  activeConversationId: string | null
  conversations: PromptChatSummary[]
  hasTrash: boolean
  /** Missing on legacy indexes means enabled. */
  boardMemoryEnabled?: boolean
}

export interface PromptChatDraft {
  text: string
  attachments: PromptChatAttachment[]
  selectionStart: number
  selectionEnd: number
}

export interface PromptChatMetaV2 {
  version: 2
  revision: number
  id: string
  projectId: string
  title: string
  selectedModelId: string
  createdAt: number
  updatedAt: number
  draft: PromptChatDraft
  activeJobIds: string[]
  lastReadAssistantMessageId?: string
}

export interface PromptChatMemory {
  goal: string
  facts: string[]
  decisions: Array<{ text: string; reason: string }>
  constraints: string[]
  preferences: string[]
  referenceNotes: string[]
  openQuestions: string[]
  chronology: string
}

export interface PromptChatCheckpoint {
  revision: number
  summary: PromptChatMemory
  fromMessageId: string | null
  throughMessageId: string
  createdAt: number
  modelId: string
}

export interface PromptChatSummaryMeta {
  fromMessageId: string | null
  throughMessageId: string
  createdAt: number
  modelId: string
}

export interface PromptChatContextV1 {
  version: 1
  revision: number
  summary: PromptChatMemory | null
  summaryThroughMessageId: string | null
  summaryMeta?: PromptChatSummaryMeta
  checkpoints: PromptChatCheckpoint[]
  compaction: {
    status: 'idle' | 'queued' | 'running' | 'confirmation-required' | 'error'
    jobId?: string
    error?: string
    estimatedCostUsd?: number
  }
}

export interface ConversationPage {
  meta: PromptChatMetaV2
  messages: PromptChatMessageV2[]
  before: string | null
  contextHealth: 'ready' | 'stale' | 'error'
}

export interface ConversationPatch {
  title?: string
  selectedModelId?: string
  draft?: PromptChatDraft
  activeJobIds?: string[]
}

export type PromptChatCommandName =
  | 'create'
  | 'activate'
  | 'patch'
  | 'record'
  | 'append-history'
  | 'send'
  | 'trash'
  | 'restore'
  | 'permanent-delete'

export interface PromptChatRequestReceipt {
  scope: string
  requestId: string
  command: PromptChatCommandName
  createdAt: number
  result: unknown
}

export interface PromptChatEstimate {
  modelId: string
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  requiresConfirmation: boolean
  contextHealth: 'ready' | 'stale'
  /** Frozen preference used to calculate this estimate when known. */
  boardMemoryEnabled?: boolean
}

export interface BeginTurnInput {
  requestId: string
  text: string
  attachments: PromptChatAttachment[]
  confirmedCostUsd?: number
  /** Explicit value freezes this turn; omitted resolves the project preference. */
  boardMemoryEnabled?: boolean
}

export interface BeginTurnResult {
  revision: number
  jobId: string
  userMessage: PromptChatMessageV2
  assistantMessage: PromptChatMessageV2
  modelId: string
}

export interface RecordUserMessageInput {
  requestId: string
  text: string
  attachments: PromptChatAttachment[]
}

export interface RecordUserMessageResult {
  userMessage: PromptChatMessageV2
  meta: PromptChatMetaV2
}

export interface PromptChatHistoryMessageInput {
  role: 'user' | 'assistant'
  text: string
  reply?: string
}

export interface AppendHistoryMessagesInput {
  requestId: string
  messages: PromptChatHistoryMessageInput[]
}

export interface AppendHistoryMessagesResult {
  messages: PromptChatMessageV2[]
  meta: PromptChatMetaV2
}

export interface RepositoryDeps {
  rootDir: string
  now: () => number
  id: () => string
}

export const EMPTY_PROMPT_CHAT_CONTEXT: PromptChatContextV1 = {
  version: 1,
  revision: 0,
  summary: null,
  summaryThroughMessageId: null,
  checkpoints: [],
  compaction: { status: 'idle' },
}

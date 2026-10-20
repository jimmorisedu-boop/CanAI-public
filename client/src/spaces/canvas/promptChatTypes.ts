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

export interface PromptChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  status?: PromptChatMessageStatus
  jobId?: string
  requestMessageId?: string
  reply?: string
  prompts?: PromptChatSuggestion[]
  attachments?: PromptChatAttachment[]
  error?: string
  modelId?: string | null
  referenceNotes?: string[]
  /** Frozen board-memory choice used for this request (legacy messages omit it). */
  boardMemoryEnabled?: boolean
}

export type PromptChatMessageV2 = PromptChatMessage
export type PromptChatAttention = 'idle' | 'running' | 'unread' | 'error'

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
  /** Missing on legacy indexes and means enabled. The scope is the board. */
  boardMemoryEnabled?: boolean
}

export interface PromptChatIndexEnvelope {
  index: PromptChatIndexV2
  /** Cloud bridges that cannot persist this preference return false or omit it. */
  boardMemoryControlSupported?: boolean
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
}

export interface PromptChatEstimate {
  modelId: string
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  requiresConfirmation: boolean
  contextHealth: 'ready' | 'stale'
  /** The estimate was made with this frozen preference (legacy responses omit it). */
  boardMemoryEnabled?: boolean
}

export interface BeginTurnInput {
  requestId: string
  text: string
  attachments: PromptChatAttachment[]
  confirmedCostUsd?: number
  /** Freeze the board-memory choice for this turn; absent means server preference. */
  boardMemoryEnabled?: boolean
}

export interface BeginTurnResult {
  revision: number
  jobId: string
  userMessage: PromptChatMessageV2
  assistantMessage: PromptChatMessageV2
  modelId: string
  boardMemoryEnabled?: boolean
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

export interface ParsedPromptChatResponse {
  reply: string
  prompts: PromptChatSuggestion[]
}

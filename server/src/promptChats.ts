import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { SHAPE_ID_RE } from './promptChatTypes.js'

const promptChatsDir = path.join(path.dirname(config.projectFile), 'prompt-chats')
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const MAX_TEXT = 12_000
const MAX_ATTACHMENTS = 8
// Keep persisted assistant turns aligned with the shared response parser:
// one answer may contain a package of up to ten launchable prompts.
const MAX_PROMPTS = 10

export interface PromptChatAttachment {
  shapeId: string
  // audio — Gemini 3.8 Flash берёт звук контекстом (maxAudioRefs в каталоге)
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
}

export interface PromptChatDocumentV1 {
  version: 1
  conversationId: string
  messages: PromptChatMessage[]
  archives?: PromptChatArchive[]
}

export interface PromptChatArchive {
  id: string
  title: string
  createdAt: number
  messages: PromptChatMessage[]
}

export interface StoredPromptChat {
  revision: number
  document: PromptChatDocumentV1
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function isShortString(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === 'string' && value.length <= max
}

function isFiniteOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function containsInlineData(value: unknown): boolean {
  try {
    return JSON.stringify(value).toLowerCase().includes('data:')
  } catch {
    return true
  }
}

function isAttachment(value: unknown): value is PromptChatAttachment {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<PromptChatAttachment>
  if (
    typeof raw.shapeId !== 'string' ||
    !SHAPE_ID_RE.test(raw.shapeId) ||
    (raw.kind !== 'image' && raw.kind !== 'video' && raw.kind !== 'text' && raw.kind !== 'audio') ||
    !isShortString(raw.label, 500)
  ) return false
  if (raw.src !== undefined) {
    if (
      typeof raw.src !== 'string' ||
      !raw.src.startsWith('/media/') ||
      raw.src.includes('..') ||
      raw.src.length > 2_000
    ) return false
  }
  if (!isShortString(raw.text ?? '', 8_000)) return false
  return isFiniteOptionalNumber(raw.width) && isFiniteOptionalNumber(raw.height)
}

function isSuggestion(value: unknown): value is PromptChatSuggestion {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<PromptChatSuggestion>
  return isShortString(raw.title, 200) && isShortString(raw.prompt) && Boolean(raw.prompt.trim())
}

function isMessage(value: unknown): value is PromptChatMessage {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<PromptChatMessage>
  if (
    typeof raw.id !== 'string' ||
    !ID_RE.test(raw.id) ||
    (raw.role !== 'user' && raw.role !== 'assistant') ||
    !isShortString(raw.text) ||
    typeof raw.createdAt !== 'number' ||
    !Number.isFinite(raw.createdAt) ||
    raw.createdAt < 0
  ) return false
  if (
    raw.status !== undefined &&
    !['submitting', 'queued', 'running', 'done', 'error', 'cancelled'].includes(raw.status)
  ) return false
  if (raw.jobId !== undefined && (typeof raw.jobId !== 'string' || !ID_RE.test(raw.jobId))) return false
  if (
    raw.requestMessageId !== undefined &&
    (typeof raw.requestMessageId !== 'string' || !ID_RE.test(raw.requestMessageId))
  ) return false
  if (raw.reply !== undefined && !isShortString(raw.reply)) return false
  if (raw.error !== undefined && !isShortString(raw.error, 2_000)) return false
  if (
    raw.attachments !== undefined &&
    (!Array.isArray(raw.attachments) ||
      raw.attachments.length > MAX_ATTACHMENTS ||
      !raw.attachments.every(isAttachment))
  ) return false
  return raw.prompts === undefined ||
    (Array.isArray(raw.prompts) && raw.prompts.length <= MAX_PROMPTS && raw.prompts.every(isSuggestion))
}

export function isLegacyPromptChatDocument(value: unknown): value is PromptChatDocumentV1 {
  if (!value || typeof value !== 'object' || containsInlineData(value)) return false
  const raw = value as Partial<PromptChatDocumentV1>
  const archives = raw.archives
  const archivesValid = archives === undefined || (
    Array.isArray(archives)
    && archives.every((archive) => {
      if (!archive || typeof archive !== 'object') return false
      const item = archive as Partial<PromptChatArchive>
      return typeof item.id === 'string'
        && item.id.length <= 500
        && isShortString(item.title, 200)
        && typeof item.createdAt === 'number'
        && Number.isFinite(item.createdAt)
        && Array.isArray(item.messages)
        && item.messages.every(isMessage)
    })
  )
  return raw.version === 1
    && typeof raw.conversationId === 'string'
    && raw.conversationId.length <= 500
    && Array.isArray(raw.messages)
    && raw.messages.every(isMessage)
    && archivesValid
}

export async function readLegacyPromptChat(
  projectId: string,
  rootDir = promptChatsDir,
): Promise<StoredPromptChat | null> {
  if (!ID_RE.test(projectId)) return null
  const file = path.join(rootDir, `${projectId}.json`)
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<StoredPromptChat>
    if (
      !Number.isInteger(parsed.revision)
      || parsed.revision! < 0
      || !isLegacyPromptChatDocument(parsed.document)
    ) {
      throw new Error('prompt-chat: corrupted legacy-file')
    }
    return { revision: parsed.revision!, document: parsed.document }
  } catch (error) {
    if (isNotFound(error)) return null
    if (error instanceof Error && (error.message.includes('corrupted') || error.message.includes('повреждён'))) throw error
    throw new Error('prompt-chat: corrupted legacy-file', { cause: error })
  }
}

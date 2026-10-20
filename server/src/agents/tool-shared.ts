import crypto from 'node:crypto'
import type {
  AgentArtifact,
  AgentArtifactRef,
  AgentGenerationBudgetView,
  AgentLlmBudgetView,
  AgentMediaRenderManifest,
  AgentSpendBudgetView,
} from '../../../packages/agent-protocol/index.js'
import type { AgentTaskRecord } from './types.js'

export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
export const SAFE_PROJECT = /^[A-Za-z0-9_-]{1,100}$/u

export class AgentToolError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
  }
}

export interface ToolBrokerOptions {
  mediaDir: string
  workspaceRoot: string
  llm?: import('./llm-broker.js').AgentLlmBroker
  generation?: import('./generation-broker.js').AgentGenerationBroker
  /** Testable Host-owned FFmpeg boundary; production resolves installed tools. */
  mediaRender?: MediaRenderRuntime
  /** Подмена жёсткой ссылки для media.read в тестах (тома без ссылок). */
  linkFile?: (existingPath: string, newPath: string) => Promise<void>
}

export interface ToolResult {
  result: Record<string, unknown>
  /** The operation is accepted but waits for an attached local canvas save. */
  pending?: { waitId: string }
  /** Internal Host commit metadata; never serialized into the agent receipt. */
  mediaRender?: MediaRenderCommit
}

/** Запуск ffmpeg/ffprobe. В бою это runTool; тест подставляет свой. */
export type MediaRenderRun = (
  executable: string,
  args: readonly string[],
  options?: { timeoutMs?: number; maxStdoutBytes?: number; signal?: AbortSignal },
) => Promise<{ stdout: Buffer; stderr: string }>

export interface MediaRenderRuntime {
  tools?: { ffmpeg: string; ffprobe: string }
  run?: MediaRenderRun
  /** Потолок времени одного прохода ffmpeg. По умолчанию считается от длины монтажа. */
  timeoutMs?: number
  /** Подмена жёсткой ссылки в тестах: на exFAT и FAT её нет. */
  link?: (existingPath: string, newPath: string) => Promise<void>
}

export interface MediaRenderCommit {
  operationId: string
  manifestHash: string
  /** Проверенные Host исходники, без повторов, в порядке первого появления. */
  sourceRefs: AgentArtifactRef[]
  artifact: AgentArtifact
  manifest: AgentMediaRenderManifest
  /** Убрать выпущенный файл: задачу успели отменить, пока шёл рендер, и
   *  артефакт в журнал не попадёт. Без ссылки из журнала файл — мусор. */
  discard: () => Promise<void>
}

/**
 * Build the one durable financial ledger used by all local-fal paid tools.
 * Tool-specific views still carry model/pricing/ref pins, but never become
 * independent spend ceilings once this ledger is attached to a task.
 */
export function createSharedSpendBudget(
  taskId: string,
  llmBudget: AgentLlmBudgetView | undefined,
  generationBudget: AgentGenerationBudgetView | undefined,
): AgentSpendBudgetView | undefined {
  if (!llmBudget && !generationBudget) return undefined
  if (llmBudget && generationBudget && llmBudget.maxCostMicros !== generationBudget.maxCostMicros) {
    throw new AgentToolError('BUDGET_CONFLICT', 'LLM and generation must use the same task maxCostMicros')
  }
  if (llmBudget && generationBudget && llmBudget.grantId !== generationBudget.grantId) {
    throw new AgentToolError('BUDGET_CONFLICT', 'LLM and generation must use the same task grant')
  }
  const source = llmBudget ?? generationBudget!
  const maxCalls = (llmBudget?.maxCalls ?? 0) + (generationBudget?.maxCalls ?? 0)
  return {
    grantId: source.grantId || stableScopedId('grant', taskId, 'local-fal'),
    connectionId: 'local-fal',
    currency: 'USD',
    maxCostMicros: source.maxCostMicros,
    reservedMicros: 0,
    chargedMicros: 0,
    overshootMicros: 0,
    calls: 0,
    maxCalls: Math.max(1, Math.min(maxCalls, 1000)),
    status: 'active',
  }
}

/** Derive the aggregate ledger status from every paid operation on a task. */
export function sharedSpendStatusFor(
  budget: AgentSpendBudgetView,
  operations: Array<{ status: string; reservedMicros: number }>,
): AgentSpendBudgetView['status'] {
  if (operations.some((operation) => operation.status === 'uncertain' || (operation.status === 'cancelled' && operation.reservedMicros > 0))) return 'blocked'
  if (budget.overshootMicros > 0) return 'overspent'
  if (budget.calls >= budget.maxCalls || budget.chargedMicros + budget.reservedMicros >= budget.maxCostMicros) return 'exhausted'
  return 'active'
}

export type CanvasResultItem = { slotId: string; itemId: string; revision: number; artifactId: string }

export interface PreparedCanvasItem {
  itemId: string
  artifactId: string
  slotId: string
  kind: 'image' | 'video' | 'audio' | 'text'
  x: number
  y: number
  w: number
  h: number
  name: string
  text?: string
  src?: string
  mime?: string
  naturalWidth?: number
  naturalHeight?: number
  duration?: number
}

export interface PreparedCanvasResult {
  workspaceId: string
  items: CanvasResultItem[]
  canvasItems: PreparedCanvasItem[]
  textItems: PreparedCanvasItem[]
}

export function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/gu, '_')
  if (normalized === value && normalized.length <= 80) return normalized
  const digest = identityDigest([value]).slice(0, 24)
  const head = normalized.slice(0, 80 - digest.length - 1)
  return `${head}-${digest}`
}

/**
 * Make a protocol-safe ID while retaining a readable prefix.  The digest is
 * calculated from the complete identity parts, not from their display-safe
 * forms, so punctuation, Unicode and truncated values remain distinct.
 */
export function stableId(prefix: string, ...parts: string[]): string {
  const readable = parts.map((part) => safeSegment(part)).join('-')
  const legacy = `${prefix}-${readable}`
  if (parts.every((part) => safeSegment(part) === part) && legacy.length <= 160) return legacy
  const digest = identityDigest(parts).slice(0, 32)
  const readableLimit = Math.max(1, 160 - prefix.length - digest.length - 2)
  return `${prefix}-${readable.slice(0, readableLimit)}-${digest}`
}

/** Same as stableId, retaining the colon-delimited Cloud operation shape. */
export function stableScopedId(prefix: string, ...parts: string[]): string {
  const readable = parts.map((part) => safeSegment(part)).join(':')
  const legacy = `${prefix}:${readable}`
  if (parts.every((part) => safeSegment(part) === part) && legacy.length <= 160) return legacy
  const digest = identityDigest(parts).slice(0, 32)
  const readableLimit = Math.max(1, 160 - prefix.length - digest.length - 2)
  return `${prefix}:${readable.slice(0, readableLimit)}:${digest}`
}

function identityDigest(parts: string[]): string {
  const hash = crypto.createHash('sha256')
  for (const part of parts) {
    hash.update(String(part).length.toString(10))
    hash.update(':')
    hash.update(String(part))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function artifactKind(value: unknown): AgentArtifact['kind'] {
  if (value === 'image' || value === 'video' || value === 'audio' || value === 'text' || value === 'document' || value === 'plan') return value
  throw new AgentToolError('INPUT_INVALID', 'artifact kind is not supported')
}

export function mime(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(value)) {
    throw new AgentToolError('INPUT_INVALID', 'mimeType is not supported')
  }
  return value
}

export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/\S/u.test(value)) throw new AgentToolError('INPUT_INVALID', label + ' is required')
  return value
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentToolError('INPUT_INVALID', label + ' must be an object')
  return value as Record<string, unknown>
}

export function projectId(task: AgentTaskRecord): string {
  if (!SAFE_PROJECT.test(task.projectRef.id)) throw new AgentToolError('INPUT_INVALID', 'Invalid board identifier')
  return task.projectRef.id
}

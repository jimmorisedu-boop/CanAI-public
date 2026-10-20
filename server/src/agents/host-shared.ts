import crypto from 'node:crypto'
import type { AgentGenerationAuthorization, AgentGenerationCaptureReceipt, AgentLlmAuthorization, AgentTaskState } from '../../../packages/agent-protocol/index.js'
import { AgentProtocolError } from './validation.js'
import { AgentToolError } from './tools.js'

export const TERMINAL = new Set<AgentTaskState>(['cancelled', 'succeeded', 'failed'])
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/u

export class AgentHostError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = 'AgentHostError'
  }
}

export interface CreateAgentTaskInput {
  requestId: string
  packageId: string
  taskType: string
  instruction: string
  input: Record<string, unknown>
  projectRef: { source: 'local' | 'cloud'; id: string }
  inputs?: import('../../../packages/agent-protocol/index.js').AgentStartPayload['inputs']
  /** Trusted desktop consent and positive local-fal spend ceiling. */
  llm?: AgentLlmAuthorization
  /** Trusted desktop consent and positive local-fal media spend ceiling. */
  generation?: AgentGenerationAuthorization
  /** Host-issued native media receipts echoed by the browser at admission. */
  capturedArtifacts?: AgentGenerationCaptureReceipt[]
  ownerId?: string
  controllerId?: string
}

export interface ControlRequest {
  requestId: string
  action: 'pause' | 'resume' | 'cancel'
  expectedRevision: number
  reason: string
}

export function clone<T>(value: T): T {
  return structuredClone(value)
}

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function hash(value: unknown): string {
  return crypto.createHash('sha256').update(stable(value)).digest('hex')
}

export function checkIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new AgentHostError('INPUT_INVALID', `${label}: invalid identifier`)
  return value
}

export function errorPayload(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof AgentHostError) return { code: error.code, message: error.message, retryable: false }
  if (error instanceof AgentToolError) return { code: error.code, message: error.message, retryable: error.retryable }
  if (error instanceof AgentProtocolError) return { code: error.code, message: error.message, retryable: false }
  return { code: 'HOST_ERROR', message: error instanceof Error ? error.message : String(error), retryable: false }
}

export function publicError(error: unknown): AgentHostError {
  if (error instanceof AgentHostError) return error
  const payload = errorPayload(error)
  return new AgentHostError(payload.code, payload.message, payload.code === 'REVISION_CONFLICT' ? 409 : 400)
}

export function outcomeState(outcome: unknown): AgentTaskState {
  if (outcome === 'succeeded') return 'succeeded'
  if (outcome === 'cancelled') return 'cancelled'
  return 'failed'
}

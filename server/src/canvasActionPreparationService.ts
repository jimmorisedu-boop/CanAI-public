import { randomUUID } from 'node:crypto'
import { MAX_PROMPT_CHARS } from './promptLimits.js'
import { parseRefs, type IncomingRef } from './refs.js'
import { validateCanvasActionRefs } from './canvasActionPreparation.js'

const SHORT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/u
const MAX_IDEMPOTENCY_KEY = 160

/** The public request is intentionally smaller than `/api/generate`. */
export interface CanvasActionPreparationRequest {
  projectRef: { source: 'local'; id: string }
  prompt: string
  refs: IncomingRef[]
  /** `undefined` means active local/Cloud profile; `null` means Universal. */
  assistantId?: string | null
  profileVersionId?: string | null
  idempotencyKey?: string
}

export interface CanvasActionQuoteInput {
  projectId: string
  model: string
  prompt: string
  params: Record<string, unknown>
  refs: IncomingRef[]
  idempotencyKey: string
  confirmed?: boolean
}

export class CanvasActionRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
    this.name = 'CanvasActionRequestError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function idField(value: unknown, allowNull = false): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null && allowNull) return null
  if (typeof value !== 'string' || !SHORT_ID_RE.test(value.trim())) return undefined
  return value.trim()
}

function stringField(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\u0000/u.test(value)) {
    throw new CanvasActionRequestError(400, `${label} has an invalid format`, 'CANVAS_ACTION_INVALID')
  }
  return value.trim()
}

function optionalStringField(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\u0000/u.test(value)) {
    throw new CanvasActionRequestError(400, `${label} has an invalid format`, 'CANVAS_ACTION_INVALID')
  }
  return value.trim()
}

/** Parse and reject generation-shaped fields before any profile or quote work. */
export function parseCanvasActionRequest(body: unknown): CanvasActionPreparationRequest {
  if (!isRecord(body)) {
    throw new CanvasActionRequestError(400, 'Invalid action preparation body', 'CANVAS_ACTION_INVALID')
  }
  // This route has no client-selected media model, endpoint, params, or tools
  // contract. Rejecting unknown fields prevents accidental API widening.
  const allowed = new Set([
    'projectRef', 'prompt', 'refs', 'assistantId', 'profileVersionId',
    'assistantVersionId', 'idempotencyKey',
  ])
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new CanvasActionRequestError(400, 'Preparation accepts only text, images, and a profile', 'CANVAS_ACTION_INVALID')
  }
  const rawProject = body.projectRef
  if (!isRecord(rawProject)
    || rawProject.source !== 'local'
    || typeof rawProject.id !== 'string'
    || !SHORT_ID_RE.test(rawProject.id)) {
    throw new CanvasActionRequestError(400, 'Invalid board for action preparation', 'CANVAS_ACTION_INVALID')
  }
  const prompt = stringField(body.prompt, MAX_PROMPT_CHARS, 'Prompt')
  const refs = parseRefs(body.refs)
  if (refs === null) {
    throw new CanvasActionRequestError(400, 'References have an invalid format', 'CANVAS_ACTION_INVALID')
  }
  const refError = validateCanvasActionRefs(refs)
  if (refError) throw new CanvasActionRequestError(400, refError, 'CANVAS_ACTION_REFS_INVALID')

  const assistantId = idField(body.assistantId, true)
  if (body.assistantId !== undefined && assistantId === undefined) {
    throw new CanvasActionRequestError(400, 'Invalid assistant', 'CANVAS_ACTION_PROFILE_INVALID')
  }
  const rawVersion = body.profileVersionId ?? body.assistantVersionId
  const profileVersionId = idField(rawVersion, true)
  if (rawVersion !== undefined && profileVersionId === undefined) {
    throw new CanvasActionRequestError(400, 'Invalid assistant version', 'CANVAS_ACTION_PROFILE_INVALID')
  }
  const idempotencyKey = optionalStringField(body.idempotencyKey, MAX_IDEMPOTENCY_KEY, 'Run key')
    ?? randomUUID()
  if (/[\/]/u.test(idempotencyKey)) {
    throw new CanvasActionRequestError(400, 'Run key has an invalid format', 'CANVAS_ACTION_INVALID')
  }
  return {
    projectRef: { source: rawProject.source, id: rawProject.id },
    prompt,
    refs,
    ...(assistantId !== undefined ? { assistantId } : {}),
    ...(profileVersionId !== undefined ? { profileVersionId } : {}),
    idempotencyKey,
  }
}

import { systemMessage, systemStatusMessage } from '../ui/systemMessage'

/**
 * Tablet transports must not import the desktop API module just to preserve
 * HTTP metadata: that module pulls the entire React application into the
 * cloud-only bundle. Keep this small Error-compatible carrier local.
 */
export class TabletHttpError extends Error {
  readonly originalMessage: string
  status?: number
  code?: string
  details?: unknown

  constructor(message: string, status?: number, code?: string, details?: unknown) {
    super(message)
    this.name = 'TabletHttpError'
    this.originalMessage = message
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * Present one application-owned error/status field on the tablet.
 *
 * Tablet transports intentionally keep the upstream value (and its HTTP/code
 * metadata) intact.  This helper is only for the final UI string, so board
 * names, prompts, assistant replies, and other user content are never walked
 * or rewritten.
 */
export function tabletSystemMessage(
  value: unknown,
  fallback = 'Request failed. Open the diagnostic log for details.',
  code?: string,
): string {
  let message: string | undefined
  let resolvedCode = code
  // Подробности отказа (модель, параметр, значение) — по ним systemMessage
  // собирает английскую фразу отказа параметра (ui/paramRefusal.ts).
  let details: unknown

  if (typeof value === 'string') {
    message = value
  } else if (value instanceof Error) {
    message = value.message
    const candidate = (value as Error & { code?: unknown }).code
    if (resolvedCode === undefined && typeof candidate === 'string') resolvedCode = candidate
    details = (value as Error & { details?: unknown }).details
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Only inspect the explicit system fields. Never recurse into response
    // documents, board snapshots, prompts, or assistant messages.
    const record = value as Record<string, unknown>
    const candidate = record.code
    if (resolvedCode === undefined && typeof candidate === 'string') resolvedCode = candidate
    if (typeof record.error === 'string') message = record.error
    else if (typeof record.message === 'string') message = record.message
    details = record.details
  }

  return systemMessage(message, fallback, resolvedCode, details)
}

/** Present an application-owned persisted progress/stage value at the UI edge. */
export function tabletSystemStatus(value: unknown, fallback = 'Working…'): string {
  const status = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).status === 'string'
      ? (value as Record<string, unknown>).status as string
      : undefined
  return systemStatusMessage(status, fallback)
}

/** Keep transport metadata while retaining the upstream text for diagnostics. */
export function tabletHttpError(
  message: string,
  status?: number,
  code?: string,
  details?: unknown,
): TabletHttpError {
  return new TabletHttpError(message, status, code, details)
}

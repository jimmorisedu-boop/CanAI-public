import { ApiError, type CanvasActionPreparationInput } from '../../api'
import { newId } from '../../ui/ids'
import { canvasActionTransport } from './canvasActionTransport'
import { pollCanvasActionPreparation } from './useCanvasActionPreparation'

export interface DockHelperRunInput {
  projectRef: { source: 'local' | 'cloud'; id: string }
  prompt: string
  refs: CanvasActionPreparationInput['refs']
  assistantId: string
  profileVersionId?: string | null
  expectedEstimateUsd?: number
  idempotencyKey?: string
  signal?: AbortSignal
  transport?: typeof canvasActionTransport
  onProgress?: (text: string) => void
  onJobStarted?: (jobId: string) => void
  askConfirm?: (params: {
    title: string
    rows: Array<[string, string]>
    confirmLabel: string
  }) => Promise<boolean>
  isCurrentScope?: () => boolean
}

export type DockHelperRunResult =
  | { status: 'success'; prompt: string }
  | { status: 'cancelled' }
  | { status: 'stale' }
  | { status: 'error'; error: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Helper failed to prepare request"
}

/**
 * Execute a single assistant prompt preparation run.
 * Each execution is isolated: its own idempotency key, abort signal, and lifecycle.
 * Handles 409 price quotes, polling, abortion, and scope invalidation.
 */
export async function executeDockHelperRun(
  input: DockHelperRunInput,
): Promise<DockHelperRunResult> {
  const isCurrent = () => {
    if (input.signal?.aborted) return false
    if (input.isCurrentScope && !input.isCurrentScope()) return false
    return true
  }

  if (!isCurrent()) {
    return input.signal?.aborted ? { status: 'cancelled' } : { status: 'stale' }
  }

  const transport = input.transport ?? canvasActionTransport
  const idempotencyKey = input.idempotencyKey ?? newId()

  let payload: CanvasActionPreparationInput = {
    projectRef: input.projectRef,
    prompt: input.prompt,
    refs: input.refs.map((r) => ({ ...r })),
    assistantId: input.assistantId,
    profileVersionId: input.profileVersionId ?? undefined,
    idempotencyKey,
  }

  let started: Awaited<ReturnType<typeof transport.prepare>> | null = null
  let quoteRound = 0

  while (!started) {
    if (!isCurrent()) {
      return input.signal?.aborted ? { status: 'cancelled' } : { status: 'stale' }
    }

    try {
      started = await transport.prepare(payload)
    } catch (error) {
      if (!isCurrent()) {
        return input.signal?.aborted ? { status: 'cancelled' } : { status: 'stale' }
      }

      if (error instanceof ApiError && error.code === 'PRICE_CONFIRMATION_REQUIRED' && error.quote) {
        quoteRound += 1
        const quote = error.quote
        const shownEstimate = input.expectedEstimateUsd ?? 0.01
        const quoteMatches = Math.abs((quote.amountUsd ?? 0) - shownEstimate) < 0.0005

        // Silent confirmation only on first round if needsConfirmation is false and estimate matches
        const canSilentlyConfirm = quoteRound === 1 && !quote.needsConfirmation && quoteMatches

        if (!canSilentlyConfirm) {
          if (!input.askConfirm) {
            return {
              status: 'error',
              error: `Preparation price confirmation required: $${quote.amountUsd?.toFixed(2) ?? '0.00'}`,
            }
          }

          const confirmed = await input.askConfirm({
            title: `Preparing the request: $${quote.amountUsd?.toFixed(2) ?? '0.00'}`,
            rows: [
              ["Assistant", `$${quote.amountUsd?.toFixed(2) ?? '0.00'}`],
            ],
            confirmLabel: "Confirm preparation",
          })

          if (!confirmed || !isCurrent()) {
            return input.signal?.aborted ? { status: 'cancelled' } : { status: 'cancelled' }
          }
        }

        payload = {
          ...payload,
          quoteId: quote.id,
          quoteHash: quote.requestHash,
          quoteConfirmed: true,
        }
        continue
      }

      return { status: 'error', error: errorMessage(error) }
    }
  }

  if (!isCurrent()) {
    if (started?.jobId) {
      void transport.cancel(started.jobId).catch(() => {})
    }
    return input.signal?.aborted ? { status: 'cancelled' } : { status: 'stale' }
  }

  const jobId = started.jobId
  input.onJobStarted?.(jobId)

  let cancelSent = false
  const sendCancelOnce = () => {
    if (cancelSent) return
    cancelSent = true
    void transport.cancel(jobId).catch(() => {})
  }

  if (input.signal) {
    input.signal.addEventListener('abort', sendCancelOnce, { once: true })
  }

  try {
    let latestResultText: string | null = null
    let latestError: string | null = null

    const outcome = await pollCanvasActionPreparation(jobId, {
      status: transport.status,
      isCurrent,
      onStatus: (status) => {
        if (!isCurrent()) return
        if (status.result?.text) {
          latestResultText = status.result.text.trim()
        }
        if (status.status === 'error' || String(status.status) === 'cancelled') {
          latestError = status.error || "Assistant could not prepare the request"
        }
        input.onProgress?.(status.progressText ?? "Assistant is preparing text…")
      },
      onTransientError: () => {
        if (!isCurrent()) return
        input.onProgress?.("Connection lost — retrying…")
      },
    })

    if (input.signal?.aborted) {
      sendCancelOnce()
      return { status: 'cancelled' }
    }

    if (input.isCurrentScope && !input.isCurrentScope()) {
      sendCancelOnce()
      return { status: 'stale' }
    }

    if (outcome === 'review') {
      if (latestResultText) {
        return { status: 'success', prompt: latestResultText }
      }
      // If result text was not captured during onProgress callback, check status directly once
      try {
        const finalStatus = await transport.status(jobId)
        const finalPrompt = finalStatus.result?.text?.trim()
        if (finalPrompt) {
          return { status: 'success', prompt: finalPrompt }
        }
      } catch {
        // Fall through to error
      }
      return { status: 'error', error: "Assistant did not return ready text" }
    }

    if (outcome === 'error') {
      return { status: 'error', error: latestError ?? "Assistant could not prepare the request" }
    }

    if (outcome === 'timeout') {
      sendCancelOnce()
      return { status: 'error', error: "Preparation took too long. Try again." }
    }

    return { status: 'stale' }
  } finally {
    if (input.signal) {
      input.signal.removeEventListener('abort', sendCancelOnce)
    }
  }
}

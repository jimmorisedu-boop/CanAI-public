import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type CanvasActionPreparationInput, type CanvasActionPreparationProfile } from '../../api'
import type { GenerationQuote } from '../../types'
import { newId } from '../../ui/ids'
import { canvasActionTransport } from './canvasActionTransport'

export type CanvasActionPreparationPhase = 'idle' | 'preparing' | 'quote' | 'review' | 'error' | 'cancelling'

export interface CanvasActionPreparationState {
  phase: CanvasActionPreparationPhase
  jobId: string | null
  progressText: string | null
  resultText: string | null
  profile: CanvasActionPreparationProfile | null
  quote: GenerationQuote | null
  chargedAmountUsd: number | null
  error: string | null
}

export type CanvasActionPreparationRequest = Omit<CanvasActionPreparationInput, 'idempotencyKey'> & {
  /** Reused only when retrying the same quote after explicit confirmation. */
  idempotencyKey?: string
}

interface CanvasActionPreparationTransport {
  prepare(input: CanvasActionPreparationInput): ReturnType<typeof canvasActionTransport.prepare>
  status(id: string): ReturnType<typeof canvasActionTransport.status>
  cancel(id: string): ReturnType<typeof canvasActionTransport.cancel>
}

const IDLE_STATE: CanvasActionPreparationState = {
  phase: 'idle',
  jobId: null,
  progressText: null,
  resultText: null,
  profile: null,
  quote: null,
  chargedAmountUsd: null,
  error: null,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Helper failed to prepare request"
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type CanvasActionPreparationPollOutcome = 'review' | 'error' | 'timeout' | 'stale'

export interface CanvasActionPreparationPollOptions {
  status(jobId: string): Promise<import('../../api').CanvasActionPreparationStatus>
  isCurrent(): boolean
  onStatus(status: import('../../api').CanvasActionPreparationStatus): void
  onTransientError(error: unknown): void
  now?: () => number
  wait?: (ms: number) => Promise<void>
  /** Maximum wall-clock time to keep the same server job alive. */
  deadlineMs?: number
}

/**
 * Poll one already-created preparation job. The transport is injected so a
 * dropped connection can be retried in isolation and, importantly, never
 * causes a second paid preparation request. Operation ownership is checked
 * between every await so an old board/mode operation cannot write state.
 */
export async function pollCanvasActionPreparation(
  jobId: string,
  options: CanvasActionPreparationPollOptions,
): Promise<CanvasActionPreparationPollOutcome> {
  const now = options.now ?? Date.now
  const sleep = options.wait ?? wait
  const deadline = now() + (options.deadlineMs ?? 10 * 60_000)
  let delay = 700

  while (options.isCurrent() && now() < deadline) {
    let status: import('../../api').CanvasActionPreparationStatus | null = null
    try {
      status = await options.status(jobId)
    } catch (error) {
      if (!options.isCurrent()) return 'stale'
      // A transient network/provider reconnect must not discard the paid job.
      // Keep the same id and continue with bounded backoff until the deadline.
      options.onTransientError(error)
    }

    if (!options.isCurrent()) return 'stale'
    if (status) {
      options.onStatus(status)
      const resultText = status.result?.text?.trim()
      if (resultText) return 'review'
      if (status.status === 'error' || String(status.status) === 'cancelled') return 'error'
    }

    const remaining = deadline - now()
    if (remaining <= 0) break
    await sleep(Math.min(delay, remaining))
    if (!options.isCurrent()) return 'stale'
    delay = Math.min(4_000, Math.round(delay * 1.35))
  }

  return options.isCurrent() ? 'timeout' : 'stale'
}

/** Shared operation check used by async prep and cancellation cleanup. */
export function isCanvasActionOperationCurrent(current: number, operation: number): boolean {
  return current === operation
}

export function useCanvasActionPreparation(
  transport: CanvasActionPreparationTransport = canvasActionTransport,
): {
  state: CanvasActionPreparationState
  prepare(input: CanvasActionPreparationRequest): Promise<void>
  confirmQuote(): Promise<void>
  cancel(): Promise<void>
  reset(): void
} {
  const [state, setState] = useState<CanvasActionPreparationState>(IDLE_STATE)
  const operationRef = useRef(0)
  const pendingRef = useRef<CanvasActionPreparationInput | null>(null)
  const jobRef = useRef<string | null>(null)

  const reset = useCallback(() => {
    operationRef.current += 1
    pendingRef.current = null
    jobRef.current = null
    setState(IDLE_STATE)
  }, [])

  const poll = useCallback(async (jobId: string, operation: number): Promise<void> => {
    const outcome = await pollCanvasActionPreparation(jobId, {
      status: transport.status,
      isCurrent: () => isCanvasActionOperationCurrent(operationRef.current, operation),
      onTransientError: (error) => {
        if (!isCanvasActionOperationCurrent(operationRef.current, operation)) return
        setState((current) => ({
          ...current,
          phase: 'preparing',
          jobId,
          progressText: "Connection lost — retrying…",
          error: null,
        }))
      },
      onStatus: (status) => {
        if (!isCanvasActionOperationCurrent(operationRef.current, operation)) return
        const resultText = status.result?.text?.trim() || null
        if (resultText) {
          setState({
            phase: 'review',
            jobId,
            progressText: status.progressText ?? null,
            resultText,
            profile: status.profile,
            quote: status.quote,
            chargedAmountUsd: status.chargedAmountUsd ?? null,
            error: null,
          })
          return
        }
        if (status.status === 'error' || String(status.status) === 'cancelled') {
          setState((current) => ({
            ...current,
            phase: 'error',
            jobId,
            progressText: null,
            error: status.error || "Assistant could not prepare the request",
          }))
          return
        }
        setState((current) => ({
          ...current,
          phase: 'preparing',
          jobId,
          progressText: status.progressText ?? "Assistant is preparing text…",
          profile: status.profile,
          quote: status.quote,
          chargedAmountUsd: status.chargedAmountUsd ?? current.chargedAmountUsd,
          error: null,
        }))
      },
    })
    if (!isCanvasActionOperationCurrent(operationRef.current, operation) || outcome !== 'timeout') return
    setState((current) => ({
      ...current,
      phase: 'error',
      error: "Preparation took too long. Try again.",
    }))
  }, [transport])

  const prepare = useCallback(async (input: CanvasActionPreparationRequest): Promise<void> => {
    operationRef.current += 1
    const operation = operationRef.current
    pendingRef.current = {
      ...input,
      refs: input.refs.map((ref) => ({ ...ref })),
      idempotencyKey: input.idempotencyKey ?? newId(),
    }
    jobRef.current = null
    setState({ ...IDLE_STATE, phase: 'preparing', progressText: "We send a request to the assistant..." })
    try {
      const frozen = pendingRef.current
      if (!frozen) return
      const started = await transport.prepare(frozen)
      if (operationRef.current !== operation) return
      jobRef.current = started.jobId
      setState({
        phase: 'preparing',
        jobId: started.jobId,
        progressText: "Assistant is preparing text…",
        resultText: null,
        profile: started.profile,
        quote: started.quote,
        chargedAmountUsd: null,
        error: null,
      })
      void poll(started.jobId, operation).catch((error) => {
        if (operationRef.current !== operation) return
        setState((current) => ({
          ...current,
          phase: 'error',
          progressText: null,
          error: errorMessage(error),
        }))
      })
    } catch (error) {
      if (operationRef.current !== operation) return
      if (error instanceof ApiError && error.code === 'PRICE_CONFIRMATION_REQUIRED' && error.quote) {
        pendingRef.current = {
          ...pendingRef.current,
          quoteId: error.quote.id,
          quoteHash: error.quote.requestHash,
        }
        setState({
          ...IDLE_STATE,
          phase: 'quote',
          quote: error.quote,
          error: null,
        })
        return
      }
      setState({ ...IDLE_STATE, phase: 'error', error: errorMessage(error) })
    }
  }, [poll, transport])

  const confirmQuote = useCallback(async (): Promise<void> => {
    const pending = pendingRef.current
    const quote = state.quote
    if (!pending || !quote) return
    await prepare({
      ...pending,
      quoteId: quote.id,
      quoteHash: quote.requestHash,
      quoteConfirmed: true,
    })
  }, [prepare, state.quote])

  const cancel = useCallback(async (): Promise<void> => {
    const jobId = jobRef.current
    const operation = ++operationRef.current
    pendingRef.current = null
    jobRef.current = null
    if (!jobId) {
      setState(IDLE_STATE)
      return
    }
    setState((current) => ({ ...current, phase: 'cancelling', progressText: "Let's stop..." }))
    try {
      await transport.cancel(jobId)
    } finally {
      if (isCanvasActionOperationCurrent(operationRef.current, operation)) {
        setState({ ...IDLE_STATE, phase: 'error', error: "Preparation cancelled." })
      }
    }
  }, [transport])

  useEffect(() => () => {
    operationRef.current += 1
  }, [])

  return { state, prepare, confirmQuote, cancel, reset }
}

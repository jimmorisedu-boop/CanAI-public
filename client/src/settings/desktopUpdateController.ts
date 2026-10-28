import type {
  DesktopUpdatePhase,
  DesktopUpdateStatus,
} from '../../../packages/desktop-updates/protocol'
import {
  desktopUpdateTransport,
  type DesktopUpdateTransport,
} from './desktopUpdateApi'

export interface DesktopUpdateControllerOptions {
  pollIntervalMs?: number
  maxWaitMs?: number
  sleep?(delayMs: number): Promise<void>
}

export interface DesktopUpdateController {
  getSnapshot(): DesktopUpdateStatus | null
  subscribe(listener: () => void): () => void
  load(): Promise<DesktopUpdateStatus>
  check(): Promise<DesktopUpdateStatus>
  prepare(target: string): Promise<DesktopUpdateStatus>
  apply(jobId: string): Promise<DesktopUpdateStatus>
  cancel(): void
}

const DEFAULT_POLL_MS = 1_000
const DEFAULT_MAX_WAIT_MS = 5 * 60_000

function isTerminal(phase: DesktopUpdatePhase): boolean {
  return phase === 'error' || phase === 'unsupported'
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function errorDetail(error: unknown): { message: string; code?: string } {
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; originalMessage?: unknown; code?: unknown }
    const message = typeof candidate.originalMessage === 'string'
      ? candidate.originalMessage
      : typeof candidate.message === 'string' ? candidate.message : 'Could not reach the update service'
    return { message, ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}) }
  }
  return { message: 'Could not reach the update service' }
}

function mayHaveRestarted(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true
  const status = (error as { status?: unknown }).status
  // A lost socket or a gateway response can mean that apply was accepted just
  // before the local server restarted. Client errors (bad target, stale job)
  // are definitive and should be shown immediately.
  return typeof status !== 'number' || status >= 500
}

function unknownStatus(previous: DesktopUpdateStatus | null, phase: DesktopUpdatePhase): DesktopUpdateStatus {
  return {
    phase,
    edition: previous?.edition ?? 'full',
    current: previous?.current ?? { version: 'unknown', commit: null, date: null },
    ...(previous?.latest ? { latest: previous.latest } : {}),
    ...(previous?.jobId ? { jobId: previous.jobId } : {}),
  }
}

/**
 * Small state machine for the Settings updater. It deliberately owns its
 * state outside React: closing Settings must not cancel a long preparation or
 * lose the ready job. The transport is injected in tests and keeps the wire
 * contract at the edge of the app.
 */
export class DesktopUpdateControllerImpl implements DesktopUpdateController {
  private readonly listeners = new Set<() => void>()
  private readonly pollIntervalMs: number
  private readonly maxWaitMs: number
  private readonly sleep: (delayMs: number) => Promise<void>
  private snapshot: DesktopUpdateStatus | null = null
  private operation: Promise<DesktopUpdateStatus> | null = null
  private abortController: AbortController | null = null

  constructor(
    private readonly transport: DesktopUpdateTransport = desktopUpdateTransport,
    options: DesktopUpdateControllerOptions = {},
  ) {
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_MS)
    this.maxWaitMs = Math.max(1, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)))
  }

  getSnapshot(): DesktopUpdateStatus | null {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(status: DesktopUpdateStatus): DesktopUpdateStatus {
    this.snapshot = status
    for (const listener of this.listeners) listener()
    return status
  }

  private begin(): AbortSignal {
    this.abortController?.abort()
    this.abortController = new AbortController()
    return this.abortController.signal
  }

  private finish(promise: Promise<DesktopUpdateStatus>): Promise<DesktopUpdateStatus> {
    this.operation = promise
    void promise.finally(() => {
      if (this.operation === promise) {
        this.operation = null
        this.abortController = null
      }
    }).catch(() => {})
    return promise
  }

  private failed(error: unknown): DesktopUpdateStatus {
    if (isAbort(error)) return this.snapshot ?? unknownStatus(this.snapshot, 'idle')
    const detail = errorDetail(error)
    return this.publish({
      ...unknownStatus(this.snapshot, 'error'),
      message: detail.message,
      ...(detail.code ? { code: detail.code } : {}),
    })
  }

  private async pollUntil(
    signal: AbortSignal,
    done: (status: DesktopUpdateStatus) => boolean,
  ): Promise<DesktopUpdateStatus> {
    const deadline = Date.now() + this.maxWaitMs
    let lastError: unknown
    while (Date.now() <= deadline) {
      if (signal.aborted) throw new DOMException('Update cancelled', 'AbortError')
      try {
        const status = await this.transport.status(signal)
        this.publish(status)
        if (done(status) || isTerminal(status.phase)) return status
      } catch (error) {
        if (isAbort(error)) throw error
        // The updater intentionally survives the short server restart window:
        // apply closes the HTTP listener before it can report completion.
        lastError = error
      }
      await this.sleep(this.pollIntervalMs)
    }
    throw lastError ?? new Error('The update service did not finish in time')
  }

  load(): Promise<DesktopUpdateStatus> {
    if (this.operation) return this.operation
    const signal = this.begin()
    const run = (async () => {
      try {
        const status = this.publish(await this.transport.status(signal))
        if (status.phase === 'preparing') {
          return await this.pollUntil(signal, (next) => next.phase === 'ready')
        }
        if (status.phase === 'restarting' || (status.phase === 'complete' && status.jobId)) {
          return await this.pollUntil(signal, (next) => next.phase === 'complete' || next.current.version !== status.current.version)
        }
        return status
      } catch (error) {
        if (isAbort(error)) throw error
        return this.failed(error)
      }
    })()
    return this.finish(run)
  }

  check(): Promise<DesktopUpdateStatus> {
    if (this.operation) return this.operation
    const signal = this.begin()
    this.publish({ ...unknownStatus(this.snapshot, 'checking'), message: undefined, code: undefined })
    const run = (async () => {
      try {
        return this.publish(await this.transport.check(signal))
      } catch (error) {
        if (isAbort(error)) throw error
        return this.failed(error)
      }
    })()
    return this.finish(run)
  }

  prepare(target: string): Promise<DesktopUpdateStatus> {
    if (this.operation) return this.operation
    const signal = this.begin()
    this.publish({ ...unknownStatus(this.snapshot, 'preparing'), latest: this.snapshot?.latest, message: undefined, code: undefined })
    const run = (async () => {
      try {
        const initial = this.publish(await this.transport.prepare({ target }, signal))
        if (initial.phase === 'ready' || isTerminal(initial.phase)) return initial
        return await this.pollUntil(signal, (next) => next.phase === 'ready')
      } catch (error) {
        if (isAbort(error)) throw error
        return this.failed(error)
      }
    })()
    return this.finish(run)
  }

  apply(jobId: string): Promise<DesktopUpdateStatus> {
    if (this.operation) return this.operation
    const signal = this.begin()
    const previousVersion = this.snapshot?.current.version
    this.publish({ ...unknownStatus(this.snapshot, 'restarting'), jobId, message: undefined, code: undefined })
    const run = (async () => {
      try {
        const initial = this.publish(await this.transport.apply({ jobId }, signal))
        if (isTerminal(initial.phase)) return initial
        if (initial.phase === 'complete' || (previousVersion && initial.current.version !== previousVersion)) return initial
        return await this.pollUntil(signal, (next) => next.phase === 'complete' || (previousVersion != null && next.current.version !== previousVersion))
      } catch (error) {
        if (isAbort(error)) throw error
        if (mayHaveRestarted(error)) {
          try {
            return await this.pollUntil(signal, (next) => next.phase === 'complete' || (previousVersion != null && next.current.version !== previousVersion))
          } catch (pollError) {
            if (isAbort(pollError)) throw pollError
            // Keep the original POST error when the listener never restarted.
          }
        }
        return this.failed(error)
      }
    })()
    return this.finish(run)
  }

  cancel(): void {
    this.abortController?.abort()
  }
}

export const desktopUpdateController = new DesktopUpdateControllerImpl()

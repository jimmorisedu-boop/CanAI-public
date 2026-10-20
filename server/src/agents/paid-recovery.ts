import type { AgentTaskRecord } from './types.js'

const HELD_OPERATION_STATES = new Set(['reserved', 'submitted', 'uncertain', 'cancelled'])

/**
 * A task can be terminal while a paid provider request is still held in the
 * journal.  Recovery must be scheduled after Host startup, never become a
 * reason to spawn the package process, and must stop being retried at a
 * bounded point if the provider remains unavailable.
 */
export function hasHeldPaidOperations(task: AgentTaskRecord): boolean {
  return [...(task.llmOperations ?? []), ...(task.generationOperations ?? [])]
    .some((operation) => HELD_OPERATION_STATES.has(operation.status))
}

export interface AgentPaidRecoveryOptions {
  /** The broker method reconciles only already durable operations. */
  recover(task: AgentTaskRecord): Promise<void>
  /** Small delays keep restart recovery bounded and avoid a startup busy loop. */
  retryDelaysMs?: readonly number[]
}

export class AgentPaidRecovery {
  private readonly retryDelaysMs: readonly number[]
  private readonly active = new Set<string>()
  private readonly timers = new Map<ReturnType<typeof setTimeout>, (continueRun: boolean) => void>()
  private closed = false

  constructor(private readonly options: AgentPaidRecoveryOptions) {
    const delays = options.retryDelaysMs ?? [0, 100, 500, 1_000]
    this.retryDelaysMs = delays.filter((delay) => Number.isFinite(delay) && delay >= 0).map((delay) => Math.floor(delay))
    if (this.retryDelaysMs.length === 0) this.retryDelaysMs = [0]
  }

  /** Fire-and-forget by design: AgentHost.restore must not wait on fal. */
  start(tasks: readonly AgentTaskRecord[]): void {
    if (this.closed) return
    for (const task of tasks) {
      if (!hasHeldPaidOperations(task) || this.active.has(task.taskId)) continue
      this.active.add(task.taskId)
      void this.run(task).finally(() => this.active.delete(task.taskId))
    }
  }

  /** Cancel pending retry timers. In-flight provider calls remain provider-owned. */
  close(): void {
    this.closed = true
    for (const [timer, resolve] of this.timers) {
      clearTimeout(timer)
      this.timers.delete(timer)
      resolve(false)
    }
  }

  private async run(task: AgentTaskRecord): Promise<void> {
    for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt += 1) {
      if (this.closed) return
      if (!(await this.wait(this.retryDelaysMs[attempt]!))) return
      try {
        await this.options.recover(task)
        return
      } catch {
        // A transient resume failure keeps the durable reservation held.  The
        // next bounded attempt reconciles the same ID; it never calls submit.
      }
    }
  }

  private wait(delayMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    return new Promise((resolve) => {
      let timer!: ReturnType<typeof setTimeout>
      timer = setTimeout(() => {
        this.timers.delete(timer)
        resolve(!this.closed)
      }, delayMs)
      timer.unref?.()
      this.timers.set(timer, resolve)
    })
  }
}

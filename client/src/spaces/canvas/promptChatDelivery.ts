import type { Job } from '../../types'
import type { GenerationTarget } from './generationRegistry'

/** Повторяем только чтение уже оплаченного ответа, никогда send/generate. */
export function createPromptChatDelivery(deps: {
  read(job: Job, target: GenerationTarget): Promise<void>
  failed(error: unknown, target: GenerationTarget): boolean | void
  schedule(callback: () => void, delay: number): unknown
  unschedule(timer: unknown): void
}) {
  const pending = new Map<string, { attempts: number; timer?: unknown; target: GenerationTarget }>()
  async function deliver(job: Job, target: GenerationTarget): Promise<void> {
    if (target.kind !== 'prompt-chat' || !['done', 'error'].includes(job.status)) return
    if (pending.has(job.id)) return
    const entry: { attempts: number; timer?: unknown; target: GenerationTarget } = { attempts: 0, target }
    pending.set(job.id, entry)
    const run = async (): Promise<void> => {
      if (pending.get(job.id) !== entry) return
      entry.timer = undefined
      try {
        await deps.read(job, target)
        pending.delete(job.id)
      } catch (error) {
        if (pending.get(job.id) !== entry) return
        if (deps.failed(error, target) === false) { pending.delete(job.id); return }
        entry.timer = deps.schedule(() => { void run() }, Math.min(30_000, 1_000 * 2 ** Math.min(entry.attempts++, 5)))
      }
    }
    await run()
  }
  return {
    deliver,
    cancel(projectId: string, conversationId: string) {
      for (const [id, entry] of pending) {
        if (entry.target.projectId !== projectId || entry.target.kind !== 'prompt-chat'
          || entry.target.conversationId !== conversationId) continue
        if (entry.timer !== undefined) deps.unschedule(entry.timer)
        pending.delete(id)
      }
    },
  }
}

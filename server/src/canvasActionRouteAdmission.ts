import { createHash } from 'node:crypto'
import type { CanvasActionPreparationRequest } from './canvasActionPreparationService.js'
import type { Job } from './jobs.js'
import type { IncomingRef } from './refs.js'

export function sameRefs(left: IncomingRef[], right: IncomingRef[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function refsHash(refs: IncomingRef[]): string {
  return createHash('sha256').update(JSON.stringify(refs)).digest('hex')
}

export function idempotencyConflict(job: Job, input: CanvasActionPreparationRequest): boolean {
  if (job.prompt !== input.prompt) return true
  const target = job.target
  if (target?.kind !== 'canvas-action') return true
  if (target.refsHash ? target.refsHash !== refsHash(input.refs) : !sameRefs(job.refs, input.refs)) return true
  if (input.assistantId !== undefined && (target.assistantId ?? null) !== input.assistantId) return true
  if (input.profileVersionId !== undefined
    && (target.assistantVersionId ?? null) !== input.profileVersionId) return true
  return false
}

export function actionTargetMatches(job: Job, input: CanvasActionPreparationRequest): boolean {
  const target = job.target
  return target?.kind === 'canvas-action'
    && target.projectId === input.projectRef.id
    && target.source === input.projectRef.source
    && target.idempotencyKey === input.idempotencyKey
}

export async function withActionKeyLock(
  locks: Map<string, Promise<void>>,
  key: string,
  work: () => Promise<void>,
): Promise<void> {
  for (;;) {
    const current = locks.get(key)
    if (current) {
      await current
      continue
    }
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    locks.set(key, hold)
    try {
      await work()
      return
    } finally {
      release()
      if (locks.get(key) === hold) locks.delete(key)
    }
  }
}

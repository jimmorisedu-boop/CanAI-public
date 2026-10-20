import type { Job } from './jobs.js'

export const MAX_JOB_WAIT_MS = 20_000
export const MAX_WAITED_JOBS = 100

export function publicLocalJob(job: Job): Record<string, unknown> {
  const { refs: _refs, internal: _internal, canvasActionPrompt: _canvasActionPrompt, ...rest } = job
  const publicJob = rest as Record<string, unknown>
  delete publicJob.falEndpoint
  delete publicJob.falRequestId
  delete publicJob.paidResult
  const target = job.target
  if (target?.kind === 'canvas-action') {
    delete publicJob.target
    delete publicJob.params
    delete publicJob.model
    delete publicJob.accountCloudQuote
    delete publicJob.falEndpoint
    delete publicJob.falRequestId
    delete publicJob.paidResult
    delete publicJob.cloudJobId
  }
  return publicJob
}

export function jobVersion(job: Record<string, unknown>): string {
  const result = job.result && typeof job.result === 'object' ? job.result as Record<string, unknown> : null
  return JSON.stringify([job.status ?? null, job.progressText ?? job.progress ?? null, job.error ?? null, result ? [result.url ?? null, result.text ?? null, result.assetId ?? null] : null])
}

export interface JobWaitEntry {
  id: string
  version: string
  job?: Record<string, unknown>
  missing?: true
}

export interface JobWaitDeps {
  local(id: string): Job | undefined
  allLocal(): Job[]
  now(): number
  sleep(ms: number): Promise<void>
}

export async function waitForJobs(ids: readonly string[], seen: Readonly<Record<string, string>>, waitMs: number, deps: JobWaitDeps, signal?: { readonly aborted: boolean }): Promise<JobWaitEntry[]> {
  const deadline = deps.now() + Math.min(Math.max(0, waitMs), MAX_JOB_WAIT_MS)
  for (;;) {
    const entries = ids.map((id) => {
      const job = deps.local(id)
      return job && !job.internal
        ? { id, version: jobVersion(publicLocalJob(job)), job: publicLocalJob(job) }
        : { id, version: 'missing', missing: true as const }
    })
    if (entries.some((entry) => entry.version !== seen[entry.id]) || deps.now() >= deadline || signal?.aborted) return entries
    await deps.sleep(100)
  }
}

import type { Job } from './jobs.js'

export interface CanvasActionPreparationProfileView {
  id: string | null
  versionId: string | null
  modelId: string
}

export interface CanvasActionPreparationStart {
  jobId: string
  status: Job['status']
  idempotencyKey: string
  profile: CanvasActionPreparationProfileView
}

export interface CanvasActionPreparationStatus extends CanvasActionPreparationStart {
  progressText?: string
  error?: string
  result?: { text: string }
  chargedAmountUsd?: number | null
}

export function profileView(job: Job): CanvasActionPreparationProfileView {
  const target = job.target
  return {
    id: target?.kind === 'canvas-action' ? target.assistantId ?? null : null,
    versionId: target?.kind === 'canvas-action' ? target.assistantVersionId ?? null : null,
    modelId: job.model ?? '',
  }
}


export function startView(job: Job): CanvasActionPreparationStart {
  const target = job.target
  return {
    jobId: job.id,
    status: job.status,
    idempotencyKey: target?.kind === 'canvas-action' ? target.idempotencyKey : '',
    profile: profileView(job),
  }
}

export function statusView(job: Job): CanvasActionPreparationStatus {
  const result = typeof job.result?.text === 'string' && job.result.text.trim()
    ? { text: job.result.text.trim() }
    : undefined
  return {
    ...startView(job),
    ...(job.progressText ? { progressText: job.progressText } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(result ? { result } : {}),
    ...(job.chargedAmountUsd !== undefined ? { chargedAmountUsd: job.chargedAmountUsd } : {}),
  }
}

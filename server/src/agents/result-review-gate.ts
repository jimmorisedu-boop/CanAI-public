import type { AgentArtifactRef } from '../../../packages/agent-protocol/index.js'
import type { AgentTaskRecord } from './types.js'
import { AgentToolError } from './tool-shared.js'

const MEDIA_KINDS = new Set(['image', 'video', 'audio'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function artifactRef(value: unknown): AgentArtifactRef | null {
  const revision = isRecord(value) ? value.revision : undefined
  if (!isRecord(value)
    || typeof value.artifactId !== 'string'
    || typeof revision !== 'number'
    || !Number.isSafeInteger(revision)
    || revision < 1
    || typeof value.checksum !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.checksum)) return null
  return { artifactId: value.artifactId, revision, checksum: value.checksum }
}

function sameRef(left: AgentArtifactRef, right: AgentArtifactRef): boolean {
  return left.artifactId === right.artifactId
    && left.revision === right.revision
    && left.checksum === right.checksum
}

function refsFromArguments(args: Record<string, unknown>): AgentArtifactRef[] | null {
  if (!Array.isArray(args.items)) return null
  const refs: AgentArtifactRef[] = []
  for (const item of args.items) {
    if (!isRecord(item)) return null
    const ref = artifactRef(item.artifact)
    if (!ref) return null
    refs.push(ref)
  }
  return refs
}

function hasSucceededGeneration(task: AgentTaskRecord, ref: AgentArtifactRef): boolean {
  const artifact = task.artifacts.find((candidate) =>
    candidate.artifactId === ref.artifactId
    && candidate.revision === ref.revision
    && candidate.checksum === ref.checksum)
  if (!artifact || artifact.provenance !== 'generated' || !MEDIA_KINDS.has(artifact.kind)) return false
  return (task.generationOperations ?? []).some((operation) => {
    if (operation.status !== 'succeeded' || typeof operation.jobId !== 'string' || !operation.jobId.trim()) return false
    const result = operation.result
    const generated = result && Array.isArray(result.artifacts) ? result.artifacts : []
    return generated.some((candidate) => {
      const generatedRef = artifactRef(candidate)
      return generatedRef !== null && sameRef(generatedRef, ref)
    })
  })
}

function hasSucceededMediaRender(task: AgentTaskRecord, ref: AgentArtifactRef): boolean {
  const operations = task.mediaRenderOperations ?? []
  return operations.some((operation) => {
    if (!sameRef(operation.artifact, ref)) return false
    return (task.receipts ?? []).some((receipt) =>
      receipt.operationId === operation.operationId && receipt.status === 'succeeded'
    )
  })
}

function reviewStatusFor(task: AgentTaskRecord, ref: AgentArtifactRef): AgentTaskRecord['reviews'][number]['status'] | 'missing' {
  const matching = task.reviews.filter((review) => review.materials.some((material) =>
    material.role === 'result'
    && material.artifactId === ref.artifactId
    && material.revision === ref.revision
    && material.checksum === ref.checksum))
  const latest = matching.at(-1)
  if (!latest) return 'missing'
  if (latest.status !== 'approved' || latest.decision?.decision !== 'approved' || latest.decision.revision !== latest.revision) return latest.status
  return 'approved'
}

/**
 * Gate for delivering results to a canvas.
 * - Host generation broker: requires running state, succeeded generation, and approved result review.
 * - Host media.render: requires running state and approved result review (with or without generation budget).
 * - Agent-published artifacts:
 *     - With generation budget: non-media (text/plan/document) allowed; media rejected.
 *     - Without generation budget: allowed.
 * - If any item fails, the entire batch is rejected.
 */
export function requireDeliverableResults(task: AgentTaskRecord, args: Record<string, unknown>): void {
  const refs = refsFromArguments(args)
  if (!refs || refs.length === 0) return

  for (const ref of refs) {
    if (hasSucceededMediaRender(task, ref)) {
      if (task.state !== 'running') {
        throw new AgentToolError('TASK_NOT_RUNNING', 'Result cannot be added outside a running task')
      }
      const reviewStatus = reviewStatusFor(task, ref)
      if (reviewStatus !== 'approved') {
        throw new AgentToolError('GENERATION_RESULT_REVIEW_REQUIRED', 'An approved review with the exact artifactId/revision/checksum is required before delivering a materialized result')
      }
      continue
    }

    if (hasSucceededGeneration(task, ref)) {
      if (task.state !== 'running') {
        throw new AgentToolError('TASK_NOT_RUNNING', 'Generation result cannot be added outside a running task')
      }
      const reviewStatus = reviewStatusFor(task, ref)
      if (reviewStatus !== 'approved') {
        throw new AgentToolError('GENERATION_RESULT_REVIEW_REQUIRED', 'An approved review with the exact artifactId/revision/checksum is required before delivering a generation result')
      }
      continue
    }

    // Neither succeeded Host generation nor succeeded Host media.render.
    if (task.generationBudget) {
      if (task.state !== 'running') {
        throw new AgentToolError('TASK_NOT_RUNNING', 'Result cannot be added outside a running task')
      }
      const artifact = task.artifacts.find((candidate) =>
        candidate.artifactId === ref.artifactId
        && candidate.revision === ref.revision
        && candidate.checksum === ref.checksum)
      if (!artifact || MEDIA_KINDS.has(artifact.kind)) {
        throw new AgentToolError('GENERATION_RESULT_REQUIRED', 'Only an approved succeeded generation artifact may be added to the canvas')
      }
      // Non-media (text/plan/document) in budget task is allowed without review.
      continue
    }

    // In a task without generation budget, published artifacts are allowed without review.
  }
}

export const requireApprovedGenerationResults = requireDeliverableResults

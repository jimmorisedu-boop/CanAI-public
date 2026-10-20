import type { AgentReviewView } from '../../../../../packages/agent-protocol/index'

export interface GenerationReviewReadiness {
  ready: boolean
  reason?: string
}

/**
 * A generation approval is a paid admission. Optional legacy echoes are fine
 * for reading old reviews, but a new approval needs the concrete prompt,
 * params, and estimate that the Host validated against its request hashes.
 * Ordinary/text reviews stay approvable.
 */
export function generationReviewReadiness(review: Pick<AgentReviewView, 'generationSpec' | 'requestedGrant'> | undefined): GenerationReviewReadiness {
  if (!review || (review.requestedGrant?.tool !== 'generation.request' && !review.generationSpec)) return { ready: true }
  const spec = review.generationSpec
  if (!spec) return { ready: false, reason: 'Cannot approve the run: Host has not shown the exact text, parameters, and estimate.' }
  if (typeof spec.prompt !== 'string' || !spec.prompt.trim()) {
    return { ready: false, reason: 'Cannot approve the run: Host has not shown the exact prompt text.' }
  }
  if (!spec.params || typeof spec.params !== 'object' || Array.isArray(spec.params)) {
    return { ready: false, reason: 'Cannot approve the run: Host has not shown the exact parameters.' }
  }
  const estimateMicros = spec.estimateMicros
  if (typeof estimateMicros !== 'number' || !Number.isSafeInteger(estimateMicros) || estimateMicros < 0) {
    return { ready: false, reason: 'Cannot approve the run: Host has not shown the exact estimate.' }
  }
  return { ready: true }
}

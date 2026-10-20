import type {
  AgentArtifact,
  AgentPackageSummary,
  AgentReviewMaterial,
} from '../../../../../packages/agent-protocol/index'

export interface AgentPanelViewportRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface AgentPanelCompactPosition {
  left: number
  top: number
}

const knownTaskLabels: Record<string, string> = {
  'demo-plan': 'Demo plan',
  'demo-storyboard': 'Demo storyboard',
  'canvas.plan': 'Plan for canvas',
}

const knownStageLabels: Record<string, string> = {
  plan: 'Planning',
  publishing: 'Result publication',
  waiting_review: 'Result review',
  review: 'Result review',
  awaiting_review: 'Waiting for a decision',
  awaiting_input: 'Waiting for input',
  awaiting_connection: 'Waiting for connection',
  placing: 'Add to canvas',
  done: 'Completed',
}

export function agentTaskLabel(taskType: string, packages: readonly AgentPackageSummary[]): string {
  const packageLabel = packages
    .flatMap((pkg) => pkg.taskTypes)
    .find((type) => type.id === taskType)?.label
  return packageLabel || knownTaskLabels[taskType] || 'Agent task'
}

export function agentStageLabel(stageId: string): string {
  return knownStageLabels[stageId] || 'Current stage'
}

export function agentStatusLabel(status: string, stateLabel: Record<string, string>): string {
  return stateLabel[status] || 'Updating status'
}

export type ReviewArtifactMatch =
  | { state: 'ready'; artifact: AgentArtifact }
  | { state: 'loading' | 'stale' }

/**
 * Resolve review material by its immutable identity.  A same-named or newer
 * artifact is not a valid substitute: the review must show the exact
 * revision/checksum it asked the person to decide on.
 */
export function reviewArtifactMatch(
  artifacts: readonly AgentArtifact[],
  material: Pick<AgentReviewMaterial, 'artifactId' | 'revision' | 'checksum'>,
): ReviewArtifactMatch {
  const exact = artifacts.find((artifact) => artifact.artifactId === material.artifactId
    && artifact.revision === material.revision
    && artifact.checksum === material.checksum)
  if (exact) return { state: 'ready', artifact: exact }
  return artifacts.some((artifact) => artifact.artifactId === material.artifactId)
    ? { state: 'stale' }
    : { state: 'loading' }
}

/** A text-only Cloud DTO may intentionally omit a downloadable media URL. */
export function artifactMediaHref(artifact: AgentArtifact): string | undefined {
  const value = (artifact as unknown as Record<string, unknown>).mediaSrc
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** Prefer a lightweight preview, but show image results when the server only
 * returned the authenticated media URL (the native Host receipt shape). */
export function artifactPreviewHref(artifact: AgentArtifact): string | undefined {
  const row = artifact as unknown as Record<string, unknown>
  const value = row.previewSrc ?? row.previewUrl ?? row.thumbnailUrl
  if (typeof value === 'string' && value.trim()) return value
  if ((artifact.kind === 'image' || artifact.kind === 'video') && typeof row.mediaSrc === 'string' && row.mediaSrc.trim()) {
    return row.mediaSrc
  }
  return undefined
}

export function reviewArtifact(
  artifacts: readonly AgentArtifact[],
  material: Pick<AgentReviewMaterial, 'artifactId' | 'revision' | 'checksum'>,
): AgentArtifact | undefined {
  const match = reviewArtifactMatch(artifacts, material)
  return match.state === 'ready' ? match.artifact : undefined
}

/** Reserve room above the prompt dock while keeping a small visual breathing gap. */
export function agentPanelBottomReserve(
  canvasBottom: number,
  promptTop: number,
  minimum = 112,
  gap = 16,
): number {
  return Math.max(minimum, Math.ceil(canvasBottom - promptTop + gap))
}

/**
 * Pick a small, local position for the tight-panel toggle. The panel normally
 * lives to the right of the prompt dock; on a narrow board that spot can be
 * occupied by the asset rail. Candidates are checked against the measured
 * viewport rectangles instead of assuming a particular dock/rail width.
 */
export function agentPanelCompactPosition(
  canvas: AgentPanelViewportRect,
  blockers: readonly AgentPanelViewportRect[],
  size = 48,
  gap = 8,
): AgentPanelCompactPosition | null {
  const width = canvas.right - canvas.left
  const height = canvas.bottom - canvas.top
  if (![canvas.left, canvas.right, canvas.top, canvas.bottom, size, gap].every(Number.isFinite)
    || size <= 0 || gap < 0 || width < size || height < size) return null

  const find = (candidateGap: number): AgentPanelCompactPosition | null => {
    const edgeInset = candidateGap < gap
      ? Math.max(8, candidateGap)
      : Math.max(16, candidateGap)
    const edgeCandidates = blockers.flatMap((blocker) => [
      { left: blocker.right + candidateGap, top: canvas.top + edgeInset },
      { left: blocker.left - size - candidateGap, top: canvas.top + edgeInset },
    ])
    const candidates = [
      ...edgeCandidates,
      { left: canvas.right - size - edgeInset, top: canvas.top + edgeInset },
      { left: canvas.left + edgeInset, top: canvas.top + edgeInset },
      { left: canvas.left + edgeInset, top: canvas.top + size + candidateGap * 3 },
      { left: canvas.right - size - edgeInset, top: canvas.top + size + candidateGap * 3 },
      { left: canvas.right - size - edgeInset, top: canvas.bottom - size - edgeInset },
      { left: canvas.left + edgeInset, top: canvas.bottom - size - edgeInset },
      { left: canvas.left + (width - size) / 2, top: canvas.top + edgeInset },
    ]
    const usable = candidates.find((candidate) => {
      const right = candidate.left + size
      const bottom = candidate.top + size
      if (candidate.left < canvas.left || right > canvas.right
        || candidate.top < canvas.top || bottom > canvas.bottom) return false
      return blockers.every((blocker) => {
        if (![blocker.left, blocker.right, blocker.top, blocker.bottom].every(Number.isFinite)) return true
        return candidate.left >= blocker.right + candidateGap
          || right <= blocker.left - candidateGap
          || candidate.top >= blocker.bottom + candidateGap
          || bottom <= blocker.top - candidateGap
      })
    })
    return usable
      ? { left: Math.round(usable.left - canvas.left), top: Math.round(usable.top - canvas.top) }
      : null
  }

  // A very narrow board can leave only a four-pixel corridor between the
  // prompt dock and the corner/asset rail. Keep that measured gap usable
  // before giving up; the toggle still never intersects a blocker.
  const usable = find(gap) ?? (gap > 4 ? find(4) : null)
  if (!usable) return null
  return usable
}

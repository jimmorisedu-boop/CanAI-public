import { groupGenerationTasks } from '../generationLaunches'
import type { GenerationTask } from '../generationRegistry'
import {
  assessSeries,
  type Rect,
  type SeriesAssessment,
  type SeriesEntry,
} from './generationSeriesGeometry'
import type { CanvasCamera } from './types'

type TerminalSeriesState = Extract<GenerationTask['state'], 'done' | 'error' | 'cancelled'>

export interface GenerationSeriesDescriptor {
  launchId: string
  variantCount: number
  jobIds: string[]
  variants: Array<{ jobId: string; state: TerminalSeriesState }>
}

export interface GenerationSeriesEntry extends SeriesEntry {
  jobId?: string
  phase: 'item' | 'pending'
  pendingStatus?: 'loading' | 'error'
}

export type SeriesRevealDecision =
  | { kind: 'wait' }
  | { kind: 'handled' }
  | { kind: 'reveal'; launchId: string; bounds: Rect }
  | { kind: 'cue'; launchId: string; assessment: SeriesAssessment }

const TERMINAL_STATES = new Set<GenerationTask['state']>(['done', 'error', 'cancelled'])

function isTerminalState(state: GenerationTask['state']): state is TerminalSeriesState {
  return TERMINAL_STATES.has(state)
}

export function terminalMultiVariantSeries(
  tasks: GenerationTask[],
  projectId: string,
): GenerationSeriesDescriptor[] {
  return groupGenerationTasks(tasks).flatMap((group) => {
    const launch = group.launch
    const variantIndexes = group.variants.map((variant) => variant.launch?.variantIndex)
    const hasExactVariantIndexes = variantIndexes.every((variantIndex) => (
      Number.isInteger(variantIndex)
      && (variantIndex as number) >= 1
      && (variantIndex as number) <= group.variantCount
    )) && new Set(variantIndexes).size === group.variantCount
    if (!launch
      || launch.projectId !== projectId
      || group.variantCount < 2
      || group.variants.length !== group.variantCount
      || !hasExactVariantIndexes
      || !group.variants.every((variant) => (
        variant.target.kind === 'canvas'
        && variant.target.projectId === projectId
        && variant.launch?.launchId === group.launchId
        && variant.launch.projectId === projectId
        && variant.launch.variantCount === group.variantCount
        && isTerminalState(variant.state)
      ))) {
      return []
    }

    const variants = group.variants.map((variant) => ({
      jobId: variant.jobId,
      state: variant.state as TerminalSeriesState,
    }))
    return [{
      launchId: group.launchId,
      variantCount: group.variantCount,
      jobIds: variants.map((variant) => variant.jobId),
      variants,
    }]
  })
}

function isGenerationSeriesEntry(entry: SeriesEntry): entry is GenerationSeriesEntry {
  const candidate = entry as Partial<GenerationSeriesEntry>
  return (candidate.phase === 'item' || candidate.phase === 'pending')
    && (candidate.jobId === undefined || typeof candidate.jobId === 'string')
    && (candidate.pendingStatus === undefined
      || candidate.pendingStatus === 'loading'
      || candidate.pendingStatus === 'error')
}

function hasValidBounds(entry: SeriesEntry): boolean {
  const { x, y, w, h } = entry.bounds
  return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0
}

function isValidDescriptor(descriptor: GenerationSeriesDescriptor): boolean {
  if (!descriptor.launchId
    || !Number.isInteger(descriptor.variantCount)
    || descriptor.variantCount < 2
    || descriptor.variants.length !== descriptor.variantCount
    || descriptor.jobIds.length !== descriptor.variantCount) return false

  const seen = new Set<string>()
  return descriptor.variants.every((variant, index) => {
    if (!variant.jobId
      || descriptor.jobIds[index] !== variant.jobId
      || seen.has(variant.jobId)
      || !isTerminalState(variant.state)) return false
    seen.add(variant.jobId)
    return true
  })
}

function readySeriesEntries(
  descriptor: GenerationSeriesDescriptor,
  entries: SeriesEntry[],
): GenerationSeriesEntry[] | null {
  const candidates = entries.filter(isGenerationSeriesEntry)
  const selected: GenerationSeriesEntry[] = []

  for (const variant of descriptor.variants) {
    const matching = candidates.filter((entry) => entry.jobId === variant.jobId)
    if (variant.state === 'done') {
      const item = matching.find((entry) => entry.phase === 'item')
      if (!item) return null
      selected.push(item)
      continue
    }
    selected.push(...matching.filter((entry) => (
      entry.phase === 'pending' && entry.pendingStatus === 'error'
    )))
  }

  if (selected.length === 0 || selected.some((entry) => !hasValidBounds(entry))) return null
  return [...new Map(selected.map((entry) => [entry.id, entry])).values()]
}

export function decideSeriesReveal(input: {
  descriptor: GenerationSeriesDescriptor
  entries: SeriesEntry[]
  handled: boolean
  manuallySuppressed: boolean
  camera: CanvasCamera
  viewport: Rect
}): SeriesRevealDecision {
  if (input.handled) return { kind: 'handled' }
  if (!isValidDescriptor(input.descriptor)) return { kind: 'wait' }

  const entries = readySeriesEntries(input.descriptor, input.entries)
  if (!entries) return { kind: 'wait' }
  const assessment = assessSeries(entries, input.camera, input.viewport)
  if (!assessment) return { kind: 'wait' }
  if (assessment.hiddenIds.length === 0) return { kind: 'handled' }
  if (assessment.meaningfulVisibleIds.length > 0 || input.manuallySuppressed) {
    return { kind: 'cue', launchId: input.descriptor.launchId, assessment }
  }
  return {
    kind: 'reveal',
    launchId: input.descriptor.launchId,
    bounds: assessment.bounds,
  }
}

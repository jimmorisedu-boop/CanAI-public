import type { CatalogModel } from '../../types'
import { actionBatchPromptAmbiguity, type ActionBatchMode } from './actionDockBatch'
import type { ActionDockBatchPlanningResult } from './actionDockBatchPlanning'
import { estimateGenerationCost } from './generationEstimate'
import type { SelectionRef } from './konva/selection'

export interface DockHelperEligibilityInput {
  kind: 'image' | 'video' | 'audio'
  assistantId: string | null | undefined
  /** When false, assistant selection is not loaded or unknown. */
  assistantKnown?: boolean
  /** Standalone Cloud tablet requires 1..16 image refs due to team server constraint. */
  isStandaloneCloudTablet?: boolean
  imageRefsCount: number
  /** Transport or runtime capability for canvas action preparation. */
  hasPreparationCapability?: boolean
}

export interface DockHelperEligibilityResult {
  eligible: boolean
  reason:
    | 'eligible'
    | 'universal'
    | 'audio-unsupported'
    | 'images-required-cloud-tablet'
    | 'capability-unavailable'
    | 'assistant-unknown'
}

/**
 * Determine whether the selected assistant participates in «Сделать».
 * «Универсальный» or no assistant = direct launch path.
 * Kind audio is never rewritten.
 * Image references are optional (0..16) except on standalone Cloud tablet (1..16).
 */
export function dockHelperEligibility(
  input: DockHelperEligibilityInput,
): DockHelperEligibilityResult {
  if (input.assistantKnown === false) {
    return { eligible: false, reason: 'assistant-unknown' }
  }
  if (!input.assistantId) {
    return { eligible: false, reason: 'universal' }
  }
  if (input.kind === 'audio') {
    return { eligible: false, reason: 'audio-unsupported' }
  }
  if (input.hasPreparationCapability === false) {
    return { eligible: false, reason: 'capability-unavailable' }
  }
  if (input.isStandaloneCloudTablet && input.imageRefsCount < 1) {
    return { eligible: false, reason: 'images-required-cloud-tablet' }
  }
  return { eligible: true, reason: 'eligible' }
}

/**
 * Single-line hint text for the persona bar above references.
 */
export function dockHelperHint(
  mode: 'make' | 'discuss' | 'agents',
  eligibility: DockHelperEligibilityResult,
  estimateUsd: number = 0.01,
): string {
  if (mode === 'discuss') {
    return "Text only · no actions"
  }
  if (mode === 'agents') {
    return ''
  }
  if (eligibility.eligible) {
    return `Assistant · ≈ $${estimateUsd.toFixed(2)}`
  }
  if (eligibility.reason === 'images-required-cloud-tablet') {
    return "Without an assistant: you need reference pictures"
  }
  if (eligibility.reason === 'audio-unsupported') {
    return "Without an assistant: only pictures and videos"
  }
  return "Creates a result after running"
}

/**
 * Fold prompt text and text references into a single prompt for the helper.
 */
export function helperInstruction(
  prompt: string,
  textRefs: readonly { text?: string }[],
): string {
  const typed = prompt.trim()
  const texts = textRefs
    .map((ref) => ref.text?.trim() ?? '')
    .filter(Boolean)
  if (texts.length === 0) return typed
  if (!typed) return texts.join('\n\n')
  return `${typed}\n\n${texts.join('\n\n')}`
}

/**
 * Sample image references sent to the helper LLM.
 * In «Изменить каждое» (each) send the first 4 image sources as a sample.
 * In «Как референсы» (together) send all image references (up to 16).
 * Non-image references (video/audio) are filtered out.
 */
export function helperSampleRefs(
  refs: readonly SelectionRef[],
  mode: ActionBatchMode,
): SelectionRef[] {
  const images = refs.filter((ref) => ref.kind === 'image')
  if (mode === 'each') {
    return images.slice(0, 4)
  }
  return images.slice(0, 16)
}

/**
 * Flat estimate for text model helper from catalog. Always positive, default $0.01.
 */
export function helperEstimateUsd(
  modelOrModels: CatalogModel | readonly CatalogModel[] | null | undefined,
  modelId?: string | null,
): number {
  if (Array.isArray(modelOrModels)) {
    const candidate = modelId
      ? modelOrModels.find((m) => m.id === modelId)
      : modelOrModels.find((m) => m.kind === 'text')
    return helperEstimateUsd(candidate)
  }
  const model = modelOrModels as CatalogModel | null | undefined
  if (!model) return 0.01
  const cost = estimateGenerationCost(model, {}, 1)
  if (cost !== null && cost > 0) return cost
  return 0.01
}

/**
 * Validate prompt returned by the helper LLM before launching generation.
 */
export function preparedPromptProblem(
  preparedText: string,
  mode: ActionBatchMode,
  originalImageCount: number,
): string | null {
  const text = preparedText.trim()
  if (!text) {
    return "Assistant returned an empty request"
  }
  if (mode === 'each') {
    const ambiguity = actionBatchPromptAmbiguity(text, originalImageCount)
    if (ambiguity) return ambiguity
  } else {
    // In «together» mode, check that any @n tag is in valid range 1..originalImageCount
    const matches = text.match(/@(\d+)\b/gu) ?? []
    for (const match of matches) {
      const num = parseInt(match.slice(1), 10)
      if (num < 1 || num > originalImageCount) {
        return `The assistant referred to a non-existent reference @${num}`
      }
    }
  }
  return null
}

/**
 * Apply the prepared prompt to all requests in the batch plan.
 * Text references are removed from refsToSend because they were folded into helper instruction.
 * Model, parameters, aspect, anchors, job count, and price are preserved.
 */
export function applyPreparedPrompt(
  batch: ActionDockBatchPlanningResult,
  preparedPrompt: string,
): ActionDockBatchPlanningResult {
  const cleanText = preparedPrompt.trim()
  const updatedRequests = batch.requests.map((req) => ({
    ...req,
    plan: {
      ...req.plan,
      text: cleanText,
      // Remove text refs: they have already been merged into the prompt text
      refsToSend: req.plan.refsToSend.filter((ref) => ref.kind !== 'text'),
    },
    refs: req.refs.filter((ref) => ref.kind !== 'text'),
  }))

  return {
    ...batch,
    requests: updatedRequests,
  }
}

/**
 * Local confirmation dialog parameters when helper + generation total exceeds confirmation threshold.
 */
export function helperLaunchConfirmation(
  modelName: string,
  helperName: string,
  helperEstimateUsdValue: number,
  generationEstimateUsdValue: number,
  taskCount: number,
): { title: string; rows: Array<[string, string]>; confirmLabel: string } {
  const total = generationEstimateUsdValue + helperEstimateUsdValue
  const formattedTotal = `$${total.toFixed(2)}`
  return {
    title: `Run for ${formattedTotal}?`,
    rows: [
      ["Model", modelName],
      ["Tasks", `${taskCount}`],
      ["Assistant", `«${helperName}» · ≈ $${helperEstimateUsdValue.toFixed(2)}`],
    ],
    confirmLabel: `Run for ${formattedTotal}`,
  }
}

import type { CatalogModel } from '../../types'
import { estimateGenerationCost, largestImage, type CostInputs } from './generationEstimate'
import {
  logicalBatchRefs,
  missingBatchSource,
  planActionBatch,
  type ActionBatchGroup,
  type ActionBatchMode,
  type ActionBatchPlan,
} from './actionDockBatch'
import { planGeneration, type LaunchPlan } from './promptLaunchPlan'
import type { SelectionRef } from './konva/selection'
import type { CanvasItem } from './konva/types'

/** Что подбор модели ответил на набор одного запроса. */
export interface DockModelSelection {
  /** Модель для котировки и запуска. */
  model: CatalogModel | null
  /** Её базовая модель из списка — она идёт на карточку. */
  baseModel?: CatalogModel | null
  /** Отказ словами: такой набор эта модель не берёт. */
  error: string | null
}

export interface ActionDockBatchPlanningInput {
  kind: 'image' | 'video' | 'audio'
  mode: ActionBatchMode
  refs: SelectionRef[]
  prompt: string
  count: number
  params: Record<string, unknown>
  sketchTarget: string | null
  itemById(id: string): CanvasItem | undefined
  /**
   * Модель для ОДНОГО запроса — по тем референсам, которые он отправит.
   * Вызывается ровно один раз на запрос: что вернула, то и показано, оценено
   * и запущено.
   */
  selectModel(refs: readonly SelectionRef[]): DockModelSelection
}

export interface ActionDockRequestPlan {
  group: ActionBatchGroup
  plan: LaunchPlan
  /** Stable copy used by the eventual request and retry descriptor. */
  refs: SelectionRef[]
  /** Базовая модель из списка: её номер хранит карточка и получает док обратно. */
  baseModel: CatalogModel | null
  /** Оценка этого запроса; из таких же оценок складывается сумма на кнопке. */
  estimatedCost: number | null
}

export interface ActionDockBatchPlanningResult {
  admission: ActionBatchPlan
  requests: ActionDockRequestPlan[]
  jobs: number
  totalCost: number | null
}

function mediaCount(refs: readonly SelectionRef[]): number {
  return refs.filter((ref) => ref.kind !== 'text').length
}

/**
 * Длина текста и размер картинки, от которых зависит цена части моделей
 * (озвучка — за знаки, апскейл — за мегапиксели результата). Текст склеивается
 * так же, как на сервере (`withTextSuffix`): промпт и тексты-референсы через пробел.
 */
function costInputs(prompt: string, refs: readonly SelectionRef[]): CostInputs {
  const texts = [prompt, ...refs.filter((ref) => ref.kind === 'text').map((ref) => ref.text ?? '')]
    .map((text) => text.trim().length)
    .filter((length) => length > 0)
  const inputImage = largestImage(refs)
  return {
    promptChars: texts.reduce((sum, length) => sum + length, 0) + Math.max(0, texts.length - 1),
    ...(inputImage ? { inputImage } : {}),
  }
}

function refused(admission: ActionBatchPlan, error: string): ActionDockBatchPlanningResult {
  return {
    admission: { ...admission, groups: [], jobs: 0, error },
    requests: [],
    jobs: 0,
    totalCost: null,
  }
}

/**
 * Freeze the source list before any upload/frame extraction and derive a plan
 * for every batch group. Running `planGeneration` per group is what keeps
 * each source's Auto aspect and anchor local instead of borrowing the first
 * selected image's geometry.
 */
export function planActionDockBatch(input: ActionDockBatchPlanningInput): ActionDockBatchPlanningResult {
  const frozenRefs = input.refs.map((ref) => ({ ...ref }))
  const admission = planActionBatch({
    kind: input.kind,
    mode: input.mode,
    refs: frozenRefs,
    prompt: input.prompt,
    count: input.count,
  })
  if (admission.error) return { admission, requests: [], jobs: 0, totalCost: null }

  // Модель выбирается по логическому набору запроса: две карточки с одной
  // картинкой уходят одним референсом, значит и считаются одним.
  const selections = admission.groups.map((group) => ({
    group,
    refs: group.refs.map((ref) => ({ ...ref })),
    selection: input.selectModel(logicalBatchRefs(group.refs)),
  }))
  const refusal = selections
    .map(({ refs, selection }) => missingBatchSource(refs) ?? selection.error)
    .find((message): message is string => Boolean(message))
  if (refusal) return refused(admission, refusal)

  // `planActionBatch` owns the user-facing 1–4 clamp. Reuse its normalized
  // quantity here so a caller cannot make the receipt say six jobs while a
  // per-group LaunchPlan still carries the raw out-of-range count.
  const variantCount = input.kind === 'image'
    ? Math.max(1, Math.round(admission.jobs / admission.groups.length))
    : 1
  const requests = selections.map(({ group, refs, selection }): ActionDockRequestPlan => {
    const plan = planGeneration({
      kind: input.kind,
      params: input.params,
      count: variantCount,
      refs,
      sketchTarget: input.sketchTarget,
      typedPrompt: input.prompt,
      itemById: input.itemById,
      resolveModel: () => selection.model,
      allowAutoWithoutRefs: true,
    })
    if (input.mode === 'together') {
      // Keep selected shape identity for anchors/chips, but send one logical
      // media source when a combined request contains the same URL twice.
      plan.refsToSend = logicalBatchRefs(plan.refsToSend).map((ref) => ({ ...ref }))
    }
    const estimatedCost = estimateGenerationCost(
      plan.model,
      plan.params,
      plan.jobs,
      // Скетч уходит одной склейкой, сколько бы объектов ни было выделено.
      input.sketchTarget ? 1 : mediaCount(plan.refsToSend),
      costInputs(plan.text, plan.refsToSend),
    )
    return { group, plan, refs, baseModel: selection.baseModel ?? null, estimatedCost }
  })
  const jobs = requests.reduce((sum, request) => sum + request.plan.jobs, 0)
  const costs = requests.map((request) => request.estimatedCost)
  const totalCost = costs.every((value): value is number => value != null)
    ? costs.reduce((sum, value) => sum + value, 0)
    : null
  return { admission, requests, jobs, totalCost }
}

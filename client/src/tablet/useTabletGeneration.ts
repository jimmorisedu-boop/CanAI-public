import { useCallback, useState } from 'react'
import { handleSettledCanvasGeneration } from '../spaces/canvas/canvasGenerationSettle'
import { createGenerationLaunch, launchGenerationVariants } from '../spaces/canvas/generationLaunches'
import { trackFailedGeneration, type GenerationRetryDescriptor } from '../spaces/canvas/generationRegistry'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { SelectionRef } from '../spaces/canvas/konva/selection'
import { toGenRefs } from '../spaces/canvas/konva/selection'
import { exportImageWithSketch } from '../spaces/canvas/konva/sketchExport'
import {
  planActionDockBatch,
  type ActionDockBatchPlanningInput,
  type ActionDockBatchPlanningResult,
} from '../spaces/canvas/actionDockBatchPlanning'
import type { ActionBatchMode } from '../spaces/canvas/actionDockBatch'
import { dockAttemptConsentInput, dockLaunchMode } from '../spaces/canvas/actionDockLaunch'
import { useGeneration, type GenerationPreparation } from '../spaces/canvas/useGeneration'
import type { ProjectSource } from '../types'

// Запуск генерации с планшета.
//
// Логику НЕ переписываем: planGeneration решает, что уйдёт на сервер (правила
// про текст-референс, «Авто» у пропорций и пропорции заглушки уже стоили
// денег и разбирательств), launchGenerationVariants ставит параллельные
// задачи, а доставка результата — общая с компьютером. Планшетное здесь
// только одно: интерфейс.

export interface TabletLaunchInput {
  kind: 'image' | 'video' | 'audio'
  prompt: string
  refs: SelectionRef[]
  count: number
  params: Record<string, unknown>
  /**
   * Подбор модели под референсы одного запроса. Тот же, по которому построен
   * предпросмотр: показанная модель и есть запускаемая.
   */
  selectModel: ActionDockBatchPlanningInput['selectModel']
  /** Desktop-equivalent source admission; omitted callers keep one combined request. */
  batchMode?: ActionBatchMode
  /** Local must receive an explicit, scope-bound media-transfer consent. */
  mediaTransferConsent?: boolean
  /**
   * Картинка, поверх которой рисуют. Уходит референсом ВМЕСТО выделения — и
   * уходит СКЛЕЙКОЙ (картинка + штрихи), иначе модель получила бы чистый
   * исходник, а человек ждал бы результат по наброску.
   */
  sketchTarget?: string | null
  /**
   * Optional pre-launch transformation (e.g. assistant prompt preparation).
   * Returns the prepared batch, or null/false to abort launch.
   */
  beforeLaunch?: (batch: ActionDockBatchPlanningResult) => Promise<ActionDockBatchPlanningResult | null | false>
}

export interface TabletBatchPlanningInput {
  kind: 'image' | 'video' | 'audio'
  prompt: string
  refs: SelectionRef[]
  count: number
  params: Record<string, unknown>
  selectModel: ActionDockBatchPlanningInput['selectModel']
  batchMode?: ActionBatchMode
  sketchTarget?: string | null
  itemById(id: string): ReturnType<ActionDockBatchPlanningInput['itemById']>
}

function tabletLaunchMode(input: Pick<TabletBatchPlanningInput, 'batchMode' | 'sketchTarget'>): ActionBatchMode {
  return dockLaunchMode({ batchMode: input.batchMode ?? 'together', sketchTarget: input.sketchTarget ?? null })
}

/**
 * Pure tablet launch admission. Keeping this outside the React hook makes
 * preview and the real launch share the same frozen resolver and group plan.
 */
export function planTabletGenerationLaunch(input: TabletBatchPlanningInput): ActionDockBatchPlanningResult {
  return planActionDockBatch({
    kind: input.kind,
    mode: tabletLaunchMode(input),
    params: input.params,
    count: input.count,
    refs: input.refs.map((ref) => ({ ...ref })),
    sketchTarget: input.sketchTarget ?? null,
    prompt: input.prompt,
    itemById: input.itemById,
    selectModel: input.selectModel,
  })
}

/**
 * ⚠️ Вид доски ОБЯЗАТЕЛЕН, и умолчание тут коварно: у сетевой доски задачу
 * заводит сервер команды, и адрес заглушки должен быть помечен `local`.
 * Планшет звал useGeneration без него, тот подставлял `local` — мост отвечал
 * «Выберите командный проект», и НИ ОДНА генерация с планшета на сетевой
 * доске не запускалась (жалоба 08.09.2026 со снимком экрана).
 */
export function useTabletGeneration(
  store: CanvasStore,
  projectId: string,
  ready: boolean,
  projectSource: ProjectSource = 'local',
) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { start, prepare, approvePreparedGenerationQuotes } = useGeneration(projectId, ready, (job, context) => {
    handleSettledCanvasGeneration(job, store, setError, context)
  }, projectSource)

  const launch = useCallback(async (input: TabletLaunchInput): Promise<boolean> => {
    const frozenParams = structuredClone(input.params)
    const batch = planTabletGenerationLaunch({
      kind: input.kind,
      batchMode: input.batchMode,
      params: frozenParams,
      count: input.count,
      refs: input.refs.map((ref) => ({ ...ref })),
      sketchTarget: input.sketchTarget ?? null,
      prompt: input.prompt,
      itemById: (id) => store.getItem(id),
      selectModel: input.selectModel,
    })
    if (batch.admission.error) {
      setError(batch.admission.error)
      return false
    }
    if (batch.requests.length === 0 || batch.requests.some((request) => !request.plan.text)) {
      setError('Nothing to run: enter a prompt or select text on the board.')
      return false
    }
    setError(null)
    setBusy(true)

    let effectiveBatch = batch
    if (input.beforeLaunch) {
      try {
        const prepared = await input.beforeLaunch(batch)
        if (!prepared) {
          setBusy(false)
          return false
        }
        effectiveBatch = prepared
      } catch (err) {
        setBusy(false)
        setError(err instanceof Error ? err.message : 'Could not prepare the assistant request')
        return false
      }
    }

    type PendingBatch = {
      request: (typeof effectiveBatch.requests)[number]
      launch: ReturnType<typeof createGenerationLaunch>
      slots: string[]
      genRefs?: Awaited<ReturnType<typeof toGenRefs>>
      retry?: GenerationRetryDescriptor
    }
    const pendingBatches: PendingBatch[] = []
    try {
      // Commit every row before the first media conversion or local request.
      for (const request of effectiveBatch.requests) {
        const plan = request.plan
        const jobs = plan.jobs
        const meta = createGenerationLaunch({
          variantCount: jobs,
          projectId,
          promptPreview: plan.text.slice(0, 120),
          modelId: plan.model?.id,
          modelName: plan.model?.name ?? 'Generation',
          estimatedTotalCostUsd: request.estimatedCost ?? undefined,
          createdAt: Date.now(),
        })
        const slots = store.addPendingRow(jobs, {
          kind: input.kind,
          label: plan.model?.name ?? 'Generation',
          anchorIds: plan.anchorIds.length > 0 ? plan.anchorIds : undefined,
          aspect: plan.aspect,
          prompt: plan.text,
          // На карточке — модель из списка (её можно вернуть в док); в запрос,
          // котировку и описание повтора ниже идёт сама запускаемая модель.
          modelId: (request.baseModel ?? plan.model)?.id ?? undefined,
          referenceIds: request.refs.map((ref) => ref.shapeId),
          usedReferences: false,
          launch: meta,
        })
        pendingBatches.push({ request, launch: meta, slots })
      }
      await Promise.all(pendingBatches.map(async (entry) => {
        const plan = entry.request.plan
        const genRefs = input.sketchTarget
          ? [{
              kind: 'image' as const,
              src: await exportImageWithSketch(
                store,
                input.sketchTarget!,
                store.getItem(input.sketchTarget!)?.src ?? '',
              ),
            }]
          : await toGenRefs(plan.refsToSend, input.kind)
        entry.genRefs = genRefs
        const params = Object.keys(plan.params).length ? plan.params : undefined
        const retry: GenerationRetryDescriptor = {
          kind: input.kind,
          prompt: plan.text,
          refs: structuredClone(genRefs),
          model: plan.model?.id ?? undefined,
          params: params ? structuredClone(params) : undefined,
          projectRef: { source: projectSource, id: projectId },
        }
        entry.retry = retry
        for (const slotId of entry.slots) store.updatePending(slotId, {
          usedReferences: genRefs.length > 0,
          retry,
        }, { system: true })
      }))
      const results = await Promise.all(pendingBatches.map(async (entry) => {
        const plan = entry.request.plan
        const genRefs = entry.genRefs ?? []
        const params = Object.keys(plan.params).length ? plan.params : undefined
        const retry = entry.retry!
        return launchGenerationVariants({
          slots: entry.slots,
          launch: entry.launch,
          ...(false ? {
            prepare: (variant, slotId) => prepare(
              input.kind,
              plan.text,
              genRefs,
              plan.model?.id ?? undefined,
              params,
              slotId,
              dockAttemptConsentInput({
                projectRef: { source: projectSource, id: projectId },
                kind: input.kind,
                mode: tabletLaunchMode(input),
                request: entry.request,
                genRefs,
                mediaTransferConsent: true,
              }),
            ),
            approve: approvePreparedGenerationQuotes,
          } : {}),
          start: (variant, slotId, prepared) => start(
            input.kind,
            plan.text,
            genRefs,
            plan.model?.id ?? undefined,
            params,
            variant,
            slotId,
            prepared as GenerationPreparation | undefined,
          ),
          recordFailure: (variant, message) => trackFailedGeneration(
            { kind: 'canvas', projectId },
            input.kind,
            retry,
            variant,
            message,
          ),
          bindJob: (slotId, jobId) => store.setPendingJob(slotId, jobId),
          failSlot: (slotId, message) => store.failPendingById(slotId, message),
          failLaunch: (slotId, jobId, error) => store.updatePending(slotId, { jobId, status: 'error', error }, { system: true }),
          fallbackError: 'Could not start generation',
        })
      }))
      const jobs = batch.jobs
      const failedCount = results.reduce((sum, result) => sum + result.failedCount, 0)
      if (failedCount > 0) setError(`Tasks not started: ${failedCount}  of ${jobs}`)
      return failedCount < jobs
    } catch (err) {
      for (const entry of pendingBatches) {
        if (!entry.genRefs) for (const slotId of entry.slots) {
          store.failPendingById(slotId, err instanceof Error ? err.message : 'Could not prepare generation')
        }
      }
      setError(err instanceof Error ? err.message : 'Could not start generation')
      return false
    } finally {
      setBusy(false)
    }
  }, [projectId, start, store])

  return { launch, error, setError, busy }
}

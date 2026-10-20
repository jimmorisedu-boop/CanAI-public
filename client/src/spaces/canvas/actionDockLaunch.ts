import type { CatalogDefaults, CatalogModel, GenRef, JobKind, ProjectSource } from '../../types'
import { leadBatchRefs, type ActionBatchMode } from './actionDockBatch'
import {
  planActionDockBatch,
  type ActionDockBatchPlanningResult,
  type ActionDockRequestPlan,
} from './actionDockBatchPlanning'
import {
  freezeGenerationConsentRefs,
  usdToMicros,
  type GenerationConsentInput,
} from './agents/agentGenerationConsentModel'
import type { SelectionRef } from './konva/selection'
import type { CanvasItem } from './konva/types'
import {
  selectSmartModel,
  smartRefsFor,
  type SmartModelRef,
  type SmartModelSelectionResult,
} from './smartModelSelection'

// Что запустит док. Одна чистая функция на предпросмотр и на запуск, на
// компьютер и планшет: ряд настроек, цена на кнопке, согласие на передачу и сам
// платный запрос обязаны говорить об одном и том же плане. Пока каждый считал
// своё, скетч показывал две задачи, а запускал одну, и согласие, данное по
// предпросмотру, не совпадало с тем, что проверял запуск.

type DockKind = 'image' | 'video' | 'audio'

export interface DockLaunchState {
  projectRef: { source: ProjectSource; id: string }
  kind: DockKind
  models: readonly CatalogModel[]
  defaults?: CatalogDefaults
  /** Выбор в списке: номер базовой модели либо «Авто». */
  modelId: string | null
  batchMode: ActionBatchMode
  refs: readonly SelectionRef[]
  prompt: string
  count: number
  params: Record<string, unknown>
  /** Картинка, поверх которой рисуют: уходит одной склейкой вместо выделения. */
  sketchTarget: string | null
  itemById(id: string): CanvasItem | undefined
  /** Помощник, если он участвует в подготовке текста перед генерацией. */
  textPreparation?: { assistantId: string; versionId?: string | null }
}

export interface DockLaunchPlan {
  /** Режим, в котором запуск пойдёт на самом деле. */
  mode: ActionBatchMode
  batch: ActionDockBatchPlanningResult
  /** Подбор модели для первого запроса: его показывает ряд настроек. */
  selection: SmartModelSelectionResult
}

type DockModelChoice = Pick<DockLaunchState, 'models' | 'defaults' | 'kind' | 'modelId' | 'sketchTarget'>

/** Скетч — всегда один запрос: уходит одна склейка, делить нечего. */
export function dockLaunchMode(state: Pick<DockLaunchState, 'batchMode' | 'sketchTarget'>): ActionBatchMode {
  return state.sketchTarget ? 'together' : state.batchMode
}

/** Подбор модели под референсы одного запроса — тот же для показа и запуска. */
export function dockModelSelector(
  choice: DockModelChoice,
): (refs: readonly SelectionRef[]) => SmartModelSelectionResult {
  return (refs) => selectSmartModel({
    models: choice.models,
    defaults: choice.defaults,
    kind: choice.kind,
    modelId: choice.modelId,
    refs: smartRefsFor(choice.kind, refs, choice.sketchTarget),
  })
}

/**
 * Что подбор увидит в ПЕРВОМ запросе при таком типе генерации. По этому же
 * набору хук выбора модели сверяет и запоминает параметры: иначе в «Изменить
 * каждое» ручки настраивались бы под модель всего набора, а запускалась бы
 * модель одного исходника.
 */
export function dockLeadRefs(
  state: Pick<DockLaunchState, 'batchMode' | 'refs' | 'sketchTarget'>,
  kind: JobKind,
): SmartModelRef[] {
  const batchKind: DockKind = kind === 'video' || kind === 'audio' ? kind : 'image'
  return smartRefsFor(
    kind,
    leadBatchRefs(batchKind, dockLaunchMode(state), state.refs),
    state.sketchTarget,
  )
}

export function planDockLaunch(state: DockLaunchState): DockLaunchPlan {
  const mode = dockLaunchMode(state)
  const selectModel = dockModelSelector(state)
  return {
    mode,
    batch: planActionDockBatch({
      kind: state.kind,
      mode,
      refs: state.refs.map((ref) => ({ ...ref })),
      prompt: state.prompt,
      count: state.count,
      params: state.params,
      sketchTarget: state.sketchTarget,
      itemById: state.itemById,
      selectModel,
    }),
    selection: selectModel(leadBatchRefs(state.kind, mode, state.refs)),
  }
}

/**
 * Область согласия на платный запуск — ровно то, что человек видел.
 *
 * ⚠️ Собирается ЗДЕСЬ и для галочки под полем, и для проверки в момент
 * запуска. Две копии уже расходились: предпросмотр не считал скетч передачей
 * материалов, запуск считал — и требовал согласия, которое негде было дать.
 */
export function dockConsentInput(state: DockLaunchState, plan: DockLaunchPlan): GenerationConsentInput {
  const first = plan.batch.requests[0]?.plan
  const model = first?.model ?? plan.selection.model
  return {
    projectRef: state.projectRef,
    kind: state.kind,
    modelId: model?.id ?? null,
    catalogRevision: model?.contractRevision ?? null,
    prompt: state.prompt,
    orderedRefs: freezeGenerationConsentRefs(state.refs),
    params: structuredClone(first?.params ?? state.params),
    mode: plan.mode,
    attempts: Math.max(1, plan.batch.jobs),
    maxCalls: 1,
    mediaTransferRequired: state.projectRef.source === 'cloud'
      && (state.refs.some((ref) => ref.kind !== 'text') || Boolean(state.sketchTarget)),
    mediaTransferConsent: false,
    estimatedCostMicros: usdToMicros(plan.batch.totalCost),
    textPreparation: state.textPreparation,
  }
}

/** Согласие одной попытки — то, что уходит серверу команды вместе с котировкой. */
export function dockAttemptConsentInput(input: {
  projectRef: DockLaunchState['projectRef']
  kind: DockKind
  mode: ActionBatchMode
  request: ActionDockRequestPlan
  /** Что реально уходит референсами: кадры и склейка уже готовы. */
  genRefs: readonly GenRef[]
  mediaTransferConsent: boolean
}): GenerationConsentInput {
  const { plan, estimatedCost } = input.request
  return {
    projectRef: input.projectRef,
    kind: input.kind,
    modelId: plan.model?.id ?? null,
    catalogRevision: plan.model?.contractRevision ?? null,
    prompt: plan.text,
    orderedRefs: freezeGenerationConsentRefs(input.genRefs),
    params: structuredClone(plan.params),
    mode: input.mode,
    attempts: 1,
    maxCalls: 1,
    mediaTransferRequired: input.genRefs.some((ref) => ref.kind !== 'text'),
    mediaTransferConsent: input.mediaTransferConsent,
    estimatedCostMicros: usdToMicros(estimatedCost),
  }
}

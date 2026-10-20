import { planDockLaunch, type DockLaunchPlan, type DockLaunchState } from './actionDockLaunch'
import { resolveModelForAssistantGeneration } from './boardMemory'
import { isAutoModelId, selectSmartModel, smartRefsFor } from './smartModelSelection'
import type { CanvasItem } from './konva/types'

/**
 * Assistant answers are a batch even though each prompt becomes one server
 * job.  Keep the same all-or-nothing cost estimate used by the dock: an
 * unknown request price must not be presented as a precise aggregate.
 */
export function assistantAggregateEstimatedCost(
  launches: readonly { batch: { totalCost: number | null } }[],
): number | null {
  const costs = launches.map((launch) => launch.batch.totalCost)
  if (!costs.every((cost) => typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)) return null
  const total = (costs as number[]).reduce((sum, cost) => sum + cost, 0)
  return Math.round(total * 1_000_000) / 1_000_000
}

/** The assistant uses the same reference and model contract as the prompt dock. */
export function planAssistantCanvasLaunch(
  state: Omit<DockLaunchState, 'kind'> & {
    kind: 'image' | 'video'
    items: readonly CanvasItem[]
    /** Explicitly frozen per-request preference; omitted keeps legacy ON behavior. */
    boardMemoryEnabled?: boolean
  },
): DockLaunchPlan {
  const autoSelection = isAutoModelId(state.modelId)
  const explicitModel = autoSelection
    ? undefined
    : state.models.find(model => model.id === state.modelId && model.kind === state.kind)
  const memoryModel = autoSelection && state.boardMemoryEnabled !== false
    ? resolveModelForAssistantGeneration(state.items, state.models, state.kind)
    : undefined
  const memorySelection = memoryModel
    ? selectSmartModel({
        models: state.models,
        defaults: state.defaults,
        kind: state.kind,
        modelId: memoryModel.id,
        refs: smartRefsFor(state.kind, state.refs.map(ref => ({ kind: ref.kind }))),
      })
    : null
  const rememberedModelId = memorySelection?.error ? state.modelId : memoryModel?.id
  return planDockLaunch({
    ...state,
    // A stale/manual id must reach the shared selector and produce its clear
    // catalog/kind error.  Falling back to Auto here would silently run a
    // different model after a catalog refresh.
    modelId: explicitModel?.id ?? (autoSelection ? (rememberedModelId ?? null) : state.modelId),
    // Keep the effective/manual values from the dock.  The launch planner
    // materializes only fields supported by the resolved model and fills the
    // rest from its schema defaults; clearing the values here made an
    // assistant launch silently reset a user's compact controls whenever Auto
    // or board-memory selection was involved.
    params: structuredClone(state.params),
    refs: state.refs.map(ref => ({ ...ref })),
    batchMode: 'together',
    count: 1,
    sketchTarget: null,
    textPreparation: undefined,
  })
}

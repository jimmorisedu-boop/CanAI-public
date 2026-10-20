import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getGenerationTasks,
  subscribeGenerationTasks,
  type GenerationTask,
} from '../generationRegistry'
import { animateCamera, type CameraAnimationDeps } from './cameraAnimation'
import type { CanvasStore } from './canvasStore'
import {
  decideSeriesReveal,
  terminalMultiVariantSeries,
  type GenerationSeriesEntry,
} from './generationSeriesRevealModel'
import {
  placeSeriesCues,
  type Rect,
  type SeriesCuePlacement,
} from './generationSeriesGeometry'
import type { CanvasCamera } from './types'

const REVEAL_DURATION_MS = 240

export interface GenerationSeriesCueModel extends SeriesCuePlacement {
  accessibleName: string
}

export interface GenerationSeriesRevealCoordinatorStore {
  getCamera(): CanvasCamera
  setCamera(camera: CanvasCamera): void
  setGenerationSafeViewport(viewport: Rect): void
  getGenerationSeriesEntries(launchId: string): GenerationSeriesEntry[]
  getGenerationSeriesTargetCamera(launchId: string): CanvasCamera | null
  hasHandledGenerationLaunch(launchId: string): boolean
  markGenerationLaunchHandled(launchId: string): boolean
  getGenerationFocus(): string[]
  subscribeContent(listener: () => void): () => void
  subscribeCamera(listener: () => void): () => void
  subscribeManualCamera(listener: () => void): () => void
  subscribeGenerationFocus(listener: () => void): () => void
}

interface CoordinatorInput {
  projectId: string
  viewport: Rect
  obstacles: Rect[]
  enabled: boolean
}

export interface GenerationSeriesRevealCoordinatorDeps extends CoordinatorInput {
  store: GenerationSeriesRevealCoordinatorStore
  getTasks?: () => GenerationTask[]
  subscribeTasks?: (listener: () => void) => () => void
  animationDeps?: CameraAnimationDeps
  reducedMotion?: boolean | (() => boolean)
}

export interface GenerationSeriesRevealCoordinator {
  getCues(): GenerationSeriesCueModel[]
  subscribe(listener: () => void): () => void
  showSeries(launchId: string): void
  update(input: Partial<CoordinatorInput>): void
  dispose(): void
}

interface ActiveReveal {
  launchId: string
  projectId: string
  kind: 'auto' | 'explicit'
  plannedFrameId: number | null
  cancelAnimation: (() => void) | null
}

const browserAnimationDeps: CameraAnimationDeps = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
}

export function resultWord(count: number): string {
  return Math.abs(count) === 1 ? 'result' : 'results'
}

function accessibleCueName(cue: SeriesCuePlacement): string {
  if (cue.direction === 'mixed') {
    return `Show all ${cue.totalCount} ${resultWord(cue.totalCount)}`
  }
  const side = {
    left: 'left',
    right: 'right',
    up: 'top',
    down: 'bottom',
  }[cue.direction]
  return `Show more ${cue.hiddenCount} ${resultWord(cue.hiddenCount)} ${side}`
}

function sameCueList(a: GenerationSeriesCueModel[], b: GenerationSeriesCueModel[]): boolean {
  return a.length === b.length && a.every((cue, index) => {
    const other = b[index]
    return other !== undefined
      && cue.launchId === other.launchId
      && cue.direction === other.direction
      && cue.hiddenCount === other.hiddenCount
      && cue.totalCount === other.totalCount
      && cue.x === other.x
      && cue.y === other.y
      && cue.accessibleName === other.accessibleName
  })
}

export function createGenerationSeriesRevealCoordinator(
  deps: GenerationSeriesRevealCoordinatorDeps,
): GenerationSeriesRevealCoordinator {
  const store = deps.store
  const getTasks = deps.getTasks ?? getGenerationTasks
  const subscribeTasks = deps.subscribeTasks ?? subscribeGenerationTasks
  const animationDeps = deps.animationDeps ?? browserAnimationDeps
  const configuredReducedMotion = deps.reducedMotion
  const reducedMotion = typeof configuredReducedMotion === 'function'
    ? configuredReducedMotion
    : () => configuredReducedMotion ?? (
      typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )

  let input: CoordinatorInput = {
    projectId: deps.projectId,
    viewport: { ...deps.viewport },
    obstacles: deps.obstacles.map((rect) => ({ ...rect })),
    enabled: deps.enabled,
  }
  store.setGenerationSafeViewport(input.viewport)
  let cues: GenerationSeriesCueModel[] = []
  let disposed = false
  let evaluating = false
  let evaluateAgain = false
  let applyingCameraFrame = false
  const cueListeners = new Set<() => void>()
  const manuallySuppressedLaunchIds = new Set<string>()
  const activeReveals = new Map<string, ActiveReveal>()

  function publishCues(next: GenerationSeriesCueModel[]): void {
    if (sameCueList(cues, next)) return
    cues = next
    cueListeners.forEach((listener) => listener())
  }

  function cancelReveal(launchId: string): void {
    const active = activeReveals.get(launchId)
    if (!active) return
    activeReveals.delete(launchId)
    if (active.plannedFrameId !== null) animationDeps.cancelFrame(active.plannedFrameId)
    active.cancelAnimation?.()
  }

  function cancelAllReveals(): void {
    for (const launchId of [...activeReveals.keys()]) cancelReveal(launchId)
  }

  function suppressAndCancelAutoReveals(): void {
    for (const active of [...activeReveals.values()]) {
      if (active.kind !== 'auto') continue
      manuallySuppressedLaunchIds.add(active.launchId)
      cancelReveal(active.launchId)
    }
  }

  function finishReveal(active: ActiveReveal): void {
    if (activeReveals.get(active.launchId) !== active) return
    activeReveals.delete(active.launchId)
    if (active.projectId !== input.projectId || disposed) return
    store.markGenerationLaunchHandled(active.launchId)
  }

  function startAnimation(active: ActiveReveal, target: CanvasCamera): void {
    const useReducedMotion = reducedMotion()
    const startedAt = animationDeps.now()
    let deliveringFinalFrame = useReducedMotion
    const timedAnimationDeps: CameraAnimationDeps = useReducedMotion
      ? animationDeps
      : {
          now: () => startedAt,
          requestFrame: (callback) => animationDeps.requestFrame((timestamp) => {
            deliveringFinalFrame = timestamp - startedAt >= REVEAL_DURATION_MS
            try {
              callback(timestamp)
            } finally {
              deliveringFinalFrame = false
            }
          }),
          cancelFrame: animationDeps.cancelFrame,
        }
    const cancel = animateCamera(
      store.getCamera(),
      target,
      {
        durationMs: REVEAL_DURATION_MS,
        reducedMotion: useReducedMotion,
        onFrame: (camera) => {
          if (disposed || activeReveals.get(active.launchId) !== active) return
          applyingCameraFrame = true
          try {
            store.setCamera(camera)
          } finally {
            applyingCameraFrame = false
          }
          if (deliveringFinalFrame) finishReveal(active)
        },
      },
      timedAnimationDeps,
    )
    if (activeReveals.get(active.launchId) === active) active.cancelAnimation = cancel
  }

  function decisionFor(launchId: string) {
    const descriptor = terminalMultiVariantSeries(getTasks(), input.projectId)
      .find((candidate) => candidate.launchId === launchId)
    if (!descriptor) return null
    return decideSeriesReveal({
      descriptor,
      entries: store.getGenerationSeriesEntries(launchId),
      handled: store.hasHandledGenerationLaunch(launchId),
      manuallySuppressed: manuallySuppressedLaunchIds.has(launchId),
      camera: store.getCamera(),
      viewport: input.viewport,
    })
  }

  function planReveal(launchId: string): void {
    if (activeReveals.has(launchId)) return
    const active: ActiveReveal = {
      launchId,
      projectId: input.projectId,
      kind: 'auto',
      plannedFrameId: null,
      cancelAnimation: null,
    }
    activeReveals.set(launchId, active)
    active.plannedFrameId = animationDeps.requestFrame(() => {
      active.plannedFrameId = null
      if (disposed
        || activeReveals.get(launchId) !== active
        || active.projectId !== input.projectId
        || !input.enabled) return

      const decision = decisionFor(launchId)
      if (decision?.kind !== 'reveal') {
        activeReveals.delete(launchId)
        evaluate()
        return
      }
      const target = store.getGenerationSeriesTargetCamera(launchId)
      if (!target) {
        activeReveals.delete(launchId)
        return
      }
      startAnimation(active, target)
    })
  }

  function runEvaluation(): void {
    if (disposed || !input.enabled) {
      cancelAllReveals()
      publishCues([])
      return
    }

    const rawCues: Array<Omit<SeriesCuePlacement, 'x' | 'y'>> = []
    const descriptors = terminalMultiVariantSeries(getTasks(), input.projectId)
    const currentLaunchIds = new Set(descriptors.map((descriptor) => descriptor.launchId))
    for (const launchId of [...activeReveals.keys()]) {
      if (!currentLaunchIds.has(launchId)) cancelReveal(launchId)
    }
    let autoRevealReserved = activeReveals.size > 0

    for (const descriptor of descriptors) {
      // Собственная анимация проходит через промежуточные камеры, где одна
      // карточка уже может пересечь порог 25%. ResizeObserver в тот же момент
      // пересчитывает safe viewport; эта переоценка не должна превращать
      // активный reveal в cue и отменять его же финальный RAF.
      if (activeReveals.has(descriptor.launchId)) continue
      const handled = store.hasHandledGenerationLaunch(descriptor.launchId)
      const decision = decideSeriesReveal({
        descriptor,
        entries: store.getGenerationSeriesEntries(descriptor.launchId),
        handled,
        manuallySuppressed: manuallySuppressedLaunchIds.has(descriptor.launchId),
        camera: store.getCamera(),
        viewport: input.viewport,
      })

      if (decision.kind === 'wait') {
        cancelReveal(descriptor.launchId)
        continue
      }
      if (decision.kind === 'handled') {
        cancelReveal(descriptor.launchId)
        if (!handled) store.markGenerationLaunchHandled(descriptor.launchId)
        continue
      }
      if (decision.kind === 'cue') {
        cancelReveal(descriptor.launchId)
        rawCues.push({
          launchId: descriptor.launchId,
          direction: decision.assessment.direction,
          hiddenCount: decision.assessment.hiddenIds.length,
          totalCount: descriptor.variantCount,
        })
        continue
      }
      if (autoRevealReserved) {
        manuallySuppressedLaunchIds.add(descriptor.launchId)
        const suppressed = decideSeriesReveal({
          descriptor,
          entries: store.getGenerationSeriesEntries(descriptor.launchId),
          handled,
          manuallySuppressed: true,
          camera: store.getCamera(),
          viewport: input.viewport,
        })
        if (suppressed.kind === 'cue') {
          rawCues.push({
            launchId: descriptor.launchId,
            direction: suppressed.assessment.direction,
            hiddenCount: suppressed.assessment.hiddenIds.length,
            totalCount: descriptor.variantCount,
          })
        }
        continue
      }
      planReveal(descriptor.launchId)
      autoRevealReserved = true
    }

    const placements = placeSeriesCues(rawCues, input.viewport, input.obstacles)
    publishCues(placements.map((placement) => ({
      ...placement,
      accessibleName: accessibleCueName(placement),
    })))
  }

  function evaluate(): void {
    if (evaluating) {
      evaluateAgain = true
      return
    }
    evaluating = true
    try {
      do {
        evaluateAgain = false
        runEvaluation()
      } while (evaluateAgain && !disposed)
    } finally {
      evaluating = false
    }
  }

  function handleManualCamera(): void {
    if (disposed) return
    for (const launchId of activeReveals.keys()) manuallySuppressedLaunchIds.add(launchId)
    cancelAllReveals()
    evaluate()
  }

  function handleGenerationFocus(): void {
    if (disposed || store.getGenerationFocus().length === 0) return
    suppressAndCancelAutoReveals()
    evaluate()
  }

  const unsubscribers = [
    subscribeTasks(evaluate),
    store.subscribeContent(evaluate),
    store.subscribeCamera(() => {
      if (!applyingCameraFrame) evaluate()
    }),
    store.subscribeManualCamera(handleManualCamera),
    store.subscribeGenerationFocus(handleGenerationFocus),
  ]
  evaluate()

  return {
    getCues: () => cues,
    subscribe(listener) {
      cueListeners.add(listener)
      return () => cueListeners.delete(listener)
    },
    showSeries(launchId) {
      if (disposed || !input.enabled || !launchId) return
      suppressAndCancelAutoReveals()
      manuallySuppressedLaunchIds.add(launchId)
      cancelReveal(launchId)
      const target = store.getGenerationSeriesTargetCamera(launchId)
      if (!target) {
        evaluate()
        return
      }
      const active: ActiveReveal = {
        launchId,
        projectId: input.projectId,
        kind: 'explicit',
        plannedFrameId: null,
        cancelAnimation: null,
      }
      activeReveals.set(launchId, active)
      startAnimation(active, target)
    },
    update(next) {
      if (disposed) return
      const projectChanged = next.projectId !== undefined && next.projectId !== input.projectId
      const viewportChanged = next.viewport !== undefined && (
        next.viewport.x !== input.viewport.x
        || next.viewport.y !== input.viewport.y
        || next.viewport.w !== input.viewport.w
        || next.viewport.h !== input.viewport.h
      )
      input = {
        projectId: next.projectId ?? input.projectId,
        viewport: next.viewport ? { ...next.viewport } : input.viewport,
        obstacles: next.obstacles
          ? next.obstacles.map((rect) => ({ ...rect }))
          : input.obstacles,
        enabled: next.enabled ?? input.enabled,
      }
      if (next.viewport) store.setGenerationSafeViewport(input.viewport)
      if (projectChanged || viewportChanged || !input.enabled) cancelAllReveals()
      evaluate()
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelAllReveals()
      publishCues([])
      unsubscribers.forEach((unsubscribe) => unsubscribe())
      cueListeners.clear()
    },
  }
}

export function useGenerationSeriesReveal(input: {
  store: CanvasStore
  projectId: string
  viewport: Rect
  obstacles: Rect[]
  enabled: boolean
}): { cues: GenerationSeriesCueModel[]; showSeries(launchId: string): void } {
  const coordinatorRef = useRef<GenerationSeriesRevealCoordinator | null>(null)
  const [cues, setCues] = useState<GenerationSeriesCueModel[]>([])

  useEffect(() => {
    const coordinator = createGenerationSeriesRevealCoordinator(input)
    coordinatorRef.current = coordinator
    setCues(coordinator.getCues())
    const unsubscribe = coordinator.subscribe(() => setCues(coordinator.getCues()))
    return () => {
      unsubscribe()
      coordinator.dispose()
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null
    }
    // The coordinator owns prop updates below; only a new store needs new subscriptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.store])

  useEffect(() => {
    coordinatorRef.current?.update({
      projectId: input.projectId,
      viewport: input.viewport,
      obstacles: input.obstacles,
      enabled: input.enabled,
    })
  }, [input.projectId, input.viewport, input.obstacles, input.enabled])

  const showSeries = useCallback((launchId: string) => {
    coordinatorRef.current?.showSeries(launchId)
  }, [])

  return { cues, showSeries }
}

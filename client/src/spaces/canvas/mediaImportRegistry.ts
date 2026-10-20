import { api } from '../../api'
import type { MediaImportStatus, MediaImportTask } from './mediaImportTypes'
import { registerMediaImportCancelHandler } from './mediaImportCancelBus'

const POLL_VISIBLE_MS = 800
const POLL_HIDDEN_MS = 5_000
const TERMINAL = new Set<MediaImportStatus>(['completed', 'error', 'cancelled', 'interrupted'])

export interface MediaImportTarget {
  projectId: string
  linkId: string
}

export type MediaImportSink = (
  task: MediaImportTask,
  target: MediaImportTarget,
) => void | Promise<void>

export interface MediaImportRegistryDeps {
  getTask(id: string): Promise<MediaImportTask>
  cancelTask(id: string): Promise<MediaImportTask>
  schedule(callback: () => void, delayMs: number): unknown
  unschedule(timer: unknown): void
  visibility?: {
    isHidden(): boolean
    subscribe(listener: () => void): () => void
  }
  now?: () => number
}

export interface MediaImportRegistry {
  trackMediaImport(projectId: string, linkId: string, task: MediaImportTask): void
  cancelMediaImport(taskId: string): Promise<void>
  registerMediaImportSink(projectId: string, sink: MediaImportSink): () => void
  pollNow(): Promise<void>
  dispose(): void
}

interface TrackedImport {
  target: MediaImportTarget
  task: MediaImportTask
}

interface ParkedImport {
  target: MediaImportTarget
  task: MediaImportTask
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isTerminal(task: MediaImportTask): boolean {
  return TERMINAL.has(task.status)
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 404)
}

export function createMediaImportRegistry(deps: MediaImportRegistryDeps): MediaImportRegistry {
  const tracked = new Map<string, TrackedImport>()
  const sinks = new Map<string, MediaImportSink>()
  const parked = new Map<string, ParkedImport[]>()
  const now = deps.now ?? Date.now
  let timer: unknown
  let polling = false
  let disposed = false

  function deliver(current: TrackedImport, terminal: boolean): void {
    const snapshot = clone(current.task)
    const target = clone(current.target)
    const sink = sinks.get(current.target.projectId)
    if (sink) {
      void sink(snapshot, target)
    } else if (terminal) {
      const waiting = parked.get(current.target.projectId) ?? []
      waiting.push({ task: snapshot, target })
      parked.set(current.target.projectId, waiting)
    }
  }

  function ensurePolling(): void {
    if (disposed) return
    if (tracked.size === 0) {
      if (timer !== undefined) deps.unschedule(timer)
      timer = undefined
      return
    }
    if (timer !== undefined || polling) return
    timer = deps.schedule(() => {
      timer = undefined
      void pollNow()
    }, deps.visibility?.isHidden() ? POLL_HIDDEN_MS : POLL_VISIBLE_MS)
  }

  function applySnapshot(item: TrackedImport, fresh: MediaImportTask): void {
    if (tracked.get(fresh.id) !== item || fresh.updatedAt <= item.task.updatedAt) return
    item.task = clone(fresh)
    const terminal = isTerminal(fresh)
    deliver(item, terminal)
    if (terminal) tracked.delete(fresh.id)
  }

  async function pollNow(): Promise<void> {
    if (disposed || polling) return
    polling = true
    try {
      for (const [id, item] of [...tracked]) {
        if (tracked.get(id) !== item) continue
        try {
          applySnapshot(item, await deps.getTask(id))
        } catch (error) {
          if (!isMissing(error) || tracked.get(id) !== item) continue
          const interrupted: MediaImportTask = {
            ...clone(item.task),
            status: 'interrupted',
            updatedAt: Math.max(now(), item.task.updatedAt + 1),
            error: "The server no longer stores this download task",
            items: item.task.items.map((entry) => TERMINAL.has(entry.status)
              ? clone(entry)
              : { ...clone(entry), status: 'interrupted' }),
          }
          applySnapshot(item, interrupted)
        }
      }
    } finally {
      polling = false
      ensurePolling()
    }
  }

  const unsubscribeVisibility = deps.visibility?.subscribe(() => {
    if (!deps.visibility?.isHidden() && tracked.size > 0) {
      if (timer !== undefined) deps.unschedule(timer)
      timer = undefined
      void pollNow()
    }
  }) ?? (() => undefined)

  function trackMediaImport(projectId: string, linkId: string, task: MediaImportTask): void {
    if (disposed || tracked.has(task.id)) return
    const item: TrackedImport = {
      target: { projectId, linkId },
      task: clone(task),
    }
    if (isTerminal(task)) {
      deliver(item, true)
      return
    }
    tracked.set(task.id, item)
    ensurePolling()
  }

  async function cancelMediaImport(taskId: string): Promise<void> {
    const current = tracked.get(taskId)
    const fresh = await deps.cancelTask(taskId)
    if (current) applySnapshot(current, fresh)
    ensurePolling()
  }

  function registerMediaImportSink(projectId: string, sink: MediaImportSink): () => void {
    sinks.set(projectId, sink)
    const waiting = parked.get(projectId)
    if (waiting?.length) {
      parked.delete(projectId)
      for (const item of waiting) void sink(clone(item.task), clone(item.target))
    }
    return () => {
      if (sinks.get(projectId) === sink) sinks.delete(projectId)
    }
  }

  return {
    trackMediaImport,
    cancelMediaImport,
    registerMediaImportSink,
    pollNow,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribeVisibility()
      if (timer !== undefined) deps.unschedule(timer)
      timer = undefined
      tracked.clear()
      parked.clear()
      sinks.clear()
    },
  }
}

const browserRegistry = createMediaImportRegistry({
  getTask: async (id) => (await api.mediaImport(id)).task,
  cancelTask: async (id) => (await api.cancelMediaImport(id)).task,
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  unschedule: (value) => window.clearTimeout(value as number),
  visibility: typeof document === 'undefined'
    ? undefined
    : {
        isHidden: () => document.visibilityState === 'hidden',
        subscribe(listener) {
          document.addEventListener('visibilitychange', listener)
          return () => document.removeEventListener('visibilitychange', listener)
        },
      },
})

const unregisterCancelHandler = typeof window === 'undefined'
  ? () => undefined
  : registerMediaImportCancelHandler((taskId) => {
      void browserRegistry.cancelMediaImport(taskId)
    })

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unregisterCancelHandler()
    browserRegistry.dispose()
  })
}

export function trackMediaImport(projectId: string, linkId: string, task: MediaImportTask): void {
  browserRegistry.trackMediaImport(projectId, linkId, task)
}

export function cancelMediaImport(taskId: string): Promise<void> {
  return browserRegistry.cancelMediaImport(taskId)
}

export function registerMediaImportSink(projectId: string, sink: MediaImportSink): () => void {
  return browserRegistry.registerMediaImportSink(projectId, sink)
}

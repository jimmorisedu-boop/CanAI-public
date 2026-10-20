import { api, type PublicEditSession } from '../../api'

const POLL_MS = 2_000

export interface ExternalEditSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  sessions: PublicEditSession[]
  error?: string
}

export interface ExternalEditDelivery {
  placedItemId: string
  message: string
}

export interface ExternalEditRegistryDependencies {
  list(): Promise<PublicEditSession[]>
  acknowledge(
    id: string,
    input: { appliedMtime: number; placedItemId: string },
  ): Promise<PublicEditSession>
  stop(id: string): Promise<void>
  schedule(callback: () => void, delayMs: number): unknown
  unschedule(timer: unknown): void
}

export interface ExternalEditRegistry {
  getSnapshot(): ExternalEditSnapshot
  subscribe(listener: () => void): () => void
  load(force?: boolean): Promise<void>
  track(session: PublicEditSession): void
  registerSink(
    projectId: string,
    sink: (session: PublicEditSession) => Promise<ExternalEditDelivery>,
  ): () => void
  stop(sessionId: string): Promise<void>
  dispose(): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to check external edits"
}

function sortSessions(sessions: PublicEditSession[]): PublicEditSession[] {
  return sessions.slice().sort((a, b) => b.createdAt - a.createdAt)
}

export function createExternalEditRegistry(
  deps: ExternalEditRegistryDependencies,
): ExternalEditRegistry {
  let snapshot: ExternalEditSnapshot = { status: 'idle', sessions: [] }
  const listeners = new Set<() => void>()
  const sinks = new Map<string, (session: PublicEditSession) => Promise<ExternalEditDelivery>>()
  const inFlightDeliveries = new Set<string>()
  const acknowledgedVersions = new Map<string, number>()
  let timer: unknown
  let latestRequest = 0
  let sharedLoad: Promise<void> | null = null
  let disposed = false

  function publish(next: ExternalEditSnapshot): void {
    snapshot = next
    for (const listener of listeners) listener()
  }

  function replaceSession(next: PublicEditSession): void {
    const sessions = snapshot.sessions.filter((item) => item.id !== next.id)
    sessions.push(next)
    publish({ status: 'ready', sessions: sortSessions(sessions) })
  }

  function shouldPoll(): boolean {
    if (snapshot.sessions.length > 0) return true
    return snapshot.status === 'error' && (listeners.size > 0 || sinks.size > 0)
  }

  function ensurePolling(): void {
    if (disposed) return
    if (shouldPoll() && timer === undefined) {
      timer = deps.schedule(() => {
        timer = undefined
        void load(true).catch(() => {})
      }, POLL_MS)
    } else if (!shouldPoll() && timer !== undefined) {
      deps.unschedule(timer)
      timer = undefined
    }
  }

  function deliveryKey(session: PublicEditSession): string {
    return `${session.id}:${session.lastMtime}`
  }

  async function deliver(session: PublicEditSession): Promise<void> {
    if (
      session.state !== 'ready' ||
      session.lastMtime <= session.appliedMtime ||
      (acknowledgedVersions.get(session.id) ?? -Infinity) >= session.lastMtime
    ) return
    const sink = sinks.get(session.projectId)
    if (!sink) return
    const key = deliveryKey(session)
    if (inFlightDeliveries.has(key)) return
    inFlightDeliveries.add(key)
    try {
      const result = await sink(session)
      const acknowledged = await deps.acknowledge(session.id, {
        appliedMtime: session.lastMtime,
        placedItemId: result.placedItemId,
      })
      acknowledgedVersions.set(
        session.id,
        Math.max(acknowledgedVersions.get(session.id) ?? -Infinity, session.lastMtime),
      )
      const current = snapshot.sessions.find((item) => item.id === session.id)
      if (!current || current.lastMtime <= acknowledged.lastMtime) {
        replaceSession(acknowledged)
      } else {
        replaceSession({
          ...current,
          appliedMtime: Math.max(current.appliedMtime, acknowledged.appliedMtime),
          placedItemId: acknowledged.placedItemId ?? current.placedItemId,
          state: current.lastMtime > acknowledged.appliedMtime ? 'ready' : acknowledged.state,
        })
      }
    } catch {
      // The same version remains ready. A later poll or sink registration retries it.
    } finally {
      inFlightDeliveries.delete(key)
      ensurePolling()
    }
  }

  function deliverReady(): void {
    for (const session of snapshot.sessions) void deliver(session)
  }

  function load(force = false): Promise<void> {
    if (disposed) return Promise.resolve()
    if (sharedLoad && !force) return sharedLoad
    const request = ++latestRequest
    publish({ status: 'loading', sessions: snapshot.sessions })
    let operation!: Promise<void>
    operation = (async () => {
      try {
        const sessions = await deps.list()
        if (request !== latestRequest || disposed) return
        publish({ status: 'ready', sessions: sortSessions(sessions) })
        deliverReady()
      } catch (error) {
        if (request === latestRequest && !disposed) {
          publish({ status: 'error', sessions: snapshot.sessions, error: errorMessage(error) })
        }
        throw error
      } finally {
        if (sharedLoad === operation) sharedLoad = null
        ensurePolling()
      }
    })()
    sharedLoad = operation
    return operation
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener)
      ensurePolling()
      return () => {
        listeners.delete(listener)
        ensurePolling()
      }
    },

    load,

    track(session) {
      latestRequest++
      replaceSession(session)
      deliverReady()
      ensurePolling()
    },

    registerSink(projectId, sink) {
      sinks.set(projectId, sink)
      deliverReady()
      ensurePolling()
      return () => {
        if (sinks.get(projectId) === sink) sinks.delete(projectId)
        ensurePolling()
      }
    },

    async stop(sessionId) {
      await deps.stop(sessionId)
      latestRequest++
      acknowledgedVersions.delete(sessionId)
      publish({
        status: 'ready',
        sessions: snapshot.sessions.filter((session) => session.id !== sessionId),
      })
      ensurePolling()
    },

    dispose() {
      disposed = true
      latestRequest++
      if (timer !== undefined) {
        deps.unschedule(timer)
        timer = undefined
      }
      listeners.clear()
      sinks.clear()
      inFlightDeliveries.clear()
    },
  }
}

export const browserExternalEditRegistry = createExternalEditRegistry({
  list: () => api.listEditSessions(),
  acknowledge: async (id, input) => (await api.acknowledgeEditSession(id, input)).session,
  stop: async (id) => { await api.stopEditSession(id) },
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  unschedule: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
})

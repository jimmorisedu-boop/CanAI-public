import { useSyncExternalStore } from 'react'
import { api } from '../../api'
import { announce } from '../../ui/announce'
import { subscribeOnboardingSuccess } from './onboardingEvents'
import {
  emptyOnboardingDocument,
  ONBOARDING_STEPS,
  type OnboardingDocument,
  type OnboardingPatch,
  type OnboardingStepId,
  type OnboardingView,
} from './onboardingModel'
import { notify } from './toastBus'

const RETRY_DELAYS_MS = [500, 1500, 3500] as const
const SAVE_ERROR = "Failed to save learning progress. Let's try again."
const OFFLINE_MESSAGE = "Onboarding progress will be saved when the connection is restored."

export interface OnboardingSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  document: OnboardingDocument | null
}

export interface OnboardingStoreDeps {
  load(): Promise<OnboardingDocument>
  patch(patch: OnboardingPatch): Promise<OnboardingDocument>
  schedule(run: () => void, delayMs: number): unknown
  announce(message: string, priority: 'polite' | 'assertive'): void
  notifyOffline(): void
}

export interface OnboardingStore {
  getSnapshot(): OnboardingSnapshot
  subscribe(listener: () => void): () => void
  load(options?: { force?: boolean }): Promise<void>
  complete(id: OnboardingStepId): Promise<void>
  skip(id: OnboardingStepId): Promise<void>
  setView(view: OnboardingView): Promise<void>
  reset(): Promise<void>
}

interface PendingPatch {
  patch: OnboardingPatch
  failures: number
  retryVersion: number
}

function applyPatch(document: OnboardingDocument, patch: OnboardingPatch): OnboardingDocument {
  if ('reset' in patch) return emptyOnboardingDocument()
  if ('view' in patch) return { ...document, view: patch.view }
  return {
    ...document,
    steps: { ...document.steps, [patch.step.id]: patch.step.state },
  }
}

export function createOnboardingStore(deps: OnboardingStoreDeps): OnboardingStore {
  let snapshot: OnboardingSnapshot = { status: 'idle', document: null }
  const listeners = new Set<() => void>()
  const pending: PendingPatch[] = []
  const parkedSteps = new Map<OnboardingStepId, 'done' | 'skipped'>()
  let activeFlush: Promise<void> | null = null
  let activeLoad: Promise<void> | null = null
  let flushAfterActive = false
  let failureNotified = false
  let mutationEpoch = 0

  const publish = (next: OnboardingSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const optimisticDocument = (patch: OnboardingPatch): OnboardingDocument | null => {
    if (!snapshot.document && !('reset' in patch)) return null
    return applyPatch(snapshot.document ?? emptyOnboardingDocument(), patch)
  }

  const replayPending = (document: OnboardingDocument): OnboardingDocument => (
    pending.reduce((current, entry) => applyPatch(current, entry.patch), document)
  )

  const drain = async (): Promise<void> => {
    while (pending.length > 0) {
      const entry = pending[0]
      entry.retryVersion += 1
      try {
        const saved = await deps.patch(entry.patch)
        pending.shift()
        failureNotified = false
        mutationEpoch += 1
        publish({ status: 'ready', document: replayPending(saved) })
      } catch {
        if (!failureNotified) {
          failureNotified = true
          deps.announce(SAVE_ERROR, 'assertive')
          deps.notifyOffline()
        }
        if (entry.failures >= RETRY_DELAYS_MS.length) return
        const delay = RETRY_DELAYS_MS[entry.failures]
        entry.failures += 1
        const retryVersion = ++entry.retryVersion
        deps.schedule(() => {
          if (pending[0] === entry && entry.retryVersion === retryVersion) void flush()
        }, delay)
        return
      }
    }
  }

  const flush = (afterActive = false): Promise<void> => {
    if (activeFlush) {
      flushAfterActive ||= afterActive
      return activeFlush
    }
    const running = drain()
    activeFlush = running
    void running.finally(() => {
      if (activeFlush !== running) return
      activeFlush = null
      if (flushAfterActive) {
        flushAfterActive = false
        void flush()
      }
    }).catch(() => {})
    return running
  }

  const queuePatch = async (patch: OnboardingPatch): Promise<void> => {
    const completedStep = 'step' in patch
      && patch.step.state === 'done'
      && snapshot.document?.steps[patch.step.id] === 'pending'
    const optimistic = optimisticDocument(patch)
    if (!optimistic) return
    mutationEpoch += 1
    publish({ status: snapshot.status === 'error' ? 'ready' : snapshot.status, document: optimistic })
    if (completedStep && 'step' in patch) {
      const title = ONBOARDING_STEPS.find(({ id }) => id === patch.step.id)?.title
      if (title) deps.announce(`Step "${title}" is completed.`, 'polite')
    }
    pending.push({ patch, failures: 0, retryVersion: 0 })
    await flush(activeFlush !== null)
  }

  const parkStep = (id: OnboardingStepId, state: 'done' | 'skipped'): Promise<void> => {
    parkedSteps.set(id, state)
    return Promise.resolve()
  }

  const flushParkedSteps = async (): Promise<void> => {
    const steps = [...parkedSteps]
    parkedSteps.clear()
    for (const [id, state] of steps) {
      if (snapshot.document?.steps[id] !== 'pending') continue
      await queuePatch({ step: { id, state } })
    }
  }

  const load = (options?: { force?: boolean }): Promise<void> => {
    if (activeLoad) return activeLoad
    if (!options?.force && snapshot.status === 'ready') return flush(activeFlush !== null)

    const startedAtMutation = mutationEpoch
    publish({ status: 'loading', document: snapshot.document })
    const running = (async () => {
      try {
        const loaded = await deps.load()
        if (mutationEpoch !== startedAtMutation) {
          if (snapshot.document) publish({ status: 'ready', document: snapshot.document })
          await flush(activeFlush !== null)
          return
        }
        publish({ status: 'ready', document: replayPending(loaded) })
        await flushParkedSteps()
        await flush(activeFlush !== null)
      } catch {
        if (snapshot.document) {
          publish({ status: 'ready', document: snapshot.document })
        } else {
          publish({ status: 'error', document: null })
        }
      }
    })()
    activeLoad = running
    void running.finally(() => {
      if (activeLoad === running) activeLoad = null
    }).catch(() => {})
    return running
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
    complete(id) {
      if (!snapshot.document) return parkStep(id, 'done')
      if (snapshot.document.steps[id] !== 'pending') return flush(activeFlush !== null)
      return queuePatch({ step: { id, state: 'done' } })
    },
    skip(id) {
      if (!snapshot.document) return parkStep(id, 'skipped')
      if (snapshot.document.steps[id] !== 'pending') return flush(activeFlush !== null)
      return queuePatch({ step: { id, state: 'skipped' } })
    },
    setView(view) {
      if (!snapshot.document || snapshot.document.view === view) return Promise.resolve()
      return queuePatch({ view })
    },
    reset() {
      return queuePatch({ reset: true })
    },
  }
}

const browserDeps: OnboardingStoreDeps = {
  load: () => api.getOnboarding(),
  patch: (patch) => api.patchOnboarding(patch),
  schedule: (run, delayMs) => window.setTimeout(run, delayMs),
  announce: (message, priority) => announce(message, priority),
  notifyOffline: () => notify({
    kind: 'error',
    message: OFFLINE_MESSAGE,
    replaceKey: 'onboarding-save',
  }),
}

export const onboardingStore = createOnboardingStore(browserDeps)

export function retryOnboardingOnBoardOpen(
  store: Pick<OnboardingStore, 'getSnapshot' | 'load'>,
): Promise<void> {
  if (store.getSnapshot().status !== 'error') return Promise.resolve()
  return store.load()
}

subscribeOnboardingSuccess((id) => { void onboardingStore.complete(id) })

export function useOnboardingSnapshot(): OnboardingSnapshot {
  return useSyncExternalStore(
    onboardingStore.subscribe,
    onboardingStore.getSnapshot,
    onboardingStore.getSnapshot,
  )
}

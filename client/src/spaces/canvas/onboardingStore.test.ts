import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createOnboardingStore,
  retryOnboardingOnBoardOpen,
  type OnboardingSnapshot,
  type OnboardingStoreDeps,
} from './onboardingStore'
import type { OnboardingDocument, OnboardingPatch } from './onboardingModel'

function document(overrides: Partial<OnboardingDocument> = {}): OnboardingDocument {
  return {
    version: 1,
    steps: {
      'first-generation': 'pending',
      'reference-generation': 'pending',
      recovery: 'pending',
      'save-for-later': 'pending',
      export: 'pending',
    },
    view: 'expanded',
    completedAt: null,
    ...overrides,
  }
}

function createDeps(overrides: Partial<OnboardingStoreDeps> = {}): OnboardingStoreDeps & {
  patches: OnboardingPatch[]
  scheduled: Array<{ run(): void; delayMs: number }>
  announcements: string[]
  announcementPriorities: Array<'polite' | 'assertive'>
  offlineNotifications: number
} {
  const patches: OnboardingPatch[] = []
  const scheduled: Array<{ run(): void; delayMs: number }> = []
  const announcements: string[] = []
  const announcementPriorities: Array<'polite' | 'assertive'> = []
  let offlineNotifications = 0
  return {
    patches,
    scheduled,
    announcements,
    announcementPriorities,
    get offlineNotifications() {
      return offlineNotifications
    },
    load: async () => document(),
    patch: async (patch) => {
      patches.push(patch)
      if ('reset' in patch) return document()
      if ('view' in patch) return document({ view: patch.view })
      return document({ steps: { ...document().steps, [patch.step.id]: patch.step.state } })
    },
    schedule: (run, delayMs) => {
      scheduled.push({ run, delayMs })
      return scheduled.length
    },
    announce: (message, priority) => {
      announcements.push(message)
      announcementPriorities.push(priority)
    },
    notifyOffline: () => { offlineNotifications++ },
    ...overrides,
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

test('success events complete only their matching step and are idempotent', async () => {
  const deps = createDeps()
  const store = createOnboardingStore(deps)
  await store.load()

  await store.complete('reference-generation')
  await store.complete('reference-generation')

  assert.equal(store.getSnapshot().document?.steps['reference-generation'], 'done')
  assert.equal(deps.patches.length, 1)
  assert.equal(store.getSnapshot().document?.steps['first-generation'], 'pending')
})

test('failed save stays optimistic and retries at increasing delays', async () => {
  const patches: OnboardingPatch[] = []
  const deps = createDeps({
    patch: async (patch) => {
      patches.push(patch)
      throw new Error('offline')
    },
  })
  const store = createOnboardingStore(deps)
  await store.load()

  await store.complete('first-generation')
  for (let attempt = 0; attempt < 2; attempt++) {
    deps.scheduled[attempt]?.run()
    await settle()
  }

  assert.equal(store.getSnapshot().document?.steps['first-generation'], 'done')
  assert.equal(patches.length, 3)
  assert.equal(deps.offlineNotifications, 1)
  assert.deepEqual(deps.announcements, [
    'Step "Create your first result" is completed.',
    "Failed to save learning progress. Let's try again.",
  ])
  assert.deepEqual(deps.announcementPriorities, ['polite', 'assertive'])
  assert.deepEqual(deps.scheduled.map(({ delayMs }) => delayMs), [500, 1500, 3500])
})

test('announces the first completed transition once with its Russian title, including export', async () => {
  const heard: Array<{ message: string; priority: unknown }> = []
  const deps = createDeps({
    announce: (message, ...rest: unknown[]) => heard.push({ message, priority: rest[0] }),
  })
  const store = createOnboardingStore(deps)
  await store.load()

  await store.complete('first-generation')
  await store.complete('first-generation')
  await store.complete('export')
  await store.complete('export')
  await store.skip('recovery')
  await store.complete('recovery')

  assert.deepEqual(heard, [
    { message: 'Step "Create your first result" is completed.', priority: 'polite' },
    { message: 'Step "Export result" is completed.', priority: 'polite' },
  ])
})

test('stops scheduling after the third automatic retry fails', async () => {
  const deps = createDeps({ patch: async () => { throw new Error('offline') } })
  const store = createOnboardingStore(deps)
  await store.load()

  await store.complete('first-generation')
  for (let attempt = 0; attempt < 3; attempt++) {
    deps.scheduled[attempt]?.run()
    await settle()
  }

  assert.equal(deps.scheduled.length, 3)
})

test('a repeated success event flushes an exhausted pending patch once without a new timer', async () => {
  let attempts = 0
  const deps = createDeps({
    patch: async () => {
      attempts += 1
      throw new Error('offline')
    },
  })
  const store = createOnboardingStore(deps)
  await store.load()

  await store.complete('first-generation')
  for (let attempt = 0; attempt < 3; attempt++) {
    deps.scheduled[attempt]?.run()
    await settle()
  }
  await store.complete('first-generation')

  assert.equal(attempts, 5)
  assert.equal(deps.scheduled.length, 3)
})

test('new local updates invalidate superseded retry timers', async () => {
  const patches: OnboardingPatch[] = []
  const deps = createDeps({
    patch: async (patch) => {
      patches.push(patch)
      throw new Error('offline')
    },
  })
  const store = createOnboardingStore(deps)
  await store.load()

  await store.complete('first-generation')
  await store.setView('compact')
  deps.scheduled[0]?.run()
  await settle()

  assert.equal(patches.length, 2)
})

test('load error exposes fallback state without inventing progress', async () => {
  const store = createOnboardingStore(createDeps({
    load: async () => { throw new Error('read failed') },
  }))

  await store.load()

  assert.equal(store.getSnapshot().status, 'error')
  assert.equal(store.getSnapshot().document, null)
})

test('a late refresh cannot overwrite a newer confirmed patch', async () => {
  const stale = document()
  const saved = document({
    steps: { ...document().steps, 'first-generation': 'done' },
  })
  let loadCalls = 0
  let resolveRefresh: (value: OnboardingDocument) => void = () => {}
  const deps = createDeps({
    load: async () => {
      loadCalls += 1
      if (loadCalls === 1) return stale
      return new Promise<OnboardingDocument>((resolve) => { resolveRefresh = resolve })
    },
    patch: async () => saved,
  })
  const store = createOnboardingStore(deps)
  await store.load()

  const refreshing = store.load({ force: true })
  await store.complete('first-generation')
  resolveRefresh(stale)
  await refreshing

  assert.equal(store.getSnapshot().status, 'ready')
  assert.equal(store.getSnapshot().document?.steps['first-generation'], 'done')
})

test('a failed force refresh retains the existing usable progress', async () => {
  const retained = document({
    steps: { ...document().steps, 'first-generation': 'done' },
  })
  let loadCalls = 0
  const store = createOnboardingStore(createDeps({
    load: async () => {
      loadCalls += 1
      if (loadCalls === 1) return retained
      throw new Error('refresh failed')
    },
  }))
  await store.load()

  await store.load({ force: true })

  assert.equal(store.getSnapshot().status, 'ready')
  assert.equal(store.getSnapshot().document, retained)
})

test('opening a board retries onboarding only after a load error', async () => {
  let status: OnboardingSnapshot['status'] = 'error'
  let loadCalls = 0
  const boardStore = {
    getSnapshot: (): OnboardingSnapshot => ({ status, document: null }),
    load: async () => {
      loadCalls += 1
      status = 'loading'
    },
  }

  await retryOnboardingOnBoardOpen(boardStore)
  await retryOnboardingOnBoardOpen(boardStore)
  status = 'ready'
  await retryOnboardingOnBoardOpen(boardStore)

  assert.equal(loadCalls, 1)
})

test('completes a step reported while the document is loading', async () => {
  let resolveLoad: (value: OnboardingDocument) => void = () => {}
  const deps = createDeps({
    load: () => new Promise<OnboardingDocument>((resolve) => { resolveLoad = resolve }),
  })
  const store = createOnboardingStore(deps)

  const loading = store.load()
  await store.complete('first-generation')
  await store.complete('first-generation')
  assert.equal(deps.patches.length, 0)
  resolveLoad(document())
  await loading

  assert.equal(store.getSnapshot().document?.steps['first-generation'], 'done')
  assert.deepEqual(deps.patches, [{ step: { id: 'first-generation', state: 'done' } }])
})

test('skips a step reported after a failed load when loading recovers', async () => {
  let shouldFail = true
  const deps = createDeps({
    load: async () => {
      if (shouldFail) throw new Error('read failed')
      return document()
    },
  })
  const store = createOnboardingStore(deps)
  await store.load()

  await store.skip('save-for-later')
  assert.equal(deps.patches.length, 0)
  shouldFail = false
  await store.load()

  assert.equal(store.getSnapshot().document?.steps['save-for-later'], 'skipped')
  assert.deepEqual(deps.patches, [{ step: { id: 'save-for-later', state: 'skipped' } }])
})

test('preserves a server-done step when a parked skip is loaded', async () => {
  let shouldFail = true
  const deps = createDeps({
    load: async () => {
      if (shouldFail) throw new Error('read failed')
      return document({ steps: { ...document().steps, 'first-generation': 'done' } })
    },
  })
  const store = createOnboardingStore(deps)
  await store.load()
  await store.skip('first-generation')

  shouldFail = false
  await store.load()

  assert.equal(store.getSnapshot().document?.steps['first-generation'], 'done')
  assert.equal(deps.patches.length, 0)
})

test('preserves a server-skipped step when a parked completion is loaded', async () => {
  let shouldFail = true
  const deps = createDeps({
    load: async () => {
      if (shouldFail) throw new Error('read failed')
      return document({ steps: { ...document().steps, 'first-generation': 'skipped' } })
    },
  })
  const store = createOnboardingStore(deps)
  await store.load()
  await store.complete('first-generation')

  shouldFail = false
  await store.load()

  assert.equal(store.getSnapshot().document?.steps['first-generation'], 'skipped')
  assert.equal(deps.patches.length, 0)
})

test('reset clears only onboarding through the server patch', async () => {
  const reset = document({
    steps: {
      'first-generation': 'pending',
      'reference-generation': 'pending',
      recovery: 'pending',
      'save-for-later': 'pending',
      export: 'pending',
    },
    view: 'expanded',
  })
  const deps = createDeps({ patch: async (patch) => {
    deps.patches.push(patch)
    return reset
  } })
  const store = createOnboardingStore(deps)
  await store.load()

  await store.reset()

  assert.deepEqual(deps.patches, [{ reset: true }])
  assert.equal(store.getSnapshot().document, reset)
})

test('dismiss keeps progress and persists the exact hidden view', async () => {
  let saved = document()
  const deps = createDeps({ patch: async (patch) => {
    deps.patches.push(patch)
    if ('view' in patch) saved = { ...saved, view: patch.view }
    if ('step' in patch) saved = {
      ...saved,
      steps: { ...saved.steps, [patch.step.id]: patch.step.state },
    }
    return saved
  } })
  const store = createOnboardingStore(deps)
  await store.load()
  await store.complete('first-generation')

  await store.setView('dismissed')

  assert.equal(store.getSnapshot().document?.steps['first-generation'], 'done')
  assert.equal(store.getSnapshot().document?.view, 'dismissed')
  assert.deepEqual(deps.patches, [
    { step: { id: 'first-generation', state: 'done' } },
    { view: 'dismissed' },
  ])
})

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type {
  GenerationRegistry,
  GenerationRetryDescriptor,
  GenerationTask,
  RestoredGenerationTask,
} from '../generationRegistry'
import type { GenerationLaunchBase } from '../generationLaunches'
import { restoreProjectGenerationTasks } from '../projectSync'
import { CanvasStore } from './canvasStore'
import { createGenerationSeriesRevealCoordinator } from './useGenerationSeriesReveal'

const originalWindow = globalThis.window

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
})

const LAUNCH: GenerationLaunchBase = {
  launchId: 'launch-persisted',
  variantCount: 2,
  projectId: 'project-1',
  projectName: 'Доска',
  promptPreview: 'Сделай два ролика',
  modelId: 'video-model',
  modelName: 'Видео-модель',
  estimatedTotalCostUsd: 0.4,
  createdAt: 100,
}

const RETRY: GenerationRetryDescriptor = {
  kind: 'video',
  prompt: 'Сделай два ролика',
  refs: [],
  model: 'video-model',
  params: { aspect_ratio: '16:9' },
}

test('сохраняет launch от pending до готового результата и повторной загрузки', async () => {
  const store = new CanvasStore()
  const pendingIds = store.addPendingRow(2, {
    kind: 'video',
    label: 'Видео-модель',
    launch: LAUNCH,
    retry: RETRY,
  })
  store.setPendingJob(pendingIds[0], 'job-ready')
  store.setPendingJob(pendingIds[1], 'local:failed')
  store.failPendingById(pendingIds[1], 'Сеть недоступна')

  assert.deepEqual(
    store.getPending().map((pending) => pending.launch?.variantIndex),
    [1, 2],
  )
  assert.ok(store.getPending().every((pending) => pending.retry === RETRY))

  await store.resolveJob(
    'job-ready',
    { url: '/media/result.mp4', mime: 'video/mp4', width: 1280, height: 720 },
    'Результат',
  )

  const ready = store.getItems()[0]
  assert.equal(ready.sourceJobId, 'job-ready')
  assert.equal(ready.sourceLaunch?.variantIndex, 1)

  const restored = new CanvasStore()
  restored.loadDoc(store.toDoc())

  assert.equal(restored.getItems()[0].sourceJobId, 'job-ready')
  assert.equal(restored.getItems()[0].sourceLaunch?.launchId, LAUNCH.launchId)
  assert.equal(restored.getPending()[0].jobId, 'local:failed')
  assert.equal(restored.getPending()[0].status, 'error')
  assert.equal(restored.getPending()[0].launch?.variantIndex, 2)
  assert.deepEqual(restored.getPending()[0].retry, RETRY)
})

test('восстанавливает running, error и done задачи из документа доски', () => {
  const store = new CanvasStore()
  const launchBase = { ...LAUNCH, variantCount: 4 }
  store.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [{
      id: 'ready-item',
      kind: 'video',
      x: 0,
      y: 0,
      w: 320,
      h: 180,
      src: '/media/ready.mp4',
      sourceJobId: 'job-done',
      sourceLaunch: { ...launchBase, variantIndex: 1 },
    }],
    archive: [{
      id: 'archived-item',
      kind: 'video',
      x: 400,
      y: 0,
      w: 320,
      h: 180,
      src: '/media/archived.mp4',
      sourceJobId: 'job-archived',
      sourceLaunch: { ...launchBase, variantIndex: 4 },
      archivedAt: 500,
    }],
    pending: [
      {
        id: 'running-slot',
        jobId: 'job-running',
        x: 0,
        y: 240,
        w: 320,
        h: 180,
        kind: 'video',
        label: 'Видео-модель',
        status: 'loading',
        startedAt: 200,
        launch: { ...launchBase, variantIndex: 2 },
        retry: RETRY,
      },
      {
        id: 'error-slot',
        jobId: 'local:failed',
        x: 400,
        y: 240,
        w: 320,
        h: 180,
        kind: 'video',
        label: 'Видео-модель',
        status: 'error',
        error: 'Сервер недоступен',
        startedAt: 201,
        launch: { ...launchBase, variantIndex: 3 },
        retry: RETRY,
      },
      {
        id: 'macro-slot',
        jobId: 'macro:temporary',
        x: 800,
        y: 240,
        w: 320,
        h: 180,
        kind: 'video',
        label: 'Макрос',
        status: 'loading',
        startedAt: 202,
      },
    ],
  })
  const tracked: Array<Parameters<GenerationRegistry['trackGeneration']>> = []
  const restored: RestoredGenerationTask[] = []

  restoreProjectGenerationTasks(store, LAUNCH.projectId, {
    trackGeneration: (...args) => {
      tracked.push(args)
    },
    restoreGenerationTask: (task) => {
      restored.push(task)
    },
  })

  assert.equal(tracked.length, 1)
  assert.equal(tracked[0][1], 'job-running')
  assert.equal(tracked[0][3], RETRY)
  assert.equal(tracked[0][4]?.variantIndex, 2)
  assert.deepEqual(
    restored.map((task) => `${task.jobId}:${task.state}`).sort(),
    ['job-archived:done', 'job-done:done', 'local:failed:error'],
  )
})

test('не сохраняет data-url из retry descriptor в project.json', () => {
  const store = new CanvasStore()
  const [slotId] = store.addPendingRow(1, {
    kind: 'image',
    label: 'Модель',
    launch: { ...LAUNCH, variantCount: 1 },
    retry: {
      kind: 'image',
      prompt: 'Дорисуй изображение',
      refs: [{ kind: 'image', src: 'data:image/png;base64,unsafe' }],
    },
  })
  store.setPendingJob(slotId, 'job-sketch')

  const snapshot = store.toDoc()

  assert.equal(snapshot.pending?.[0].retry, undefined)
  assert.equal(JSON.stringify(snapshot).includes('data:image/'), false)
})

test('link-карточка не восстанавливается как завершённая fal-генерация', () => {
  const store = new CanvasStore()
  store.addItem({
    kind: 'link',
    x: 0,
    y: 0,
    w: 360,
    h: 280,
    sourceJobId: 'external-download-id',
    link: {
      url: 'https://youtu.be/abc',
      normalizedUrl: 'https://youtu.be/abc',
      provider: 'youtube',
      sourceLabel: 'YouTube',
      title: 'Ролик',
      state: 'ready',
      entries: [],
    },
  })
  const restored: RestoredGenerationTask[] = []

  restoreProjectGenerationTasks(store, 'project-1', {
    trackGeneration: () => undefined,
    restoreGenerationTask: (task) => restored.push(task),
  })

  assert.deepEqual(restored, [])
})

test('focus separates canvas, archive, pending and missing results without changing the document', () => {
  const store = new CanvasStore()
  store.loadDoc({
    version: 1,
    camera: { x: 10, y: 20, scale: 1 },
    items: [{
      id: 'canvas-result',
      kind: 'image',
      x: 300,
      y: 200,
      w: 400,
      h: 300,
      src: '/media/result.png',
      sourceJobId: 'job-canvas',
    }],
    archive: [{
      id: 'archived-result',
      kind: 'video',
      x: 900,
      y: 200,
      w: 320,
      h: 180,
      src: '/media/archived.mp4',
      sourceJobId: 'job-archive',
      archivedAt: 500,
    }],
    pending: [{
      id: 'pending-result',
      kind: 'image',
      x: 0,
      y: 0,
      w: 320,
      h: 240,
      label: 'Модель',
      status: 'loading',
      startedAt: 100,
      jobId: 'job-pending',
    }],
  })
  store.setContainerSize(1000, 800)
  const selectedId = store.addItem({
    kind: 'text',
    x: 0,
    y: 0,
    w: 160,
    h: 80,
    text: 'Оставить выделенным',
  }, { select: true })
  const beforeSelection = [...store.getSelectedIds()]
  const beforeDoc = store.toDoc()
  let documentEvents = 0
  let focusEvents = 0
  const unsubscribeDocument = store.subscribeDocument(() => documentEvents++)
  const unsubscribeFocus = store.subscribeGenerationFocus(() => focusEvents++)

  const result = store.focusGenerationResults([
    'job-canvas',
    'job-archive',
    'job-pending',
    'job-missing',
  ])

  assert.deepEqual(result, {
    canvasIds: ['canvas-result'],
    archivedIds: ['archived-result'],
    pendingJobIds: ['job-pending'],
    missingJobIds: ['job-missing'],
  })
  assert.deepEqual(store.getGenerationFocus(), ['canvas-result'])
  assert.equal(focusEvents, 1)
  assert.notDeepEqual(store.getCamera(), { x: 10, y: 20, scale: 1 })
  assert.deepEqual([...store.getSelectedIds()], beforeSelection)
  assert.deepEqual(store.toDoc(), beforeDoc)
  assert.equal(documentEvents, 0)

  store.clearGenerationFocus()
  assert.deepEqual(store.getGenerationFocus(), [])
  assert.equal(focusEvents, 2)

  store.undo()
  assert.equal(store.getItem(selectedId), undefined, 'focus must not add a history step')
  unsubscribeDocument()
  unsubscribeFocus()
})

test('series entries сохраняют job readiness и не включают архив', () => {
  const store = new CanvasStore()
  const launchBase = { ...LAUNCH, variantCount: 3 }
  store.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [{
      id: 'ready-item',
      kind: 'image',
      x: 20,
      y: 30,
      w: 200,
      h: 100,
      src: '/media/ready.png',
      sourceJobId: 'job-ready',
      sourceLaunch: { ...launchBase, variantIndex: 1 },
    }],
    pending: [{
      id: 'error-card',
      jobId: 'job-error',
      kind: 'image',
      x: 260,
      y: 30,
      w: 200,
      h: 100,
      label: 'Модель',
      status: 'error',
      error: 'Не удалось создать',
      startedAt: 200,
      launch: { ...launchBase, variantIndex: 2 },
    }],
    archive: [{
      id: 'archived-item',
      kind: 'image',
      x: 500,
      y: 30,
      w: 200,
      h: 100,
      src: '/media/archived.png',
      sourceJobId: 'job-archived',
      sourceLaunch: { ...launchBase, variantIndex: 3 },
      archivedAt: 300,
    }],
  })

  assert.deepEqual(store.getGenerationSeriesEntries(LAUNCH.launchId), [
    {
      id: 'ready-item',
      jobId: 'job-ready',
      phase: 'item',
      bounds: { x: 20, y: 30, w: 200, h: 100 },
    },
    {
      id: 'error-card',
      jobId: 'job-error',
      phase: 'pending',
      pendingStatus: 'error',
      bounds: { x: 260, y: 30, w: 200, h: 100 },
    },
  ])
})

test('series target использует transient safe viewport без document или history события', () => {
  const store = new CanvasStore()
  store.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [
      {
        id: 'series-a',
        kind: 'image',
        x: 1000,
        y: 200,
        w: 200,
        h: 200,
        src: '/media/a.png',
        sourceJobId: 'job-a',
        sourceLaunch: { ...LAUNCH, variantIndex: 1 },
      },
      {
        id: 'series-b',
        kind: 'image',
        x: 1240,
        y: 200,
        w: 200,
        h: 200,
        src: '/media/b.png',
        sourceJobId: 'job-b',
        sourceLaunch: { ...LAUNCH, variantIndex: 2 },
      },
    ],
  })
  store.setContainerSize(1000, 800)
  let contentEvents = 0
  let documentEvents = 0
  store.subscribeContent(() => contentEvents++)
  store.subscribeDocument(() => documentEvents++)

  assert.deepEqual(store.getGenerationSeriesTargetCamera(LAUNCH.launchId), {
    x: 500 - 1220,
    y: 400 - 300,
    scale: 1,
  }, 'default safe viewport equals the full container')

  store.setGenerationSafeViewport({ x: 0, y: 0, w: 700, h: 500 })

  assert.deepEqual(store.getGenerationSeriesTargetCamera(LAUNCH.launchId), {
    x: 350 - 1220,
    y: 250 - 300,
    scale: 1,
  })
  assert.equal(contentEvents, 0)
  assert.equal(documentEvents, 0)
  assert.equal('generationSafeViewport' in store.toDoc(), false)

  const historicalId = store.addItem({ kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'История' })
  store.setGenerationSafeViewport({ x: 0, y: 0, w: 600, h: 400 })
  assert.equal(store.undo(), true)
  assert.equal(store.getItem(historicalId), undefined)
})

test('series target отклоняет пустую и битую геометрию', () => {
  const empty = new CanvasStore()
  assert.equal(empty.getGenerationSeriesTargetCamera('missing'), null)

  const broken = new CanvasStore()
  broken.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [{
      id: 'broken',
      kind: 'image',
      x: 0,
      y: 0,
      w: Number.NaN,
      h: 100,
      src: '/media/broken.png',
      sourceJobId: 'job-broken',
      sourceLaunch: { ...LAUNCH, variantIndex: 1 },
    }],
  })

  assert.equal(broken.getGenerationSeriesTargetCamera(LAUNCH.launchId), null)
})

test('Task Center focus использует safe fit, отмечает найденные серии и сохраняет DOM-independent state', () => {
  const store = new CanvasStore()
  store.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [
      {
        id: 'focus-a',
        kind: 'image',
        x: 1000,
        y: 200,
        w: 200,
        h: 200,
        src: '/media/a.png',
        sourceJobId: 'job-a',
        sourceLaunch: { ...LAUNCH, variantIndex: 1 },
      },
      {
        id: 'focus-b',
        kind: 'image',
        x: 1240,
        y: 200,
        w: 200,
        h: 200,
        src: '/media/b.png',
        sourceJobId: 'job-b',
        sourceLaunch: { ...LAUNCH, variantIndex: 2 },
      },
    ],
  })
  store.setContainerSize(1000, 800)
  store.setGenerationSafeViewport({ x: 0, y: 0, w: 700, h: 500 })

  const result = store.focusGenerationResults(['job-a', 'job-b'])

  assert.deepEqual(result.canvasIds, ['focus-a', 'focus-b'])
  assert.deepEqual(store.getCamera(), { x: -870, y: -50, scale: 1 })
  assert.equal(store.hasHandledGenerationLaunch(LAUNCH.launchId), true)
})

test('Task Center focus отменяет pending auto reveal через camera/content сигнал', () => {
  const store = new CanvasStore()
  store.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [
      {
        id: 'focus-a',
        kind: 'image',
        x: 1000,
        y: 200,
        w: 200,
        h: 200,
        src: '/media/a.png',
        sourceJobId: 'job-a',
        sourceLaunch: { ...LAUNCH, variantIndex: 1 },
      },
      {
        id: 'focus-b',
        kind: 'image',
        x: 1240,
        y: 200,
        w: 200,
        h: 200,
        src: '/media/b.png',
        sourceJobId: 'job-b',
        sourceLaunch: { ...LAUNCH, variantIndex: 2 },
      },
    ],
  })
  const tasks: GenerationTask[] = [1, 2].map((variantIndex) => ({
    jobId: `job-${variantIndex === 1 ? 'a' : 'b'}`,
    jobKind: 'image',
    target: { kind: 'canvas', projectId: LAUNCH.projectId },
    state: 'done',
    launch: { ...LAUNCH, variantIndex },
    createdAt: 100 + variantIndex,
  }))
  const callbacks = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  let nextFrameId = 0
  const coordinator = createGenerationSeriesRevealCoordinator({
    store,
    projectId: LAUNCH.projectId,
    viewport: { x: 0, y: 0, w: 700, h: 500 },
    obstacles: [],
    enabled: true,
    getTasks: () => tasks,
    subscribeTasks: () => () => undefined,
    reducedMotion: false,
    animationDeps: {
      now: () => 0,
      requestFrame: (callback) => {
        const id = ++nextFrameId
        callbacks.set(id, callback)
        return id
      },
      cancelFrame: (id) => {
        cancelled.push(id)
        callbacks.delete(id)
      },
    },
  })
  assert.equal(callbacks.size, 1)

  store.focusGenerationResults(['job-a', 'job-b'])

  assert.deepEqual(cancelled, [1])
  assert.equal(callbacks.size, 0)
  assert.equal(store.hasHandledGenerationLaunch(LAUNCH.launchId), true)
  assert.deepEqual(coordinator.getCues(), [])
  coordinator.dispose()
})

test('повторная подсветка обучения отменяет старый таймер очистки', () => {
  const scheduled = new Map<number, () => void>()
  const cancelled: number[] = []
  let nextTimer = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: (run: TimerHandler) => {
        const timer = ++nextTimer
        scheduled.set(timer, run as () => void)
        return timer
      },
      clearTimeout: (timer: number) => cancelled.push(timer),
    },
  })
  const store = new CanvasStore()
  store.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [{ id: 'reference', kind: 'text', x: 0, y: 0, w: 120, h: 60, text: 'Референс' }],
  })

  store.focusOnboardingItem('reference')
  store.focusOnboardingItem('reference')

  assert.deepEqual(cancelled, [1])
  scheduled.get(1)?.()
  assert.deepEqual(store.getOnboardingFocus(), ['reference'])
  scheduled.get(2)?.()
  assert.deepEqual(store.getOnboardingFocus(), [])
})

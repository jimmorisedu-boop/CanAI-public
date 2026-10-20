import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationTask } from '../generationRegistry'
import type { GenerationLaunchMeta } from '../generationLaunches'
import {
  decideSeriesReveal,
  terminalMultiVariantSeries,
  type GenerationSeriesDescriptor,
  type GenerationSeriesEntry,
} from './generationSeriesRevealModel'
import {
  createGenerationSeriesRevealCoordinator,
  type GenerationSeriesRevealCoordinatorStore,
} from './useGenerationSeriesReveal'
import type { CameraAnimationDeps } from './cameraAnimation'
import type { CanvasCamera } from './types'

const PROJECT_ID = 'project-a'
const CAMERA = { x: 0, y: 0, scale: 1 }
const VIEWPORT = { x: 0, y: 0, w: 100, h: 100 }

function launch(
  launchId: string,
  variantIndex: number,
  variantCount: number,
  projectId = PROJECT_ID,
): GenerationLaunchMeta {
  return {
    launchId,
    variantIndex,
    variantCount,
    projectId,
    promptPreview: 'Нарисуй серию',
    modelName: 'Модель',
    createdAt: 100,
  }
}

function task(
  jobId: string,
  state: GenerationTask['state'],
  variantIndex: number,
  variantCount: number,
  options: { launchId?: string; projectId?: string; legacy?: boolean } = {},
): GenerationTask {
  const projectId = options.projectId ?? PROJECT_ID
  return {
    jobId,
    jobKind: 'image',
    target: { kind: 'canvas', projectId },
    state,
    launch: options.legacy
      ? undefined
      : launch(options.launchId ?? 'launch-a', variantIndex, variantCount, projectId),
    createdAt: 100 + variantIndex,
  }
}

function descriptor(
  variants: GenerationSeriesDescriptor['variants'] = [
    { jobId: 'a', state: 'done' },
    { jobId: 'b', state: 'error' },
  ],
): GenerationSeriesDescriptor {
  return {
    launchId: 'launch-a',
    variantCount: variants.length,
    jobIds: variants.map((variant) => variant.jobId),
    variants,
  }
}

function entry(
  id: string,
  jobId: string,
  x: number,
  phase: GenerationSeriesEntry['phase'] = 'item',
  pendingStatus?: GenerationSeriesEntry['pendingStatus'],
): GenerationSeriesEntry {
  return {
    id,
    jobId,
    phase,
    pendingStatus,
    bounds: { x, y: 10, w: 40, h: 40 },
  }
}

test('partial не terminal, пока другой вариант active', () => {
  const groups = terminalMultiVariantSeries([
    task('a', 'done', 1, 2),
    task('b', 'running', 2, 2),
  ], PROJECT_ID)

  assert.deepEqual(groups, [])
})

test('done + error образуют terminal partial series', () => {
  const groups = terminalMultiVariantSeries([
    task('a', 'done', 1, 2),
    task('b', 'error', 2, 2),
  ], PROJECT_ID)

  assert.deepEqual(groups[0]?.jobIds, ['a', 'b'])
  assert.deepEqual(groups[0]?.variants, [
    { jobId: 'a', state: 'done' },
    { jobId: 'b', state: 'error' },
  ])
})

test('error + cancelled тоже образуют terminal series', () => {
  const groups = terminalMultiVariantSeries([
    task('a', 'error', 1, 2),
    task('b', 'cancelled', 2, 2),
  ], PROJECT_ID)

  assert.deepEqual(groups[0]?.variants, [
    { jobId: 'a', state: 'error' },
    { jobId: 'b', state: 'cancelled' },
  ])
})

test('selector исключает неполную, одиночную, legacy и чужую серии', () => {
  const groups = terminalMultiVariantSeries([
    task('incomplete-a', 'done', 1, 3, { launchId: 'incomplete' }),
    task('incomplete-b', 'cancelled', 2, 3, { launchId: 'incomplete' }),
    task('single', 'done', 1, 1, { launchId: 'single' }),
    task('legacy', 'done', 1, 1, { legacy: true }),
    task('other-a', 'done', 1, 2, { launchId: 'other', projectId: 'project-b' }),
    task('other-b', 'cancelled', 2, 2, { launchId: 'other', projectId: 'project-b' }),
  ], PROJECT_ID)

  assert.deepEqual(groups, [])
})

test('selector принимает только точный уникальный integer-набор variantIndex 1..variantCount', () => {
  const invalidCases: Array<{ name: string; indexes: number[] }> = [
    { name: 'zero', indexes: [0, 2] },
    { name: 'N+1', indexes: [1, 3] },
    { name: 'NaN', indexes: [Number.NaN, 2] },
    { name: 'duplicate', indexes: [1, 1] },
    { name: 'missing', indexes: [1] },
  ]

  for (const invalid of invalidCases) {
    const tasks = invalid.indexes.map((variantIndex, index) => task(
      `${invalid.name}-${index}`,
      'done',
      variantIndex,
      2,
    ))
    assert.deepEqual(terminalMultiVariantSeries(tasks, PROJECT_ID), [], invalid.name)
  }
})

test('handled решение не зависит от геометрии', () => {
  assert.deepEqual(decideSeriesReveal({
    descriptor: descriptor(),
    entries: [],
    handled: true,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  }), { kind: 'handled' })
})

test('недопустимый single или mismatched descriptor fail-closed ждёт', () => {
  const invalid: GenerationSeriesDescriptor = {
    launchId: 'launch-a',
    variantCount: 1,
    jobIds: ['a', 'b'],
    variants: [{ jobId: 'a', state: 'done' }],
  }

  assert.deepEqual(decideSeriesReveal({
    descriptor: invalid,
    entries: [entry('ready-a', 'a', 130)],
    handled: false,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  }), { kind: 'wait' })
})

test('done loading placeholder ещё не готов к геометрическому решению', () => {
  assert.deepEqual(decideSeriesReveal({
    descriptor: descriptor(),
    entries: [entry('pending-a', 'a', 130, 'pending', 'loading')],
    handled: false,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  }), { kind: 'wait' })
})

test('error loading placeholder не превращает видимый done в partial cue', () => {
  assert.deepEqual(decideSeriesReveal({
    descriptor: descriptor(),
    entries: [
      entry('ready-a', 'a', 10),
      entry('loading-b', 'b', 130, 'pending', 'loading'),
    ],
    handled: false,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  }), { kind: 'handled' })
})

test('error и cancelled loading placeholders сами не запускают decision', () => {
  const stopped = descriptor([
    { jobId: 'a', state: 'error' },
    { jobId: 'b', state: 'cancelled' },
  ])

  assert.deepEqual(decideSeriesReveal({
    descriptor: stopped,
    entries: [
      entry('loading-a', 'a', 130, 'pending', 'loading'),
      entry('loading-b', 'b', 180, 'pending', 'loading'),
    ],
    handled: false,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  }), { kind: 'wait' })
})

test('отсутствующая error карточка не блокирует и не считается скрытой', () => {
  assert.deepEqual(decideSeriesReveal({
    descriptor: descriptor(),
    entries: [entry('ready-a', 'a', 10)],
    handled: false,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  }), { kind: 'handled' })
})

test('all-error серия ждёт без карточек и раскрывается по реально оставшимся', () => {
  const failed = descriptor([
    { jobId: 'a', state: 'error' },
    { jobId: 'b', state: 'error' },
  ])
  const base = {
    descriptor: failed,
    handled: false,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  }

  assert.deepEqual(decideSeriesReveal({ ...base, entries: [] }), { kind: 'wait' })
  assert.deepEqual(decideSeriesReveal({
    ...base,
    entries: [entry('error-a', 'a', 130, 'pending', 'error')],
  }), {
    kind: 'reveal',
    launchId: 'launch-a',
    bounds: { x: 130, y: 10, w: 40, h: 40 },
  })
})

test('полностью видимая серия становится handled без движения камеры', () => {
  const complete = descriptor([
    { jobId: 'a', state: 'done' },
    { jobId: 'b', state: 'done' },
  ])

  assert.deepEqual(decideSeriesReveal({
    descriptor: complete,
    entries: [entry('ready-a', 'a', 10), entry('ready-b', 'b', 50)],
    handled: false,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  }), { kind: 'handled' })
})

test('частично видимая серия возвращает cue и не выбирает камеру', () => {
  const decision = decideSeriesReveal({
    descriptor: descriptor(),
    entries: [
      entry('ready-a', 'a', 10),
      entry('error-b', 'b', 130, 'pending', 'error'),
    ],
    handled: false,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  })

  assert.equal(decision.kind, 'cue')
  if (decision.kind === 'cue') {
    assert.deepEqual(decision.assessment.meaningfulVisibleIds, ['ready-a'])
    assert.deepEqual(decision.assessment.hiddenIds, ['error-b'])
    assert.equal(decision.assessment.direction, 'right')
  }
})

test('полностью скрытая серия возвращает reveal общей рамки', () => {
  assert.deepEqual(decideSeriesReveal({
    descriptor: descriptor(),
    entries: [
      entry('ready-a', 'a', 130),
      entry('error-b', 'b', 180, 'pending', 'error'),
    ],
    handled: false,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  }), {
    kind: 'reveal',
    launchId: 'launch-a',
    bounds: { x: 130, y: 10, w: 90, h: 40 },
  })
})

test('manual suppression превращает полностью скрытую серию в cue', () => {
  const decision = decideSeriesReveal({
    descriptor: descriptor(),
    entries: [
      entry('ready-a', 'a', 130),
      entry('error-b', 'b', 180, 'pending', 'error'),
    ],
    handled: false,
    manuallySuppressed: true,
    camera: CAMERA,
    viewport: VIEWPORT,
  })

  assert.equal(decision.kind, 'cue')
  if (decision.kind === 'cue') assert.equal(decision.assessment.hiddenIds.length, 2)
})

test('invalid geometry ждёт исправления вместо исключения', () => {
  const broken = entry('ready-a', 'a', 130)
  broken.bounds.w = Number.NaN

  assert.doesNotThrow(() => decideSeriesReveal({
    descriptor: descriptor(),
    entries: [broken],
    handled: false,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  }))
  assert.deepEqual(decideSeriesReveal({
    descriptor: descriptor(),
    entries: [broken],
    handled: false,
    manuallySuppressed: false,
    camera: CAMERA,
    viewport: VIEWPORT,
  }), { kind: 'wait' })
})

class FakeRaf implements CameraAnimationDeps {
  time = 0
  nextId = 0
  callbacks = new Map<number, FrameRequestCallback>()
  cancelled: number[] = []

  now = (): number => this.time
  requestFrame = (callback: FrameRequestCallback): number => {
    const id = ++this.nextId
    this.callbacks.set(id, callback)
    return id
  }
  cancelFrame = (id: number): void => {
    this.cancelled.push(id)
    this.callbacks.delete(id)
  }
  runNext(timestamp: number): void {
    const next = this.callbacks.entries().next().value as [number, FrameRequestCallback] | undefined
    assert.ok(next, `ожидался RAF на ${timestamp} ms`)
    this.callbacks.delete(next[0])
    this.time = timestamp
    next[1](timestamp)
  }
}

class FakeSeriesStore implements GenerationSeriesRevealCoordinatorStore {
  camera: CanvasCamera = { x: 0, y: 0, scale: 1 }
  targetCamera: CanvasCamera | null = { x: -200, y: -100, scale: 0.5 }
  entries: GenerationSeriesEntry[] = []
  entriesByLaunch = new Map<string, GenerationSeriesEntry[]>()
  targetsByLaunch = new Map<string, CanvasCamera | null>()
  handled = new Set<string>()
  marked: string[] = []
  cameraUpdates: CanvasCamera[] = []
  targetRequests: string[] = []
  safeViewports: Array<{ x: number; y: number; w: number; h: number }> = []
  generationFocus: string[] = []
  private contentListeners = new Set<() => void>()
  private cameraListeners = new Set<() => void>()
  private manualListeners = new Set<() => void>()
  private generationFocusListeners = new Set<() => void>()

  getCamera = (): CanvasCamera => ({ ...this.camera })
  setCamera = (camera: CanvasCamera): void => {
    this.camera = { ...camera }
    this.cameraUpdates.push({ ...camera })
    this.cameraListeners.forEach((listener) => listener())
  }
  getGenerationSeriesEntries = (launchId: string): GenerationSeriesEntry[] => (
    this.entriesByLaunch.get(launchId) ?? this.entries
  ).map((value) => ({ ...value, bounds: { ...value.bounds } }))
  getGenerationSeriesTargetCamera = (launchId: string): CanvasCamera | null => {
    this.targetRequests.push(launchId)
    const target = this.targetsByLaunch.has(launchId)
      ? this.targetsByLaunch.get(launchId)
      : this.targetCamera
    return target ? { ...target } : null
  }
  setGenerationSafeViewport = (viewport: { x: number; y: number; w: number; h: number }): void => {
    this.safeViewports.push({ ...viewport })
  }
  hasHandledGenerationLaunch = (launchId: string): boolean => this.handled.has(launchId)
  markGenerationLaunchHandled = (launchId: string): boolean => {
    if (this.handled.has(launchId)) return false
    this.handled.add(launchId)
    this.marked.push(launchId)
    this.contentListeners.forEach((listener) => listener())
    return true
  }
  subscribeContent = (listener: () => void): (() => void) => {
    this.contentListeners.add(listener)
    return () => this.contentListeners.delete(listener)
  }
  subscribeCamera = (listener: () => void): (() => void) => {
    this.cameraListeners.add(listener)
    return () => this.cameraListeners.delete(listener)
  }
  subscribeManualCamera = (listener: () => void): (() => void) => {
    this.manualListeners.add(listener)
    return () => this.manualListeners.delete(listener)
  }
  getGenerationFocus = (): string[] => [...this.generationFocus]
  subscribeGenerationFocus = (listener: () => void): (() => void) => {
    this.generationFocusListeners.add(listener)
    return () => this.generationFocusListeners.delete(listener)
  }
  emitManual(): void {
    this.manualListeners.forEach((listener) => listener())
  }
  emitGenerationFocus(ids: string[]): void {
    this.generationFocus = [...ids]
    this.generationFocusListeners.forEach((listener) => listener())
  }
}

function taskSource(initial: GenerationTask[]) {
  let tasks = initial
  const listeners = new Set<() => void>()
  return {
    get: () => tasks,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(next = tasks): void {
      tasks = next
      listeners.forEach((listener) => listener())
    },
  }
}

function terminalTasks(count = 4, projectId = PROJECT_ID): GenerationTask[] {
  return Array.from({ length: count }, (_, index) => task(
    `job-${index + 1}`,
    'done',
    index + 1,
    count,
    { projectId },
  ))
}

function terminalEntries(count = 4, firstX = 180): GenerationSeriesEntry[] {
  return Array.from({ length: count }, (_, index) => entry(
    `item-${index + 1}`,
    `job-${index + 1}`,
    firstX + index * 50,
  ))
}

function coordinatorFixture(options: {
  entries?: GenerationSeriesEntry[]
  handled?: boolean
  reducedMotion?: boolean
} = {}) {
  const store = new FakeSeriesStore()
  store.entries = options.entries ?? terminalEntries()
  if (options.handled) store.handled.add('launch-a')
  const tasks = taskSource(terminalTasks())
  const raf = new FakeRaf()
  const coordinator = createGenerationSeriesRevealCoordinator({
    store,
    projectId: PROJECT_ID,
    viewport: VIEWPORT,
    obstacles: [],
    enabled: true,
    getTasks: tasks.get,
    subscribeTasks: tasks.subscribe,
    animationDeps: raf,
    reducedMotion: options.reducedMotion ?? false,
  })
  return { store, tasks, raf, coordinator }
}

function competingSeriesFixture(options: { secondInitially?: boolean } = {}) {
  const store = new FakeSeriesStore()
  store.entriesByLaunch.set('launch-a', [
    entry('item-a-1', 'job-a-1', 180),
    entry('item-a-2', 'job-a-2', 230),
  ])
  store.entriesByLaunch.set('launch-b', [
    entry('item-b-1', 'job-b-1', 680),
    entry('item-b-2', 'job-b-2', 730),
  ])
  store.targetsByLaunch.set('launch-a', { x: -100, y: -50, scale: 0.75 })
  store.targetsByLaunch.set('launch-b', { x: -600, y: -300, scale: 0.5 })
  const allTasks = [
    task('job-a-1', 'done', 1, 2, { launchId: 'launch-a' }),
    task('job-a-2', 'done', 2, 2, { launchId: 'launch-a' }),
    task('job-b-1', 'done', 1, 2, { launchId: 'launch-b' }),
    task('job-b-2', 'done', 2, 2, { launchId: 'launch-b' }),
  ]
  const tasks = taskSource(options.secondInitially === false ? allTasks.slice(0, 2) : allTasks)
  const raf = new FakeRaf()
  const coordinator = createGenerationSeriesRevealCoordinator({
    store,
    projectId: PROJECT_ID,
    viewport: VIEWPORT,
    obstacles: [],
    enabled: true,
    getTasks: tasks.get,
    subscribeTasks: tasks.subscribe,
    animationDeps: raf,
    reducedMotion: false,
  })
  return { store, tasks, allTasks, raf, coordinator }
}

test('terminal 4× полностью offscreen планирует ровно один reveal', () => {
  const { tasks, raf, coordinator } = coordinatorFixture()

  assert.equal(raf.callbacks.size, 1)
  tasks.emit()
  assert.equal(raf.callbacks.size, 1)
  assert.deepEqual(coordinator.getCues(), [])
  coordinator.dispose()
})

test('две скрытые terminal серии делят один auto RAF, а конкурент остаётся cue без ack', () => {
  const { store, raf, coordinator } = competingSeriesFixture()

  assert.equal(raf.callbacks.size, 1)
  assert.deepEqual(coordinator.getCues().map((cue) => cue.launchId), ['launch-b'])
  raf.runNext(0)
  raf.runNext(240)

  assert.deepEqual(store.marked, ['launch-a'])
  assert.equal(store.handled.has('launch-b'), false)
  assert.deepEqual(coordinator.getCues().map((cue) => cue.launchId), ['launch-b'])
  assert.equal(raf.callbacks.size, 0)
  coordinator.dispose()
})

test('manual event между plan и RAF отменяет reveal и оставляет cue', () => {
  const { store, raf, coordinator } = coordinatorFixture()

  store.emitManual()

  assert.deepEqual(raf.cancelled, [1])
  assert.equal(raf.callbacks.size, 0)
  assert.equal(store.cameraUpdates.length, 0)
  assert.equal(coordinator.getCues().length, 1)
  assert.equal(coordinator.getCues()[0]?.hiddenCount, 4)
  coordinator.dispose()
})

test('Task Center focus A глобально отменяет и suppress competing auto reveal B', () => {
  const { store, raf, coordinator } = competingSeriesFixture()
  const stalePlannedFrames = [...raf.callbacks.values()]
  assert.equal(stalePlannedFrames.length, 1)

  store.markGenerationLaunchHandled('launch-a')
  store.emitGenerationFocus(['item-a-1', 'item-a-2'])
  stalePlannedFrames.forEach((callback) => callback(0))
  ;[...raf.callbacks.values()].forEach((callback) => callback(240))

  assert.deepEqual(raf.cancelled, [1])
  assert.equal(raf.callbacks.size, 0)
  assert.deepEqual(store.cameraUpdates, [])
  assert.deepEqual(store.marked, ['launch-a'])
  assert.deepEqual(coordinator.getCues().map((cue) => cue.launchId), ['launch-b'])
  coordinator.dispose()
})

test('explicit showSeries A оставляет только explicit RAF и не ack competing B', () => {
  const { store, raf, coordinator } = competingSeriesFixture()
  assert.equal(raf.callbacks.size, 1)

  coordinator.showSeries('launch-a')

  assert.deepEqual(raf.cancelled, [1])
  assert.equal(raf.callbacks.size, 1)
  raf.runNext(240)
  assert.deepEqual(store.camera, { x: -100, y: -50, scale: 0.75 })
  assert.deepEqual(store.marked, ['launch-a'])
  assert.equal(store.handled.has('launch-b'), false)
  assert.deepEqual(coordinator.getCues().map((cue) => cue.launchId), ['launch-b'])
  coordinator.dispose()
})

test('terminal hidden B, пришедшая во время explicit A, остаётся cue без auto RAF и ack', () => {
  const { store, tasks, allTasks, raf, coordinator } = competingSeriesFixture({
    secondInitially: false,
  })

  coordinator.showSeries('launch-a')
  assert.equal(raf.callbacks.size, 1)
  tasks.emit(allTasks)

  assert.equal(raf.callbacks.size, 1)
  assert.deepEqual(coordinator.getCues().map((cue) => cue.launchId), ['launch-b'])
  raf.runNext(240)
  assert.deepEqual(store.marked, ['launch-a'])
  assert.equal(store.handled.has('launch-b'), false)
  assert.deepEqual(coordinator.getCues().map((cue) => cue.launchId), ['launch-b'])
  assert.equal(raf.callbacks.size, 0)
  coordinator.dispose()
})

test('успешный reveal пишет durable ack только после финального frame', () => {
  const { store, raf, coordinator } = coordinatorFixture()

  raf.runNext(0)
  assert.deepEqual(store.marked, [])
  raf.runNext(120)
  assert.deepEqual(store.marked, [])
  raf.runNext(240)

  assert.deepEqual(store.camera, { x: -200, y: -100, scale: 0.5 })
  assert.deepEqual(store.marked, ['launch-a'])
  coordinator.dispose()
})

test('ResizeObserver update не отменяет уже начатый auto reveal на промежуточной камере', () => {
  const { store, raf, coordinator } = coordinatorFixture()
  store.targetCamera = { x: -200, y: 0, scale: 0.5 }

  raf.runNext(0)
  raf.runNext(120)
  coordinator.update({ viewport: { ...VIEWPORT } })

  assert.equal(raf.callbacks.size, 1, 'финальный animation frame должен остаться запланирован')
  assert.deepEqual(coordinator.getCues(), [])
  raf.runNext(240)
  assert.deepEqual(store.camera, { x: -200, y: 0, scale: 0.5 })
  assert.deepEqual(store.marked, ['launch-a'])
  coordinator.dispose()
})

test('изменившийся safe viewport отменяет старый target и refit делает по текущему viewport', () => {
  const { store, raf, coordinator } = coordinatorFixture()
  store.targetCamera = { x: -200, y: 0, scale: 0.5 }

  raf.runNext(0)
  const staleFrame = [...raf.callbacks.values()][0]
  assert.ok(staleFrame)
  store.targetCamera = { x: -60, y: -20, scale: 0.8 }
  coordinator.update({ viewport: { x: 10, y: 5, w: 80, h: 70 } })

  assert.deepEqual(raf.cancelled, [2])
  staleFrame(240)
  assert.deepEqual(store.cameraUpdates, [])
  assert.deepEqual(store.marked, [])
  raf.runNext(0)
  raf.runNext(240)
  assert.deepEqual(store.camera, { x: -60, y: -20, scale: 0.8 })
  assert.deepEqual(store.marked, ['launch-a'])
  coordinator.dispose()
})

test('совпавший target всё равно получает ack только после временного final frame', () => {
  const { store, raf, coordinator } = coordinatorFixture()
  store.targetCamera = { x: 0, y: 0, scale: 1 }

  raf.runNext(0)
  raf.runNext(120)
  assert.deepEqual(store.marked, [])
  raf.runNext(240)

  assert.deepEqual(store.marked, ['launch-a'])
  coordinator.dispose()
})

test('null safe target не создаёт бесконечную цепочку RAF', () => {
  const { store, raf, coordinator } = coordinatorFixture()
  store.targetCamera = null

  raf.runNext(0)

  assert.equal(raf.callbacks.size, 0)
  assert.deepEqual(store.marked, [])
  assert.deepEqual(coordinator.getCues(), [])
  coordinator.dispose()
})

test('manual cancel начатой animation не пишет durable ack', () => {
  const { store, raf, coordinator } = coordinatorFixture()

  raf.runNext(0)
  raf.runNext(120)
  store.emitManual()

  assert.deepEqual(raf.cancelled, [3])
  assert.equal(raf.callbacks.size, 0)
  assert.deepEqual(store.marked, [])
  assert.equal(coordinator.getCues().length, 1)
  coordinator.dispose()
})

test('fully visible terminal series отмечается handled без camera frame', () => {
  const visible = terminalEntries().map((value, index) => ({
    ...value,
    bounds: { ...value.bounds, x: 5 + index * 18 },
  }))
  const { store, raf, coordinator } = coordinatorFixture({ entries: visible })

  assert.deepEqual(store.marked, ['launch-a'])
  assert.deepEqual(store.cameraUpdates, [])
  assert.equal(raf.callbacks.size, 0)
  coordinator.dispose()
})

test('reduced motion применяет один final frame и затем ack', () => {
  const { store, raf, coordinator } = coordinatorFixture({ reducedMotion: true })

  raf.runNext(0)

  assert.deepEqual(store.cameraUpdates, [{ x: -200, y: -100, scale: 0.5 }])
  assert.deepEqual(store.marked, ['launch-a'])
  assert.equal(raf.callbacks.size, 0)
  coordinator.dispose()
})

test('reload с handled id не планирует и повторно не отмечает серию', () => {
  const { store, raf, coordinator } = coordinatorFixture({ handled: true })

  assert.equal(raf.callbacks.size, 0)
  assert.deepEqual(store.marked, [])
  assert.deepEqual(coordinator.getCues(), [])
  coordinator.dispose()
})

test('смена projectId отменяет pending и in-flight RAF', () => {
  const pending = coordinatorFixture()
  pending.coordinator.update({ projectId: 'project-b' })
  assert.deepEqual(pending.raf.cancelled, [1])
  assert.equal(pending.raf.callbacks.size, 0)
  pending.coordinator.dispose()

  const inFlight = coordinatorFixture()
  inFlight.raf.runNext(0)
  assert.equal(inFlight.raf.callbacks.size, 1)
  inFlight.coordinator.update({ projectId: 'project-b' })
  assert.deepEqual(inFlight.raf.cancelled, [2])
  assert.equal(inFlight.raf.callbacks.size, 0)
  assert.deepEqual(inFlight.store.marked, [])
  inFlight.coordinator.dispose()
})

test('partial visible оставляет camera byte-for-byte и публикует cue', () => {
  const visible = terminalEntries()
  visible[0] = entry('item-1', 'job-1', 10)
  const { store, raf, coordinator } = coordinatorFixture({ entries: visible })

  assert.equal(raf.callbacks.size, 0)
  assert.deepEqual(store.cameraUpdates, [])
  assert.equal(coordinator.getCues()[0]?.hiddenCount, 3)
  coordinator.dispose()
})

test('explicit showSeries использует safe target и отмечает handled на final frame', () => {
  const visible = terminalEntries()
  visible[0] = entry('item-1', 'job-1', 10)
  const { store, raf, coordinator } = coordinatorFixture({ entries: visible })

  coordinator.showSeries('launch-a')
  assert.deepEqual(store.marked, [])
  assert.deepEqual(store.targetRequests, ['launch-a'])
  raf.runNext(240)

  assert.deepEqual(store.camera, { x: -200, y: -100, scale: 0.5 })
  assert.deepEqual(store.marked, ['launch-a'])
  assert.deepEqual(coordinator.getCues(), [])
  coordinator.dispose()
})

test('coordinator синхронизирует safe viewport со store при create и update', () => {
  const { store, coordinator } = coordinatorFixture({ handled: true })

  assert.deepEqual(store.safeViewports, [VIEWPORT])
  coordinator.update({ viewport: { x: 20, y: 10, w: 640, h: 480 } })
  assert.deepEqual(store.safeViewports, [
    VIEWPORT,
    { x: 20, y: 10, w: 640, h: 480 },
  ])
  coordinator.dispose()
})

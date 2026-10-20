import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../api'
import type { Job } from '../../types'
import {
  createGenerationRegistry,
  type GenerationTarget,
  type RestoredGenerationTask,
} from './generationRegistry'
import type { GenerationLaunchMeta } from './generationLaunches'

const LAUNCH: GenerationLaunchMeta = {
  launchId: 'launch-1',
  variantIndex: 2,
  variantCount: 4,
  projectId: 'project-launch',
  projectName: 'Доска',
  promptPreview: 'Нарисуй маяк',
  modelId: 'fal/image',
  modelName: 'Модель',
  estimatedTotalCostUsd: 0.16,
  createdAt: 100,
}

function doneJob(id: string, kind: Job['kind'] = 'image'): Job {
  return {
    id,
    kind,
    prompt: 'test',
    status: 'done',
    result: kind === 'text' ? { text: 'answer' } : { url: '/media/result.png' },
  }
}

function makeRegistry(
  getJob: (id: string) => Promise<Job>,
  generate?: (request: Parameters<NonNullable<import('./generationRegistry').GenerationRegistryDeps['generate']>>[0]) => Promise<{ jobId: string }>,
) {
  const cancelled: string[] = []
  const registry = createGenerationRegistry({
    getJob,
    cancelJob: async (id) => {
      cancelled.push(id)
    },
    generate,
    schedule: () => 1,
    unschedule: () => {},
  })
  return { registry, cancelled }
}

test('routes canvas and prompt-chat jobs only to their target channel', async () => {
  const jobs = new Map<string, Job>([
    ['canvas-job', doneJob('canvas-job')],
    ['chat-job', doneJob('chat-job', 'text')],
  ])
  const { registry } = makeRegistry(async (id) => jobs.get(id)!)
  const canvasDeliveries: Array<{ job: Job; target: GenerationTarget }> = []
  const chatDeliveries: Array<{ job: Job; target: GenerationTarget }> = []

  registry.registerGenerationSink('canvas', 'project-1', (job, target) => {
    canvasDeliveries.push({ job, target })
  })
  registry.registerGenerationSink('prompt-chat', 'project-1', (job, target) => {
    chatDeliveries.push({ job, target })
  })

  registry.trackGeneration({ kind: 'canvas', projectId: 'project-1' }, 'canvas-job', 'image')
  registry.trackGeneration({
    kind: 'prompt-chat',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    messageId: 'assistant-1',
  }, 'chat-job', 'text')
  await registry.pollNow()

  assert.deepEqual(canvasDeliveries.map(({ job }) => job.id), ['canvas-job'])
  assert.deepEqual(chatDeliveries.map(({ job }) => job.id), ['chat-job'])
  assert.equal(chatDeliveries[0].target.kind, 'prompt-chat')
  if (chatDeliveries[0].target.kind === 'prompt-chat') {
    assert.equal(chatDeliveries[0].target.messageId, 'assistant-1')
  }
})

test('parks a completed job until its channel registers and flushes it once', async () => {
  const { registry } = makeRegistry(async (id) => doneJob(id, 'text'))
  registry.trackGeneration({
    kind: 'prompt-chat',
    projectId: 'project-2',
    conversationId: 'conversation-2',
    messageId: 'assistant-2',
  }, 'parked-job', 'text')
  await registry.pollNow()

  const delivered: string[] = []
  const unregister = registry.registerGenerationSink('prompt-chat', 'project-2', (job) => {
    delivered.push(job.id)
  })
  assert.deepEqual(delivered, ['parked-job'])

  unregister()
  registry.registerGenerationSink('prompt-chat', 'project-2', (job) => {
    delivered.push(job.id)
  })
  assert.deepEqual(delivered, ['parked-job'])
})

test('uses tracked job kind for a missing server job', async () => {
  const { registry } = makeRegistry(async () => {
    throw new ApiError('missing', undefined, 404)
  })
  const delivered: Job[] = []
  registry.registerGenerationSink('prompt-chat', 'project-3', (job) => delivered.push(job))
  registry.trackGeneration({
    kind: 'prompt-chat',
    projectId: 'project-3',
    conversationId: 'conversation-3',
    messageId: 'assistant-3',
  }, 'missing-job', 'text')

  await registry.pollNow()

  assert.equal(delivered[0].kind, 'text')
  assert.equal(delivered[0].status, 'error')
  assert.match(delivered[0].error ?? '', /task was not found on the server/)
})

test('temporary status failures keep the paid job recoverable until it is done', async () => {
  let attempts = 0
  const delivered: Job[] = []
  const target = { kind: 'canvas' as const, projectId: 'project-reconnect' }
  const registry = createGenerationRegistry({
    getJob: async (id) => {
      attempts++
      // A short-lived auth/network failure must not be treated as a missing
      // job. Keep enough failures to cross the former arbitrary cutoff.
      if (attempts <= 41) throw new ApiError('temporary offline', 'TEMPORARY', 403)
      if (attempts === 42) return { id, kind: 'image', prompt: '', status: 'running' }
      return doneJob(id)
    },
    cancelJob: async () => {},
    schedule: () => 1,
    unschedule: () => {},
  })
  registry.registerGenerationSink('canvas', target.projectId, (job) => delivered.push(job))
  registry.trackGeneration(target, 'reconnect-job', 'image')

  for (let i = 0; i < 41; i++) await registry.pollNow()

  const reconnecting = registry.getSnapshot().find((task) => task.jobId === 'reconnect-job')
  assert.equal(reconnecting?.state, 'queued')
  assert.equal(reconnecting?.connection, 'reconnecting')
  assert.equal(reconnecting?.error, undefined)

  await registry.pollNow()
  const resumed = registry.getSnapshot().find((task) => task.jobId === 'reconnect-job')
  assert.equal(resumed?.state, 'running')
  assert.equal(resumed?.connection, undefined)

  await registry.pollNow()
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.id, 'reconnect-job')
  assert.equal(registry.getSnapshot().find((task) => task.jobId === 'reconnect-job')?.state, 'done')
  assert.equal(registry.getSnapshot().find((task) => task.jobId === 'reconnect-job')?.connection, undefined)

  await registry.pollNow()
  assert.equal(attempts, 43, 'после результата задача больше не опрашивается')
  assert.equal(delivered.length, 1, 'результат доставляется один раз')
  registry.dispose()
})

test('dispose removes the visibility listener owned by the registry', () => {
  let visibilityListener: (() => void) | undefined
  let unsubscribeCalls = 0
  const registry = createGenerationRegistry({
    getJob: async (id) => doneJob(id),
    cancelJob: async () => {},
    schedule: () => 1,
    unschedule: () => {},
    visibility: {
      isHidden: () => false,
      subscribe(listener) {
        visibilityListener = listener
        return () => {
          unsubscribeCalls += 1
        }
      },
    },
  })

  assert.equal(typeof visibilityListener, 'function')
  registry.dispose()
  assert.equal(unsubscribeCalls, 1)
})

test('deduplicates tracking and cancels through the shared registry', async () => {
  let reads = 0
  const { registry, cancelled } = makeRegistry(async (id) => {
    reads++
    if (id === 'cancel-ok-job') {
      return { id, kind: 'image', prompt: '', status: 'error', error: 'отменено' }
    }
    return doneJob(id)
  })
  const target = { kind: 'canvas' as const, projectId: 'project-4' }

  registry.trackGeneration(target, 'same-job', 'image')
  registry.trackGeneration(target, 'same-job', 'image')
  await registry.pollNow()
  assert.equal(reads, 1)

  const delivered: Job[] = []
  registry.registerGenerationSink('canvas', 'project-4', (job) => delivered.push(job))

  registry.trackGeneration(target, 'same-job', 'image')
  await registry.pollNow()
  assert.equal(reads, 1, 'завершённую задачу нельзя повторно ставить на polling')
  assert.equal(delivered.length, 1, 'готовый результат нельзя доставлять повторно')

  // отмена успела: сервер подтвердил «отменено», финал доставляет обычный опрос
  registry.trackGeneration(target, 'cancel-ok-job', 'image')
  await registry.cancelGeneration('cancel-ok-job')
  assert.deepEqual(cancelled, ['cancel-ok-job'])
  assert.equal(registry.getSnapshot().find((item) => item.jobId === 'cancel-ok-job')?.state, 'cancelling')
  await registry.pollNow()
  const cancelledJob = delivered.find((job) => job.id === 'cancel-ok-job')
  assert.equal(cancelledJob?.status, 'error')
  assert.equal(cancelledJob?.error, 'отменено')

  // отмена не успела: генерация уже оплачена — реестр продолжает опрос и
  // доставляет готовый результат, а не выбрасывает его
  registry.trackGeneration(target, 'cancel-late-job', 'image')
  await registry.cancelGeneration('cancel-late-job')
  await registry.pollNow()
  const lateJob = delivered.find((job) => job.id === 'cancel-late-job')
  assert.equal(lateJob?.status, 'done')
  assert.equal(registry.getSnapshot().find((item) => item.jobId === 'cancel-late-job')?.state, 'done')
})

test('intermediate running poll does not overwrite the cancelling state', async () => {
  let polls = 0
  const { registry } = makeRegistry(async (id) => {
    polls++
    // сервер при мягкой отмене какое-то время продолжает отвечать running
    if (polls < 3) return { id, kind: 'image', prompt: '', status: 'running' }
    return { id, kind: 'image', prompt: '', status: 'error', error: 'отменено' }
  })
  const target = { kind: 'canvas' as const, projectId: 'project-7' }
  registry.trackGeneration(target, 'soft-cancel-job', 'image')
  await registry.pollNow()
  await registry.cancelGeneration('soft-cancel-job')
  await registry.pollNow()
  // «Останавливается…» держится, пока сервер не дал финал
  assert.equal(registry.getSnapshot().find((item) => item.jobId === 'soft-cancel-job')?.state, 'cancelling')
  await registry.pollNow()
  assert.equal(registry.getSnapshot().find((item) => item.jobId === 'soft-cancel-job')?.state, 'cancelled')
})

test('cancelling an already settled task keeps its terminal state', async () => {
  const { registry, cancelled } = makeRegistry(async (id) => doneJob(id))
  const target = { kind: 'canvas' as const, projectId: 'project-8' }
  registry.trackGeneration(target, 'settled-job', 'image')
  await registry.pollNow()
  await registry.cancelGeneration('settled-job')
  assert.deepEqual(cancelled, [])
  assert.equal(registry.getSnapshot().find((item) => item.jobId === 'settled-job')?.state, 'done')
})

test('publishes task snapshots for a global task centre', async () => {
  const { registry } = makeRegistry(async (id) => doneJob(id))
  const snapshots: string[][] = []
  registry.subscribe(() => {
    snapshots.push(registry.getSnapshot().map((item) => `${item.jobId}:${item.state}`))
  })

  registry.trackGeneration({ kind: 'canvas', projectId: 'project-5' }, 'visible-job', 'image')
  await registry.pollNow()

  assert.deepEqual(snapshots, [
    ['visible-job:queued'],
    ['visible-job:done'],
  ])
})

test('сохраняет метаданные варианта при регистрации задачи', () => {
  const { registry } = makeRegistry(async (id) => doneJob(id))
  const target = { kind: 'canvas' as const, projectId: LAUNCH.projectId }

  registry.trackGeneration(target, 'launch-job', 'image', undefined, LAUNCH)

  assert.deepEqual(registry.getSnapshot()[0].launch, LAUNCH)
})

test('показывает локальный сбой старта и позволяет повторить его без polling', async () => {
  let scheduled = 0
  const retry = { kind: 'image' as const, prompt: 'Маяк', refs: [] }
  const target = { kind: 'canvas' as const, projectId: LAUNCH.projectId }
  const registry = createGenerationRegistry({
    getJob: async (id) => doneJob(id),
    cancelJob: async () => {},
    generate: async () => ({ jobId: 'server-job' }),
    schedule: () => ++scheduled,
    unschedule: () => {},
  })

  const localId = registry.trackFailedGeneration(
    target,
    'image',
    retry,
    LAUNCH,
    'Сервер недоступен',
  )

  assert.match(localId, /^local:/)
  assert.equal(scheduled, 0)
  assert.deepEqual(registry.getSnapshot()[0], {
    jobId: localId,
    jobKind: 'image',
    target,
    state: 'error',
    error: 'Сервер недоступен',
    retry,
    launch: LAUNCH,
    createdAt: registry.getSnapshot()[0].createdAt,
  })

  const retriedId = await registry.retryGeneration(localId)

  assert.equal(retriedId, 'server-job')
  assert.equal(scheduled, 1)
  assert.deepEqual(
    registry.getSnapshot().find((task) => task.jobId === 'server-job')?.launch,
    LAUNCH,
  )
})

test('восстанавливает терминальные задачи без polling и повторной доставки', () => {
  let scheduled = 0
  let deliveries = 0
  const target = { kind: 'canvas' as const, projectId: LAUNCH.projectId }
  const registry = createGenerationRegistry({
    getJob: async (id) => doneJob(id),
    cancelJob: async () => {},
    schedule: () => ++scheduled,
    unschedule: () => {},
  })
  registry.registerGenerationSink('canvas', target.projectId, () => {
    deliveries++
  })
  const restored = [
    { jobId: 'done-restored', state: 'done' as const, createdAt: 101 },
    { jobId: 'error-restored', state: 'error' as const, createdAt: 102 },
    { jobId: 'cancelled-restored', state: 'cancelled' as const, createdAt: 103 },
  ].map((task): RestoredGenerationTask => ({
    ...task,
    jobKind: 'image',
    target,
    launch: LAUNCH,
  }))

  for (const task of restored) registry.restoreGenerationTask(task)

  assert.deepEqual(
    registry.getSnapshot().map((task) => `${task.jobId}:${task.state}`),
    ['cancelled-restored:cancelled', 'error-restored:error', 'done-restored:done'],
  )
  assert.equal(scheduled, 0)
  assert.equal(deliveries, 0)
})

test('retries a failed task with its frozen generation request', async () => {
  const requests: unknown[] = []
  const { registry } = makeRegistry(
    async (id) =>
      id === 'failed-job'
        ? { id, kind: 'image', prompt: 'poster', status: 'error', error: 'network' }
        : doneJob(id),
    async (request) => {
      requests.push(request)
      return { jobId: 'retry-job' }
    },
  )
  const target = { kind: 'canvas' as const, projectId: 'project-6' }
  const launchMeta = { ...LAUNCH, projectId: target.projectId }
  const retry = {
    kind: 'image' as const,
    prompt: 'poster',
    refs: [],
    model: 'fal/image',
    params: { aspect_ratio: '1:1' },
  }

  registry.trackGeneration(target, 'failed-job', 'image', retry, launchMeta)
  await registry.pollNow()
  const retriedId = await registry.retryGeneration('failed-job')

  assert.equal(retriedId, 'retry-job')
  assert.deepEqual(requests, [retry])
  assert.equal(registry.getSnapshot().find((task) => task.jobId === 'retry-job')?.state, 'queued')
  assert.deepEqual(
    registry.getSnapshot().find((task) => task.jobId === 'retry-job')?.launch,
    launchMeta,
  )
})

test('двойной клик по «Повторить» не оплачивает две генерации', async () => {
  // Кнопка «Повторить» не гасится на время запроса, а сам запрос сетевой.
  // Два быстрых клика уходили в deps.generate дважды — это две ОПЛАЧЕННЫЕ
  // задачи вместо одной и два результата на холсте.
  const requests: unknown[] = []
  const pending: Array<(value: { jobId: string }) => void> = []

  const { registry } = makeRegistry(
    async (id) =>
      id === 'failed-job'
        ? { id, kind: 'image', prompt: 'test', status: 'error', error: 'сеть' }
        : doneJob(id),
    async (request) => {
      requests.push(request)
      // держим повтор «в полёте», как настоящий сетевой запрос
      return new Promise<{ jobId: string }>((resolve) => {
        pending.push(resolve)
      })
    },
  )
  const target = { kind: 'canvas' as const, projectId: 'project-retry-twice' }
  const retry = {
    kind: 'image' as const,
    prompt: 'poster',
    refs: [],
    model: 'fal/image',
    params: {},
  }

  registry.trackGeneration(target, 'failed-job', 'image', retry)
  await registry.pollNow()

  const settle = (promise: Promise<string>) =>
    promise.then(
      (id) => ({ ok: true as const, id }),
      (error: unknown) => ({ ok: false as const, error }),
    )

  const first = settle(registry.retryGeneration('failed-job'))
  // второй клик, пока первый ещё не ответил
  const second = settle(registry.retryGeneration('failed-job'))

  // отпускаем все запросы, которые всё-таки ушли
  for (const resolve of pending) resolve({ jobId: 'retry-job' })
  const [firstOutcome, secondOutcome] = await Promise.all([first, second])

  assert.equal(requests.length, 1, 'вторая генерация не должна была уйти на сервер')
  assert.equal(firstOutcome.ok, true, 'первый повтор обязан состояться')
  assert.equal(secondOutcome.ok, false, 'повторный клик обязан честно отказать, а не платить')
})

test('перепривязка не заводит вторую задачу и не теряет первую', () => {
  const { registry } = makeRegistry(async (id) => doneJob(id))
  registry.trackGeneration({ kind: 'canvas', projectId: 'project-1' }, 'job-a', 'image')
  registry.rebindGeneration('job-a', 'job-a')
  assert.deepEqual(registry.getSnapshot().map((task) => task.jobId), ['job-a'], 'тот же номер — ничего не меняем')
  registry.rebindGeneration('нет-такой', 'job-b')
  assert.deepEqual(registry.getSnapshot().map((task) => task.jobId), ['job-a'], 'неизвестная задача не появляется')
})

// ⚠️ «Отменена» — финал сервера команды, которого нет в нашем словаре
// статусов. Без этой ветки отменённая задача крутилась бы в опросе вечно.
test('отменённая на сервере команды задача считается законченной, а не ошибкой', async () => {
  const cancelled = { id: 'job-c', kind: 'image', prompt: 'test', status: 'cancelled' } as unknown as Job
  const { registry } = makeRegistry(async () => cancelled)
  registry.trackGeneration({ kind: 'canvas', projectId: 'project-1' }, 'job-c', 'image')
  await registry.pollNow()
  assert.deepEqual(registry.getSnapshot().map((task) => task.state), ['cancelled'])
  await registry.pollNow()
  assert.deepEqual(registry.getSnapshot().map((task) => task.state), ['cancelled'], 'опрос обязан прекратиться')
})

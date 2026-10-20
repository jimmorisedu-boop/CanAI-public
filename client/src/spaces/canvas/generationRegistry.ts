import { api, ApiError, type JobWaitEntry } from '../../api'
import { log } from '../../diag/log'
import {
  JOB_LOST,
  POLL_HIDDEN_MS,
  POLL_MS,
} from './jobPolling'
import type { GenRef, Job, JobKind, ProjectRef } from '../../types'
import type { GenerationLaunchMeta } from './generationLaunches'
import { newId } from '../../ui/ids'


export type GenerationTarget =
  | {
      kind: 'canvas'
      projectId: string
      /**
       * Карточка, в которую запущена генерация. ⚠️ Номер задачи на карточке
       * бывает потерян: местный номер нашего сервера на общую доску не едет,
       * и свежий снимок после переподключения его стирает. Тогда карточку
       * находят по её собственному номеру — так же, как сервер команды
       * (`placeholder_id` у задачи). Без этого готовый результат вставал
       * копией рядом с карточкой (30.09.2026).
       */
      placeholderId?: string
    }
  | {
      kind: 'prompt-chat'
      projectId: string
      conversationId: string
      messageId: string
    }

export type GenerationChannel = GenerationTarget['kind']
export type GenerationSink = (job: Job, target: GenerationTarget) => void

interface Tracked {
  jobId: string
  jobKind: JobKind
  target: GenerationTarget
  errors: number
  /** О номере задачи на сервере команды сообщаем один раз. */
  cloudJobAnnounced?: boolean
  /** Тот самый номер — чтобы напомнить о нём доске, открытой позже. */
  cloudJobId?: string
  /** Отметка последнего увиденного состояния: сервер ждёт, пока она сменится. */
  version?: string
}

/** Состояние связи с сервером для ещё не завершённой задачи. */
export type GenerationTaskConnection = 'reconnecting' | 'delivery-error'

/** Короткая подпись для карточек, которые показывают живую задачу. */
export function generationConnectionLabel(connection?: GenerationTaskConnection): string | null {
  if (connection === 'reconnecting') return "Reconnecting…"
  if (connection === 'delivery-error') return "Delivery error"
  return null
}

export type GenerationTaskState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'done'
  | 'error'

export interface GenerationTask {
  jobId: string
  jobKind: JobKind
  target: GenerationTarget
  state: GenerationTaskState
  // Не подменяет state задачи: при временном отказе последняя известная
  // queued/running стадия сохраняется, а UI может отдельно показать
  // восстановление связи. Терминальные задачи этого поля не имеют.
  connection?: GenerationTaskConnection
  error?: string
  retry?: GenerationRetryDescriptor
  launch?: GenerationLaunchMeta
  /**
   * Сколько списали НА САМОМ ДЕЛЕ.
   *
   * ⚠️ У моделей с тарифом «по факту» цену заранее может не знать никто:
   * сервер сообщает предварительную оценку, а итоговая сумма приходит вместе
   * с задачей. Настоящая сумма заменяет оценку, когда сервер её прислал.
   */
  chargedUsd?: number
  createdAt: number
}

export type RestoredGenerationTask = Omit<GenerationTask, 'state'> & {
  state: Extract<GenerationTaskState, 'done' | 'error' | 'cancelled'>
}

export interface GenerationRetryDescriptor {
  kind: JobKind
  prompt: string
  refs: GenRef[]
  model?: string
  params?: Record<string, unknown>
  /** Источник доски нужен, чтобы повтор cloud-задачи снова пошёл в Cloud. */
  projectRef?: ProjectRef
}

interface ParkedDelivery {
  job: Job
  target: GenerationTarget
  parkedAt: number
}

// Паркованные доставки ждут повторного открытия доски/диалога. Доска, которую
// больше никогда не откроют (или удалённая), копила бы их до конца сеанса —
// держим последние и не старше суток.
const PARKED_MAX_PER_CHANNEL = 10
const PARKED_TTL_MS = 24 * 60 * 60 * 1000
// Ответы подряд не должны становиться запросами вплотную друг к другу.
const MIN_WAIT_SPACING_MS = 100

export interface GenerationRegistryDeps {
  getJob(id: string): Promise<Job>
  /**
   * Ожидание изменения всех задач одним запросом (пункт 3.7): ответ приходит,
   * как только исполнитель узнал новость, а не по опросу каждой задачи раз в
   * 0,9 с. Нет его или он вернул null (сервер не умеет) — опрос по одной.
   */
  waitJobs?(
    ids: readonly string[],
    seen: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<JobWaitEntry[] | null>
  cancelJob(id: string): Promise<unknown>
  generate?(request: GenerationRetryDescriptor): Promise<{ jobId: string }>
  schedule(callback: () => void, delayMs: number): unknown
  unschedule(timer: unknown): void
  visibility?: {
    isHidden(): boolean
    subscribe(listener: () => void): () => void
  }
}

export interface CloudGenerationJobTransport {
  getJob(id: string): Promise<Job>
  cancelJob(id: string): Promise<unknown>
}

export interface GenerationRegistry {
  trackGeneration(
    target: GenerationTarget,
    jobId: string,
    jobKind: JobKind,
    retry?: GenerationRetryDescriptor,
    launch?: GenerationLaunchMeta,
  ): void
  trackFailedGeneration(
    target: GenerationTarget,
    jobKind: JobKind,
    retry: GenerationRetryDescriptor,
    launch: GenerationLaunchMeta,
    error: string,
  ): string
  restoreGenerationTask(task: RestoredGenerationTask): void
  rebindGeneration(jobId: string, nextJobId: string): void
  cancelGeneration(jobId: string): Promise<void>
  retryGeneration(jobId: string): Promise<string>
  subscribe(listener: () => void): () => void
  getSnapshot(): GenerationTask[]
  dismissTask(jobId: string): void
  registerGenerationSink(
    channel: GenerationChannel,
    projectId: string,
    sink: GenerationSink,
  ): () => void
  pollNow(): Promise<void>
  dispose(): void
}

function channelKey(channel: GenerationChannel, projectId: string): string {
  return `${channel}:${projectId}`
}

function targetKey(target: GenerationTarget): string {
  return channelKey(target.kind, target.projectId)
}

export function createGenerationRegistry(deps: GenerationRegistryDeps): GenerationRegistry {
  const tracked = new Map<string, Tracked>()
  const tasks = new Map<string, GenerationTask>()
  let snapshot: GenerationTask[] = []
  const listeners = new Set<() => void>()
  const sinks = new Map<string, GenerationSink>()
  const parked = new Map<string, ParkedDelivery[]>()
  // Полный ответ можно вытеснить из кеша, но обязанность доставить финал остаётся.
  // При возвращении доски перечитаем эти jobs, не отправляя новую генерацию.
  const deferredDeliveries = new Map<string, Tracked>()
  let timer: unknown
  let polling = false
  let disposed = false
  // Ждём изменений одним запросом, пока сервер это умеет (см. waitJobs).
  let waitSupported = Boolean(deps.waitJobs)
  let waitController: AbortController | null = null

  function notifyTasks(): void {
    snapshot = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
    for (const listener of listeners) listener()
  }

  function updateTask(
    jobId: string,
    patch: Partial<Omit<GenerationTask, 'jobId'>>,
  ): void {
    const current = tasks.get(jobId)
    if (!current) return
    tasks.set(jobId, { ...current, ...patch })
    notifyTasks()
  }

  function deliver(target: GenerationTarget, job: Job): void {
    deferredDeliveries.delete(job.id)
    const key = targetKey(target)
    const sink = sinks.get(key)
    if (sink) {
      sink(job, target)
      return
    }
    const now = Date.now()
    const previous = parked.get(key) ?? []
    const waiting = previous.filter((entry) => now - entry.parkedAt < PARKED_TTL_MS)
    waiting.push({ job, target, parkedAt: now })
    const evicted = [
      ...previous.filter((entry) => now - entry.parkedAt >= PARKED_TTL_MS),
      ...waiting.slice(0, Math.max(0, waiting.length - PARKED_MAX_PER_CHANNEL)),
    ]
    for (const entry of evicted) {
      deferredDeliveries.set(entry.job.id, {
        jobId: entry.job.id, jobKind: entry.job.kind, target: entry.target, errors: 0,
      })
    }
    parked.set(key, waiting.slice(-PARKED_MAX_PER_CHANNEL))
  }

  function notifyProgress(target: GenerationTarget, job: Job): void {
    if (target.kind !== 'prompt-chat') return
    sinks.get(targetKey(target))?.(job, target)
  }

  function lostJob(item: Tracked, error: string): Job {
    return {
      id: item.jobId,
      kind: item.jobKind,
      prompt: '',
      status: 'error',
      error,
    }
  }

  function ensurePolling(delayMs?: number): void {
    if (disposed) return
    if (tracked.size > 0 && timer === undefined && !polling) {
      const isHidden = deps.visibility?.isHidden() ?? false
      // Ожидание держит сам сервер — следующее начинаем сразу. Скрытой вкладке
      // оно тоже ничего не стоит: один запрос в пятнадцать секунд.
      const interval = delayMs ?? (waitSupported ? 0 : isHidden ? POLL_HIDDEN_MS : POLL_MS)
      timer = deps.schedule(() => {
        timer = undefined
        void pollNow()
      }, interval)
    } else if (tracked.size === 0 && timer !== undefined) {
      deps.unschedule(timer)
      timer = undefined
    }
  }

  /**
   * Список задач сменился, а ожидание уже в пути со старым: обрываем его, и
   * следующее уйдёт с новым списком. Иначе новая задача ждала бы, пока
   * закончится ожидание по старым, — до пятнадцати секунд.
   */
  function restartWait(): void {
    waitController?.abort()
  }

  const unsubscribeVisibility = deps.visibility?.subscribe(() => {
    if (!deps.visibility?.isHidden() && tracked.size > 0) {
      if (timer !== undefined) {
        deps.unschedule(timer)
        timer = undefined
      }
      void pollNow()
    }
  }) ?? (() => {})

  /**
   * ⚠️ У сервера команды есть свой финал — «отменена». Наш словарь статусов
   * его не знает, и такая задача крутилась бы в опросе вечно: ни `done`, ни
   * `error` она уже не станет никогда.
   */
  function isCancelledJob(job: Job): boolean {
    return String(job.status) === 'cancelled'
      || job.error === 'Cancelled'
      || job.error === 'отменено'
  }

  function settle(item: Tracked, job: Job, connection?: GenerationTaskConnection): void {
    if (tracked.get(item.jobId) !== item) return
    tracked.delete(item.jobId)
    log.info('gen', "task completed", {
      jobId: item.jobId,
      status: job.status,
      error: job.error,
      result: job.result ? Object.keys(job.result) : null,
      target: item.target.kind === 'canvas' ? item.target.projectId : item.target.kind,
    })
    const cancelled = isCancelledJob(job)
    updateTask(item.jobId, {
      state:
        job.status === 'done'
          ? 'done'
          : cancelled
            ? 'cancelled' // осознанная отмена — не «Ошибка» и без кнопки «Повторить»
            : 'error',
      error: cancelled ? 'Cancelled' : job.error,
      connection,
      // Факт перебивает оценку, но только когда он есть: у тарифа «по факту»
      // расход приходит от fal отдельной сверкой и может опоздать.
      ...(typeof job.chargedAmountUsd === 'number' && Number.isFinite(job.chargedAmountUsd)
        ? { chargedUsd: job.chargedAmountUsd }
        : {}),
    })
    deliver(item.target, job)
    ensurePolling()
  }

  /**
   * Задача переезжает на другой номер: на сетевой доске мы продолжаем следить
   * за ней уже у сервера команды (`cloud-job~…`). Это тот же прогон и те же
   * деньги — новую задачу не заводим, старую не бросаем, просто меняем адрес.
   */
  function rebindGeneration(jobId: string, nextJobId: string): void {
    if (jobId === nextJobId) return
    const item = tracked.get(jobId)
    const task = tasks.get(jobId)
    if (!item && !task) return
    if (tracked.has(nextJobId) || tasks.has(nextJobId)) return
    if (item) {
      tracked.delete(jobId)
      // Отметку прежнего номера не переносим: под новым номером первый ответ
      // должен прийти сразу, с его настоящим состоянием.
      tracked.set(nextJobId, { ...item, jobId: nextJobId, cloudJobAnnounced: true, version: undefined })
    }
    if (task) {
      tasks.delete(jobId)
      tasks.set(nextJobId, { ...task, jobId: nextJobId })
      notifyTasks()
    }
    log.info('gen', "the task has moved to the team server", { previous: jobId, next: nextJobId })
    restartWait()
    ensurePolling()
  }

  /** Доска переставляет карточку и слежение на номер сервера команды. */
  function announceCloudJob(_item: Tracked): void {}

  /** Свежее состояние задачи: финал доставляем, остальное показываем. */
  function applyFresh(item: Tracked, fresh: Job): void {
    item.errors = 0
    if (!item.cloudJobAnnounced && typeof fresh.cloudJobId === 'string' && fresh.cloudJobId
      && item.target.kind === 'canvas') {
      item.cloudJobAnnounced = true
      item.cloudJobId = fresh.cloudJobId
      announceCloudJob(item)
      if (tracked.get(item.jobId) !== item) return
    }
    if (fresh.status === 'done' || fresh.status === 'error' || isCancelledJob(fresh)) {
      settle(item, fresh)
    } else {
      // «Останавливается…» не затираем обратно в «Генерируется»: сервер
      // при мягкой отмене держит running до финала, а пользователь уже
      // нажал «Стоп» и должен видеть, что отмена принята
      const current = tasks.get(item.jobId)
      if (current?.state !== 'cancelling') {
        updateTask(item.jobId, { state: fresh.status, connection: undefined })
      } else {
        updateTask(item.jobId, { connection: undefined })
      }
      notifyProgress(item.target, fresh)
    }
  }

  /** Спросить не вышло. Пропала — хороним; сеть — ждём, не выдумывая порога. */
  function applyFailure(item: Tracked, status: number | null, message: string): void {
    const gone = status === 404
    item.errors++
    log.warn('gen', "task poll failed", {
      jobId: item.jobId,
      status,
      error: message,
      consecutiveErrors: item.errors,
      jobLost: gone,
    })
    if (gone) {
      settle(item, lostJob(item, JOB_LOST), 'delivery-error')
    } else {
      // Сетевой/сессионный отказ не доказывает, что оплаченная задача
      // исчезла. Оставляем её в polling без произвольного порога: после
      // восстановления тот же jobId даст настоящий done/error/cancelled.
      updateTask(item.jobId, { connection: 'reconnecting' })
    }
  }

  async function pollNow(): Promise<void> {
    if (polling) return
    if (waitSupported && deps.waitJobs) return pollWaiting(deps.waitJobs)
    polling = true
    try {
      for (const item of [...tracked.values()]) {
        if (tracked.get(item.jobId) !== item) continue
        try {
          const fresh = await deps.getJob(item.jobId)
          if (tracked.get(item.jobId) !== item) continue
          applyFresh(item, fresh)
        } catch (error) {
          if (tracked.get(item.jobId) !== item) continue
          applyFailure(
            item,
            error instanceof ApiError ? error.status ?? null : null,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    } finally {
      polling = false
      ensurePolling()
    }
  }

  /**
   * Все задачи одним ждущим запросом (пункт 3.7). Сервер отвечает, как только
   * хоть одна изменилась, и следующее ожидание уходит сразу.
   */
  async function pollWaiting(waitJobs: NonNullable<GenerationRegistryDeps['waitJobs']>): Promise<void> {
    polling = true
    const controller = new AbortController()
    waitController = controller
    const started = Date.now()
    let delay = 0
    try {
      const items = [...tracked.values()]
      if (items.length === 0) return
      const seen: Record<string, string> = {}
      for (const item of items) if (item.version) seen[item.jobId] = item.version
      let entries: JobWaitEntry[] | null
      try {
        entries = await waitJobs(items.map((item) => item.jobId), seen, controller.signal)
      } catch (error) {
        // Оборвали сами — список задач сменился, сразу ждём заново.
        if (controller.signal.aborted) return
        delay = POLL_MS
        for (const item of items) {
          if (tracked.get(item.jobId) !== item) continue
          applyFailure(
            item,
            error instanceof ApiError ? error.status ?? null : null,
            error instanceof Error ? error.message : String(error),
          )
        }
        return
      }
      if (entries === null) {
        // Сервер ждать не умеет — навсегда возвращаемся к опросу по одной.
        waitSupported = false
        return
      }
      const byId = new Map(entries.map((entry) => [entry.id, entry]))
      for (const item of items) {
        if (tracked.get(item.jobId) !== item) continue
        const entry = byId.get(item.jobId)
        if (!entry) continue
        item.version = entry.version
        if (entry.job) applyFresh(item, entry.job)
        else if (entry.missing) applyFailure(item, 404, "Task not found")
        else if (entry.failure) applyFailure(item, entry.failure.status, entry.failure.error)
      }
    } finally {
      polling = false
      if (waitController === controller) waitController = null
      // Ответ, пришедший мгновенно, — это новость; но новости подряд не должны
      // превращаться в запросы вплотную друг к другу.
      if (Date.now() - started < MIN_WAIT_SPACING_MS) delay = Math.max(delay, MIN_WAIT_SPACING_MS)
      ensurePolling(delay)
    }
  }

  function trackGeneration(
    target: GenerationTarget,
    jobId: string,
    jobKind: JobKind,
    retry?: GenerationRetryDescriptor,
    launch?: GenerationLaunchMeta,
  ): void {
    if (tracked.has(jobId) || tasks.has(jobId) || deferredDeliveries.has(jobId)) return
    tracked.set(jobId, { jobId, jobKind, target, errors: 0 })
    tasks.set(jobId, {
      jobId,
      jobKind,
      target,
      state: 'queued',
      retry,
      launch,
      createdAt: Date.now(),
    })
    notifyTasks()
    restartWait()
    ensurePolling()
  }

  function trackFailedGeneration(
    target: GenerationTarget,
    jobKind: JobKind,
    retry: GenerationRetryDescriptor,
    launch: GenerationLaunchMeta,
    error: string,
  ): string {
    const jobId = `local:${newId()}`
    tasks.set(jobId, {
      jobId,
      jobKind,
      target,
      state: 'error',
      error,
      retry,
      launch,
      createdAt: Date.now(),
    })
    notifyTasks()
    return jobId
  }

  function restoreGenerationTask(task: RestoredGenerationTask): void {
    if (tracked.has(task.jobId) || tasks.has(task.jobId)) return
    tasks.set(task.jobId, task)
    notifyTasks()
  }

  async function cancelGeneration(jobId: string): Promise<void> {
    // Опрос НЕ прекращаем: финал задачи решает сервер. Если отмена успела —
    // придёт «отменено»; если генерация уже была оплачена — придёт готовый
    // результат, и он ляжет на канвас (терять оплаченное нельзя). Раньше
    // tracked.delete до await давал вечный спиннер при сбое отмены и выбрасывал
    // поздний оплаченный результат (аудит GEN-02/GEN-04).
    // Уже завершённую (settled) задачу не трогаем: «Стоп» в момент финала
    // оставлял бы её в вечном «Останавливается…» без опроса.
    if (!tracked.has(jobId) && tasks.has(jobId)) return
    // Задача, о которой реестр вообще не знает (её ещё не успели зарегистрировать
    // — например, помощника остановили сразу после отправки), всё равно должна
    // быть снята на сервере, иначе она досчитается и спишет деньги.
    if (!tracked.has(jobId)) {
      await deps.cancelJob(jobId)
      return
    }
    updateTask(jobId, { state: 'cancelling', error: undefined })
    try {
      await deps.cancelJob(jobId)
    } catch (error) {
      // финал (в т.ч. 404 «задача не нашлась») доведёт обычный опрос
      updateTask(jobId, {
        state: 'error',
        error: error instanceof Error ? error.message : "Failed to cancel task",
      })
      throw error
    }
  }

  async function retryGeneration(jobId: string): Promise<string> {
    const previous = tasks.get(jobId)
    if (!previous?.retry || !deps.generate) {
      throw new Error("There is no retry data for this task")
    }
    // Заявку на повтор забирает тот клик, который успел первым, и делает это ДО
    // сетевого вызова. Кнопка «Повторить» не гаснет на время запроса, поэтому
    // два быстрых клика уходили в generate дважды — две ОПЛАЧЕННЫЕ задачи
    // вместо одной и два результата на холсте. Забрав данные повтора, мы заодно
    // убираем кнопку: рисуется она только при task.retry.
    const claimed = previous.retry
    updateTask(jobId, { retry: undefined })
    try {
      const { jobId: nextJobId } = await deps.generate(claimed)
      trackGeneration(previous.target, nextJobId, previous.jobKind, claimed, previous.launch)
      return nextJobId
    } catch (error) {
      // повтор не состоялся — возвращаем возможность попробовать ещё раз
      updateTask(jobId, { retry: claimed })
      throw error
    }
  }

  function registerGenerationSink(
    channel: GenerationChannel,
    projectId: string,
    sink: GenerationSink,
  ): () => void {
    const key = channelKey(channel, projectId)
    sinks.set(key, sink)
    // ⚠️ Доска, закрытая в тот миг, когда задача узнала номер сервера команды,
    // о нём не услышала: карточка так и осталась без номера, и готовый
    // результат встал бы копией рядом с ней. Напоминаем открывшейся доске о
    // каждой её задаче, которая всё ещё живёт под номером нашего сервера.
    if (channel === 'canvas') {
      for (const item of [...tracked.values()]) {
        if (targetKey(item.target) !== key || item.jobId.startsWith('cloud-job~')) continue
        if (tracked.get(item.jobId) === item) announceCloudJob(item)
      }
    }
    const waiting = parked.get(key)
    if (waiting?.length) {
      parked.delete(key)
      for (const delivery of waiting) sink(delivery.job, delivery.target)
    }
    for (const [jobId, item] of deferredDeliveries) {
      if (targetKey(item.target) !== key) continue
      deferredDeliveries.delete(jobId)
      if (!tracked.has(jobId)) {
        tracked.set(jobId, item)
        restartWait()
      }
    }
    ensurePolling()
    return () => {
      if (sinks.get(key) === sink) sinks.delete(key)
    }
  }

  return {
    trackGeneration,
    trackFailedGeneration,
    restoreGenerationTask,
    rebindGeneration,
    cancelGeneration,
    retryGeneration,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    dismissTask(jobId) {
      if (!tasks.delete(jobId)) return
      notifyTasks()
    },
    registerGenerationSink,
    pollNow,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribeVisibility()
      waitController?.abort()
      if (timer !== undefined) {
        deps.unschedule(timer)
        timer = undefined
      }
    },
  }
}


const browserRegistry = createGenerationRegistry({
  getJob: (id) => api.job(id),
  waitJobs: (ids, seen, signal) => api.waitJobs(ids, seen, signal),
  cancelJob: (id) => api.cancelJob(id),
  generate: (request) => {
    // Retry вызывается из общего task center, где исходный target уже не
    // передаётся отдельно. Сохраняем projectRef в retry descriptor и
    // восстанавливаем cloud target перед submit; иначе api.generate видел
    // локальную генерацию и cloud-задача повторно обходила сервер команды.
    const target = request.projectRef
      ? {
          kind: 'canvas' as const,
          projectRef: { ...request.projectRef },
          placeholderId: newId(),
        }
      : undefined
    return api.generate(
      request.kind,
      request.prompt,
      request.refs,
      request.model,
      request.params,
      target,
    )
  },
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  unschedule: (timer) => window.clearTimeout(timer as number),
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

if (import.meta.hot) {
  import.meta.hot.dispose(() => browserRegistry.dispose())
}

export function trackGeneration(
  target: GenerationTarget,
  jobId: string,
  jobKind: JobKind,
  retry?: GenerationRetryDescriptor,
  launch?: GenerationLaunchMeta,
): void {
  browserRegistry.trackGeneration(target, jobId, jobKind, retry, launch)
}

export function trackFailedGeneration(
  target: GenerationTarget,
  jobKind: JobKind,
  retry: GenerationRetryDescriptor,
  launch: GenerationLaunchMeta,
  error: string,
): string {
  return browserRegistry.trackFailedGeneration(target, jobKind, retry, launch, error)
}

export function restoreGenerationTask(task: RestoredGenerationTask): void {
  browserRegistry.restoreGenerationTask(task)
}

export function cancelGeneration(jobId: string): Promise<void> {
  return browserRegistry.cancelGeneration(jobId)
}

export function retryGeneration(jobId: string): Promise<string> {
  return browserRegistry.retryGeneration(jobId)
}

// Есть ли чем повторить эту задачу: снимок запроса живёт в реестре, но после
// перезапуска страницы его уже нет. Кнопку «Повторить» показываем только когда
// она действительно сработает, а не чтобы огорчить ошибкой на нажатие.
export function canRetryGeneration(jobId: string | undefined): boolean {
  if (!jobId) return false
  return browserRegistry.getSnapshot().some((task) => task.jobId === jobId && Boolean(task.retry))
}

export function subscribeGenerationTasks(listener: () => void): () => void {
  return browserRegistry.subscribe(listener)
}

export function getGenerationTasks(): GenerationTask[] {
  return browserRegistry.getSnapshot()
}

export function dismissGenerationTask(jobId: string): void {
  browserRegistry.dismissTask(jobId)
}

export function registerGenerationSink(
  channel: GenerationChannel,
  projectId: string,
  sink: GenerationSink,
): () => void {
  return browserRegistry.registerGenerationSink(channel, projectId, sink)
}

/** Задача переехала на номер сервера команды — следим за ней уже там. */
export function rebindGeneration(jobId: string, nextJobId: string): void {
  browserRegistry.rebindGeneration(jobId, nextJobId)
}

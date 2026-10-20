import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { DurableFileMissingError, markRecoveryApplied, readDurableJson } from './durableJsonRecovery.js'
import type { IncomingRef } from './refs.js'
import type { GenerationRoute } from './generationGate.js'
import type { CatalogModel } from './catalog.js'

export type JobKind = 'image' | 'video' | 'text' | 'audio' | 'other'
export type JobStatus = 'queued' | 'running' | 'done' | 'error'

export interface JobResult {
  assetId?: string
  url?: string
  width?: number
  height?: number
  mime?: string
  text?: string
  seed?: number
}

/** Зарезервированная перед submit quote и уже загруженные cloud-референсы. */
export type JobTarget =
  | {
      // Доска, на которую встанет результат. Нужна не для доставки в открытый
      // клиент (он и так опрашивает задачу), а для случая «запустил и закрыл»:
      // сервер поставит результат сам, когда доску никто не держит.
      kind: 'canvas'
      projectId: string
      placeholderId: string
      /** Нет у старых задач и означает local. */
      source?: 'local'
    }
  | {
      /**
       * Closed, text-only canvas action preparation.  It deliberately has no
       * placeholder: a prepared prompt is reviewed by the client and is not
       * delivered to a board or followed by an implicit media launch.
       */
      kind: 'canvas-action'
      projectId: string
      source: 'local'
      assistantId?: string | null
      assistantVersionId?: string | null
      /** SHA-256 of the normalized input refs; refs are cleared after finish. */
      refsHash?: string
      /** Client retry key; it is persisted with the durable job. */
      idempotencyKey: string
    }
  | {
      kind: 'prompt-chat'
      projectId: string
      conversationId: string
      requestMessageId: string
      responseMessageId: string
      requestId: string
      /** Frozen per-turn preference; omitted on legacy jobs means enabled. */
      boardMemoryEnabled?: boolean
    }
  | {
      kind: 'prompt-chat-compaction'
      projectId: string
      conversationId: string
      fromMessageId: string | null
      throughMessageId: string
      contextRevision: number
    }

export interface Job {
  id: string
  kind: JobKind
  prompt: string
  refs: IncomingRef[]
  model?: string
  params?: Record<string, unknown>
  status: JobStatus
  progressText?: string
  result?: JobResult
  error?: string
  createdAt: number
  finishedAt?: number
  cancelled?: boolean
  falEndpoint?: string
  falRequestId?: string
  /** Задача на сервере CanAI, если генерация идёт через него. */
  /** Удалённый сервер подтвердил окончательную ошибку этой задачи. */
  /**
   * Сколько ФАКТИЧЕСКИ списал сервер команды.
   *
   * ⚠️ У тарифа `fal-metered` (GPT Image 2.5) цена заранее не известна: fal
   * считает её по факту. Сервер держит резерв-потолок и списывает меньшее из
   * двух. Без этого поля приложение показывало только потолок, и на вопрос
   * «сколько же стоила генерация» ответить было нечем (09.09.2026).
   * Пусто, если расход ещё не сверен, — тогда говорим «до», как и раньше.
   */
  chargedAmountUsd?: number
  /** Quote binding сохраняется до конца задачи, чтобы рестарт не повторил upload. */
  /** Маршрут фиксируется при постановке и не меняется вслед за настройками. */
  generationRoute?: GenerationRoute
  /**
   * Ключ идемпотентности ЛОКАЛЬНОЙ/legacy генерации (пункт плана аудита 4).
   * Позволяет серверу при ПОВТОРЕ запроса (потерянный ответ, сетевой обрыв)
   * вернуть уже созданную задачу вместо того, чтобы платить за новую.
   * У account-cloud свой ключ живёт внутри accountCloudQuote; у локальных
   * маршрутов — здесь. Старые задачи без него.
   */
  idempotencyKey?: string
  /**
   * Server-only prompt sent to the provider for a canvas action.  The public
   * job view strips it because Cloud profile instructions are part of it.
   */
  canvasActionPrompt?: string
  /** Оплаченный результат fal: URL уже получен, но ещё не скачан в media.
   *  Попадает в jobs.json и позволяет после сбоя/рестарта докачать файл
   *  БЕЗ повторного платного submit (резюм по requestId тоже возможен). */
  paidResult?: { url: string; width?: number; height?: number; seed?: number }
  target?: JobTarget
  internal?: boolean
  deliveredAt?: number
  /** Сколько раз доставка результата уже не удалась. ⚠️ Живёт В ЗАДАЧЕ, а не в
   *  памяти процесса: счётчик в памяти обнулялся при каждом запуске, и
   *  безнадёжная доставка повторялась вечно — в журнале тестировщика одна и та
   *  же строка 62 раза за десять дней (20.09.2026). */
  deliveryFailures?: number
  /** Сколько раз оплаченный, но недоставленный результат уже пытались
   *  воскресить при запуске. ⚠️ Без счётчика попытки не кончались: 18 задач
   *  от 07.09 при КАЖДОМ запуске приложения снова шли в fal и получали
   *  «invalid key credentials» — ключ к тому времени сменился (журнал 17–26.09). */
  recoveryAttempts?: number
  /** Задача восстановлена из старого backup без доказательства постановки. */
  recoveryNeedsReview?: boolean
  /** Неизменяемая схема неопубликованной модели для платного теста. */
  modelSnapshot?: CatalogModel
  catalogDraftTest?: {
    draftId: string
    definitionHash: string
    tariffHash: string
    idempotencyKey: string
  }
}

interface JobsDocument {
  version: 1
  jobs: Job[]
  /** True when a local-edition restore dropped development Cloud jobs. */
  legacyCloudJobsDiscarded?: boolean
}

// Готовые задачи храним НЕДЕЛЮ, а не 30 минут: пока запись жива в jobs.json,
// (а) клиент может забрать оплаченный результат даже если браузер был закрыт
// часами, (б) GC media не тронет файл результата (jobs.json входит в referenced).
// 30-минутный TTL приводил к прямой потере оплаченных генераций (аудит SYS-04).
const DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_LIVE_JOBS = 50

// Лимит активных задач проверяет сам стор: ранние проверки в роутах — лишь
// быстрый отказ, между ними и create стоят await'ы, и параллельные запросы
// проходили лимит скопом.
export class JobLimitError extends Error {
  constructor() {
    super('Too many active generations — wait for the current ones to finish')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isIncomingRef(value: unknown): value is IncomingRef {
  if (!isRecord(value)) return false
  if (value.kind === 'text') return typeof value.text === 'string'
  if (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'audio') return false
  return typeof value.src === 'string'
    && (value.width === undefined || isFiniteNumber(value.width))
    && (value.height === undefined || isFiniteNumber(value.height))
}

function isShortId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
}

function isCatalogModelSnapshot(value: unknown): value is CatalogModel {
  if (!isRecord(value) || JSON.stringify(value).length > 64_000) return false
  return isShortId(value.id)
    && typeof value.name === 'string'
    && value.name.length > 0
    && ['image', 'video', 'text', 'audio', 'other'].includes(String(value.kind))
    && typeof value.endpoint === 'string'
    && value.endpoint.length > 0
    && Array.isArray(value.params)
}

function isCatalogDraftTest(value: unknown): value is NonNullable<Job['catalogDraftTest']> {
  return isRecord(value)
    && isShortId(value.draftId)
    && typeof value.definitionHash === 'string' && /^[a-f0-9]{64}$/.test(value.definitionHash)
    && typeof value.tariffHash === 'string' && /^[a-f0-9]{64}$/.test(value.tariffHash)
    && typeof value.idempotencyKey === 'string'
    && value.idempotencyKey.length > 0
    && value.idempotencyKey.length <= 160
}

function isJobTarget(value: unknown): value is JobTarget {
  if (!isRecord(value) || !isShortId(value.projectId)) return false
  if (value.kind === 'canvas-action') {
    const optionalId = (candidate: unknown): boolean => candidate === undefined || candidate === null || isShortId(candidate)
    return value.source === 'local'
      && typeof value.idempotencyKey === 'string'
      && value.idempotencyKey.length >= 1
      && value.idempotencyKey.length <= 160
      && !/[\u0000/]/u.test(value.idempotencyKey)
      && optionalId(value.assistantId)
      && optionalId(value.assistantVersionId)
      && (value.refsHash === undefined
        || typeof value.refsHash === 'string' && /^[a-f0-9]{64}$/u.test(value.refsHash))
  }
  if (value.kind === 'canvas') {
    return isShortId(value.placeholderId)
      && (value.source === undefined || value.source === 'local')
  }
  if (!isShortId(value.conversationId)) return false
  if (value.kind === 'prompt-chat') {
    return isShortId(value.requestMessageId)
      && isShortId(value.responseMessageId)
      && isShortId(value.requestId)
      && (value.boardMemoryEnabled === undefined || typeof value.boardMemoryEnabled === 'boolean')
  }
  if (value.kind === 'prompt-chat-compaction') {
    return (value.fromMessageId === null || isShortId(value.fromMessageId))
      && isShortId(value.throughMessageId)
      && Number.isInteger(value.contextRevision)
      && Number(value.contextRevision) >= 0
  }
  return false
}

/** Ссылки роликов и дорожек: поля может не быть — у старых задач его нет. */
function optionalRefList(value: unknown): boolean {
  return value === undefined
    || Array.isArray(value) && value.every((ref) => typeof ref === 'string' && ref.length <= 2_000)
}


function parseJob(value: unknown): Job | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || value.id.length > 100) return null
  if (!['image', 'video', 'text', 'audio', 'other'].includes(String(value.kind))) return null
  if (!['queued', 'running', 'done', 'error'].includes(String(value.status))) return null
  if (typeof value.prompt !== 'string' || !Array.isArray(value.refs) || !value.refs.every(isIncomingRef)) return null
  if (!isFiniteNumber(value.createdAt)) return null
  if (value.finishedAt !== undefined && !isFiniteNumber(value.finishedAt)) return null
  if (value.params !== undefined && !isRecord(value.params)) return null
  if (value.result !== undefined && !isRecord(value.result)) return null
  if (
    value.paidResult !== undefined
    && (!isRecord(value.paidResult) || typeof value.paidResult.url !== 'string')
  ) return null
  if (value.chargedAmountUsd !== undefined && !isFiniteNumber(value.chargedAmountUsd)) return null
  if (value.target !== undefined && !isJobTarget(value.target)) return null
  if (value.internal !== undefined && typeof value.internal !== 'boolean') return null
  if (value.deliveredAt !== undefined && !isFiniteNumber(value.deliveredAt)) return null
  if (value.deliveryFailures !== undefined && !isFiniteNumber(value.deliveryFailures)) return null
  if (value.recoveryAttempts !== undefined && !isFiniteNumber(value.recoveryAttempts)) return null
  if (value.recoveryNeedsReview !== undefined && typeof value.recoveryNeedsReview !== 'boolean') return null
  if (value.modelSnapshot !== undefined && !isCatalogModelSnapshot(value.modelSnapshot)) return null
  if (value.catalogDraftTest !== undefined && !isCatalogDraftTest(value.catalogDraftTest)) return null
  if ((value.modelSnapshot === undefined) !== (value.catalogDraftTest === undefined)) return null
  if (value.canvasActionPrompt !== undefined
    && (typeof value.canvasActionPrompt !== 'string'
      || value.canvasActionPrompt.length > 40_000
      || !isRecord(value.target)
      || value.target.kind !== 'canvas-action')) return null
  if (
    value.generationRoute !== undefined
    && !['mock', 'local'].includes(String(value.generationRoute))
  ) return null
  if (value.idempotencyKey !== undefined
    && (typeof value.idempotencyKey !== 'string'
      || value.idempotencyKey.length < 1
      || value.idempotencyKey.length > 160
      || /[\u0000/]/u.test(value.idempotencyKey))) return null

  return value as unknown as Job
}

export const JOB_RECOVERY_REVIEW_ERROR = 'Recovery needs manual review: the backup had no durable provider request ID, so this generation was not resumed to avoid a duplicate charge.'

function hasDurableProviderBinding(job: Job): boolean {
  return Boolean(job.falRequestId || job.paidResult?.url)
}

function quarantineAmbiguousRecoveredJob(job: Job): boolean {
  if (job.recoveryNeedsReview || job.cancelled || (job.status !== 'queued' && job.status !== 'running')) return false
  if (job.generationRoute === 'mock' || hasDurableProviderBinding(job)) return false
  job.status = 'error'
  job.error = JOB_RECOVERY_REVIEW_ERROR
  job.progressText = undefined
  job.finishedAt = Date.now()
  job.recoveryNeedsReview = true
  return true
}

function isLegacyCloudJob(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.generationRoute === 'account-cloud' || value.generationRoute === 'legacy-cloud') return true
  if (typeof value.cloudJobId === 'string' || value.accountCloudQuote !== undefined || value.cloudJobTerminal !== undefined) return true
  const target = value.target
  return isRecord(target) && target.source === 'cloud'
}

function parseJobsDocument(raw: string): JobsDocument {
  const document = JSON.parse(raw) as Partial<JobsDocument>
  if (document.version !== 1 || !Array.isArray(document.jobs)) {
    throw new Error('jobs.json corrupted: invalid format')
  }
  // Cloud jobs from a development jobs.json are deliberately ignored. They
  // cannot be paid or resumed by the local runner, and must never fall through
  // to a local fal submit after an edition migration.
  const retained = document.jobs.filter((value) => !isLegacyCloudJob(value))
  const parsed = retained.map(parseJob)
  if (parsed.some((job) => job === null)) throw new Error('jobs.json corrupted: invalid job')
  return {
    version: 1,
    jobs: parsed as Job[],
    legacyCloudJobsDiscarded: retained.length !== document.jobs.length,
  }
}

export class JobStore {
  private readonly store = new Map<string, Job>()
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>()
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly doneTtlMs = DONE_TTL_MS,
  ) {}

  create(
    kind: JobKind,
    prompt: string,
    refs: IncomingRef[],
    model?: string,
    params?: Record<string, unknown>,
    target?: JobTarget,
    internal?: boolean,
    idOverride?: string,
  ): Job {
    if (this.store.size >= 1000) {
      for (const [id, job] of this.store) {
        if (!job.recoveryNeedsReview && (job.status === 'done' || job.status === 'error')) {
          this.remove(id)
          break
        }
      }
    }
    // Внутренние задачи (compaction) лимит не занимают наравне с пользовательскими
    if (!internal && this.liveCount() >= MAX_LIVE_JOBS) throw new JobLimitError()
    const job: Job = {
      id: idOverride ?? randomUUID(),
      kind,
      prompt,
      refs,
      model,
      params,
      status: 'queued',
      createdAt: Date.now(),
      target,
      internal,
    }
    this.store.set(job.id, job)
    return job
  }

  get(id: string): Job | undefined {
    return this.store.get(id)
  }

  all(): Job[] {
    return [...this.store.values()]
  }

  remove(id: string): void {
    const timer = this.expiryTimers.get(id)
    if (timer) clearTimeout(timer)
    this.expiryTimers.delete(id)
    this.store.delete(id)
  }

  liveCount(): number {
    let count = 0
    for (const job of this.store.values()) {
      if (job.status === 'queued' || job.status === 'running') count++
    }
    return count
  }

  async restore(): Promise<Job[]> {
    let loaded
    try {
      loaded = await readDurableJson({
        file: this.file,
        label: 'jobs.json',
        parse: parseJobsDocument,
      })
    } catch (error) {
      if (error instanceof DurableFileMissingError) return []
      throw error
    }

    const now = Date.now()
    let removedExpired = false
    let quarantined = false
    for (const job of loaded.value.jobs) {
      if (!job.recoveryNeedsReview && (job.status === 'done' || job.status === 'error')) {
        const finishedAt = job.finishedAt ?? job.createdAt
        if (now - finishedAt >= this.doneTtlMs) {
          removedExpired = true
          continue
        }
      }
      this.store.set(job.id, job)
      if (loaded.recoveredFromBackup && quarantineAmbiguousRecoveredJob(job)) quarantined = true
      if (!job.recoveryNeedsReview && (job.status === 'done' || job.status === 'error')) this.expireLater(job.id)
    }
    if (removedExpired || quarantined || loaded.recoveredFromBackup || loaded.value.legacyCloudJobsDiscarded === true) await this.persistNow(loaded.value.legacyCloudJobsDiscarded === true)
    if (loaded.recoveredFromBackup) await markRecoveryApplied(this.file, 'jobs.json')
    return [...this.store.values()].filter((job) => job.status === 'queued' || job.status === 'running')
  }

  async persistNow(sanitizeBackup = false): Promise<void> {
    // У завершённых задач refs на диск не пишем: референсы (в т.ч. многомегабайтные
    // data-URL скетча) нужны только пока задачу можно выполнить/возобновить.
    // Иначе недельный TTL раздувал бы jobs.json до сотен МБ, а каждый job-ивент
    // переписывает файл целиком.
    const snapshot: JobsDocument = {
      version: 1,
      jobs: [...this.store.values()].map((job) =>
        (job.status === 'done' || job.status === 'error') && !job.recoveryNeedsReview && job.refs.length > 0
          ? { ...job, refs: [] }
          : job,
      ),
    }
    const contents = JSON.stringify(snapshot)
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      if (sanitizeBackup) {
        // During a local-edition migration both files must lose filtered Cloud
        // records. The in-memory snapshot still contains every durable local
        // paid/request binding, so no local recovery state is discarded.
        await fs.writeFile(`${this.file}.bak`, contents, 'utf8')
      } else {
        try {
          await fs.copyFile(this.file, `${this.file}.bak`)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
      }
      const tmp = `${this.file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(tmp, contents, 'utf8')
        await fs.rename(tmp, this.file)
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {})
      }
    })
    return this.writeChain
  }

  expireLater(id: string): void {
    const job = this.store.get(id)
    if (!job) return
    const previous = this.expiryTimers.get(id)
    if (previous) clearTimeout(previous)
    const finishedAt = job.finishedAt ?? Date.now()
    const delay = Math.max(0, this.doneTtlMs - (Date.now() - finishedAt))
    const timer = setTimeout(() => {
      this.expiryTimers.delete(id)
      this.store.delete(id)
      void this.persistNow().catch(() => {})
    }, delay)
    timer.unref()
    this.expiryTimers.set(id, timer)
  }
}

export const jobs = new JobStore(config.jobsFile)

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import type { CanvasJobTarget } from './canvasDelivery.js'
import { jobs, JobLimitError, type Job, type JobKind } from './jobs.js'
import { logError } from './log.js'
import { MacroCancelledError, runMacroGraph } from './macroEngine.js'
import { deliveringNodeIds, type MacroGraph, type MacroInputSnapshot, type MacroResult } from './macroGraph.js'
import { extractAudio, muxAudio } from './mediaOps.js'
import type { IncomingRef } from './refs.js'
import { cancelJobById, deliverJobResult, persistAndEnqueueJob } from './runner.js'
import { validateModelParams } from './modelParams.js'
import { validateModelRefs } from './modelRefLimits.js'

// Прогон макроса как серверная сущность.
//
// Раньше он жил в промисе вкладки: закрыл страницу — прогон исчез, а уже
// оплаченные шаги оставались без результата. На планшете это не редкость, а
// норма: экран гаснет через пару минут. Теперь граф обходит сервер, а браузер
// только смотрит.
//
// Что НЕ переживает перезапуск приложения: сам обход графа. Уже отправленные
// шаги доедут (это обычные задачи с адресом доски, их восстанавливает
// restoreJobs), а следующие не начнутся — прогон честно помечается
// прерванным. Продолжать половину обхода после рестарта опасно без доказанной
// идемпотентности: цена ошибки — повторно оплаченный шаг.

const POLL_MS = 700
const MAX_ACTIVE_RUNS = 24
const MAX_PERSIST_RENAME_ATTEMPTS = 6
const PERSIST_RENAME_RETRY_MS = 25
const MISSING_SAVED_JOB_ERROR =
  'Cannot safely resume this macro: its saved generation task is missing. Review the run before retrying to avoid a duplicate charge.'

export type MacroRunStatus = 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'

export interface MacroRunNodeState {
  status: 'idle' | 'queued' | 'running' | 'done' | 'error'
  progress?: string
  error?: string
  jobId?: string
  /** Результат шага. Ради него прогон и переживает перезапуск: посчитанное
   *  повторно не считается, а значит и не оплачивается второй раз. */
  result?: MacroResult
}

export interface MacroRunState {
  id: string
  macroId: string
  macroName: string
  projectId: string
  status: MacroRunStatus
  startedAt: number
  finishedAt?: number
  error?: string
  delivered: number
  /** Заглушки, занятые этим прогоном, — по ним клиент показывает спиннеры. */
  placeholderIds: string[]
  /** Какая нода займёт какую заглушку. Считает сервер — клиенту остаётся
   *  привязать задачу к спиннеру, а не повторять у себя правило раскладки. */
  placeholderByNode: Record<string, string>
  nodes: Record<string, MacroRunNodeState>
  /** Ноды, чей результат уже на доске: после перезапуска класть второй раз нельзя. */
  deliveredNodeIds: string[]
  /**
   * Всё, что нужно, чтобы продолжить прогон после перезапуска приложения.
   *
   * Граф хранится СНИМКОМ, а не читается заново по macroId: между падением и
   * стартом макрос могли отредактировать, и продолжать надо ровно то, что
   * было запущено.
   */
  graph?: MacroGraph
  seedRefs?: IncomingRef[]
  snapshot?: MacroInputSnapshot
  /**
   * Можно ли продолжить после перезапуска.
   *
   * Нельзя, когда среди входов есть встроенная копия картинки (кадр, снятый из
   * видео прямо в браузере): такую в состояние прогона не записать, а без неё
   * незапущенный шаг получил бы не те входы — и выдал бы оплаченный, но
   * неправильный результат. Честнее прерваться.
   */
  resumable: boolean
}

const runs = new Map<string, MacroRunState>()
const cancelled = new Set<string>()

function runsFile(): string {
  return path.join(path.dirname(config.settingsFile), 'macro-runs.json')
}

function trimmed(): MacroRunState[] {
  // Держим последние прогоны: они нужны интерфейсу, чтобы показать, чем всё
  // кончилось, но копить их вечно незачем.
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 60)
}

/** На диск законченный прогон едет без снимка запуска: продолжать его нечего,
 *  а граф с референсами раздули бы файл на ровном месте. */
function forDisk(run: MacroRunState): MacroRunState {
  if (run.status === 'running') return run
  const { graph, seedRefs, snapshot, ...rest } = run
  void graph
  void seedRefs
  void snapshot
  return rest as MacroRunState
}

let writeQueue: Promise<unknown> = Promise.resolve()

function isTransientRenameError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'EPERM' || code === 'EBUSY'
}

async function renamePersistedRuns(source: string, destination: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PERSIST_RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(source, destination)
      return
    } catch (error) {
      if (!isTransientRenameError(error) || attempt === MAX_PERSIST_RENAME_ATTEMPTS) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, PERSIST_RENAME_RETRY_MS * attempt))
    }
  }
}

function persist(): void {
  // Фиксируем снимок сейчас: пока запись ждёт очереди, run может завершиться.
  // Иначе старая запись публиковала done раньше финального durable состояния.
  const contents = JSON.stringify({ version: 1, runs: trimmed().map(forDisk) }, null, 2)
  writeQueue = writeQueue.then(async () => {
    const file = runsFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, contents)
    await renamePersistedRuns(tmp, file)
  }).catch((error) => logError('macro-runs', error))
}

/**
 * Поднять прогоны после перезапуска приложения.
 *
 * Продолжаем ровно то, что было запущено: граф и входы лежат в самом прогоне,
 * посчитанные шаги — в их результатах, а отправленная задача дожидается по
 * своему id (её оживляет restoreJobs). Шаг перезапускается, только если у него
 * нет ни результата, ни живой задачи, — иначе рестарт означал бы повторную
 * оплату.
 *
 * Прогон, который продолжить нельзя (во входах была встроенная копия
 * картинки), честно помечается прерванным: лучше сказать прямо, чем досчитать
 * его на неверных входах.
 */
export async function restoreMacroRuns(): Promise<void> {
  const resuming: MacroRunState[] = []
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(runsFile(), 'utf8'))
    const list = (parsed as { runs?: MacroRunState[] })?.runs
    if (!Array.isArray(list)) return
    for (const raw of list) {
      if (!raw?.id) continue
      const run: MacroRunState = {
        ...raw,
        deliveredNodeIds: Array.isArray(raw.deliveredNodeIds) ? raw.deliveredNodeIds : [],
        nodes: raw.nodes ?? {},
      }
      if (run.status !== 'running') {
        runs.set(run.id, run)
        continue
      }
      if (run.resumable && run.graph) {
        runs.set(run.id, run)
        resuming.push(run)
        continue
      }
      runs.set(run.id, {
        ...run,
        status: 'interrupted',
        finishedAt: Date.now(),
        error: run.graph
          ? 'Run cannot continue: an input frame was captured in a browser'
          : 'Run interrupted; restart the app',
      })
    }
  } catch {
    // Файла нет или он повреждён — начинаем с чистого листа.
  }
  if (resuming.length > 0) {
    console.log(`[CanAI] continuing macros after restart: ${resuming.length}`)
    for (const run of resuming) void driveRun(run)
  }
}

export function listMacroRuns(projectId?: string): MacroRunState[] {
  const all = trimmed()
  return projectId ? all.filter((run) => run.projectId === projectId) : all
}

export function getMacroRun(id: string): MacroRunState | undefined {
  return runs.get(id)
}

export function cancelMacroRun(id: string): boolean {
  const run = runs.get(id)
  if (!run || run.status !== 'running') return false
  cancelled.add(id)
  // Идущие шаги гасим сразу: продолжать платить за отменённый макрос незачем.
  for (const state of Object.values(run.nodes)) {
    if (state.jobId) void cancelJobById(state.jobId).catch(() => {})
  }
  return true
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function awaitJob(
  jobId: string,
  runId: string,
  onProgress: (text: string) => void,
): Promise<MacroResult> {
  for (;;) {
    if (cancelled.has(runId)) throw new MacroCancelledError()
    const fresh: Job | undefined = jobs.get(jobId)
    if (!fresh) throw new Error('job was lost')
    if (fresh.status === 'done') return (fresh.result ?? {}) as MacroResult
    if (fresh.status === 'error') {
      throw fresh.cancelled ? new MacroCancelledError() : new Error(fresh.error ?? 'not worked')
    }
    if (fresh.progressText) onProgress(fresh.progressText)
    await delay(POLL_MS)
  }
}

export interface StartMacroRunInput {
  macroId: string
  macroName: string
  projectId: string
  graph: MacroGraph
  seedRefs: IncomingRef[]
  snapshot?: MacroInputSnapshot
  /** Заглушки, заранее занятые клиентом: по одной на доставляющую ноду. */
  placeholderIds: string[]
}

/** Встроенная копия картинки во входах: такую в состояние прогона не записать. */
export function hasInlineRefs(refs: readonly IncomingRef[], snapshot?: MacroInputSnapshot): boolean {
  const inline = (ref: IncomingRef) => Boolean(ref.src?.startsWith('data:'))
  if (refs.some(inline)) return true
  if (!snapshot) return false
  if (snapshot.refs.some(inline)) return true
  return Object.values(snapshot.refsByEdge).some((list) => list.some(inline))
}

export function startMacroRun(input: StartMacroRunInput): MacroRunState {
  const active = [...runs.values()].filter((run) => run.status === 'running').length
  if (active >= MAX_ACTIVE_RUNS) {
    throw new Error('Too many macros running — wait for the current run to finish')
  }

  // Заглушки раздаём доставляющим нодам в том же порядке, в каком их посчитал
  // клиент: он занимал места именно под них.
  const delivering = deliveringNodeIds(input.graph)
  const placeholderByNode: Record<string, string> = {}
  delivering.forEach((nodeId, index) => {
    const slot = input.placeholderIds[index]
    if (slot) placeholderByNode[nodeId] = slot
  })

  const run: MacroRunState = {
    id: randomUUID(),
    macroId: input.macroId,
    macroName: input.macroName,
    projectId: input.projectId,
    status: 'running',
    startedAt: Date.now(),
    delivered: 0,
    placeholderIds: [...input.placeholderIds],
    placeholderByNode,
    nodes: {},
    deliveredNodeIds: [],
    graph: input.graph,
    seedRefs: input.seedRefs,
    snapshot: input.snapshot,
    resumable: !hasInlineRefs(input.seedRefs, input.snapshot),
  }
  runs.set(run.id, run)
  persist()
  void driveRun(run)
  return run
}

/**
 * Крутить прогон до конца.
 *
 * Одна и та же функция и для первого запуска, и для продолжения после
 * перезапуска приложения: разница только в том, что во втором случае в
 * состоянии уже лежат результаты посчитанных шагов.
 */
async function driveRun(run: MacroRunState): Promise<void> {
  const graph = run.graph
  if (!graph) {
    run.status = 'interrupted'
    run.error = 'The run has no state to continue'
    run.finishedAt = Date.now()
    persist()
    return
  }
  try {
    const { delivered } = await runMacroGraph({
      graph,
      seedRefs: run.seedRefs ?? [],
      snapshot: run.snapshot,
      placeholderByNode: run.placeholderByNode,
      initialResults: Object.fromEntries(
        Object.entries(run.nodes)
          .filter(([, state]) => state.result !== undefined)
          .map(([nodeId, state]) => [nodeId, state.result!]),
      ),
      deliveredNodeIds: run.deliveredNodeIds,
      onDelivered: (nodeId) => {
        if (!run.deliveredNodeIds.includes(nodeId)) run.deliveredNodeIds.push(nodeId)
        persist()
      },
      isCancelled: () => cancelled.has(run.id),
      onNode: (nodeId, patch) => {
        const current = run.nodes[nodeId] ?? { status: 'idle' }
        run.nodes[nodeId] = {
          status: patch.status ?? current.status,
          progress: patch.progress ?? (patch.status === 'done' ? undefined : current.progress),
          error: patch.error ?? (patch.status === 'done' ? undefined : current.error),
          jobId: patch.jobId ?? current.jobId,
          // Результат сохраняем ТОЛЬКО у сделанных шагов: по нему потом видно,
          // что повторять их не надо.
          result: patch.status === 'done' ? patch.result ?? current.result : current.result,
        }
        persist()
      },
      onOutput: async (result, nodeId) => {
        // Готовый выход проходит тот же путь, что результат генерации:
        // открытый клиент получает jobId, закрытую доску обслуживает delivery.
        // ID устойчив даже при сбое между jobs.json и macro-runs.json.
        const jobId = `macro-${createHash('sha256').update(JSON.stringify([run.id, nodeId])).digest('hex')}`
        let job = jobs.get(jobId)
        const placeholderId = job?.target?.kind === 'canvas'
          ? job.target.placeholderId
          : run.placeholderByNode[nodeId] ?? randomUUID()
        if (!job) {
          const kind: JobKind = result.text !== undefined && !result.url ? 'text'
            : result.mime?.startsWith('video/') ? 'video'
              : result.mime?.startsWith('audio/') ? 'audio' : 'image'
          job = jobs.create(kind, graph.nodes.find((node) => node.id === nodeId)?.data.prompt ?? run.macroName,
            [], undefined, undefined, { kind: 'canvas', projectId: run.projectId, placeholderId }, true, jobId)
          job.status = 'done'
          job.result = result
          job.finishedAt = Date.now()
        }
        // create(..., internal=true) пропускает лимит АКТИВНЫХ генераций:
        // этот результат уже готов. Но сама задача публичная — иначе /api/jobs
        // вернёт клиенту 404. Снимаем флаг до первого await и записи на диск.
        job.internal = undefined
        // Никогда не enqueue: вычисление уже закончено. Сначала durable result,
        // затем выдача jobId клиенту и отметка delivered в состоянии прогона.
        await jobs.persistNow()
        run.placeholderByNode[nodeId] = placeholderId
        run.nodes[nodeId] = { ...run.nodes[nodeId], status: 'done', result, jobId }
        persist()
        await deliverJobResult(job)
        jobs.expireLater(job.id)
      },
      generate: async ({ node, prompt, refs, placeholderId, onJob, onProgress }) => {
        // Задача этого шага могла быть отправлена ДО перезапуска. Тогда её
        // надо дождаться, а не заводить новую: она уже оплачена, а восстановить
        // её умеет restoreJobs.
        const known = run.nodes[node.id]?.jobId
        if (known) {
          if (!jobs.get(known)) {
            // A saved id is proof that this step may already have been sent to
            // the provider. Never create a replacement when the durable job is
            // missing: that could submit the same paid step twice.
            throw new Error(MISSING_SAVED_JOB_ERROR)
          }
          onJob(known)
          return awaitJob(known, run.id, onProgress)
        }
        const kind = node.data.kind as JobKind
        const params = singleResultParams(node.data.params)
        // Сначала референсы: ролик к модели, которая роликов не берёт, иначе
        // сверялся бы с параметрами чужой модели (см. маршрут /generate).
        const refError = validateModelRefs(node.data.model, kind, refs)
        if (refError) throw new Error(refError)
        if (!validateModelParams(node.data.model, kind, refs, params ?? {})) throw new Error('The model is disabled or the macro parameters do not match')
        const target: CanvasJobTarget | undefined = placeholderId
          ? { kind: 'canvas', projectId: run.projectId, placeholderId }
          : undefined
        let job: Job
        try {
          job = jobs.create(kind, prompt, refs, node.data.model, params, target)
        } catch (error) {
          if (error instanceof JobLimitError) throw new Error(error.message)
          throw error
        }
        await persistAndEnqueueJob(job)
        onJob(job.id)
        return awaitJob(job.id, run.id, onProgress)
      },
      muxAudio: async (videoSrc, audioSrc) => {
        const done = await muxAudio(videoSrc, audioSrc)
        return { url: done.url, mime: done.mime }
      },
      extractAudio: async (videoSrc) => {
        const done = await extractAudio(videoSrc)
        return { url: done.url, mime: done.mime }
      },
    })
    run.delivered = delivered
    run.status = 'done'
  } catch (error) {
    if (error instanceof MacroCancelledError || cancelled.has(run.id)) {
      run.status = 'cancelled'
    } else {
      run.status = 'error'
      run.error = error instanceof Error ? error.message : 'not worked'
      logError('macro-run', `${run.macroName}: ${run.error}`)
    }
  } finally {
    run.finishedAt = Date.now()
    cancelled.delete(run.id)
    persist()
  }
}

/**
 * ⚠️ Шаг макроса ставит на доску ОДИН результат, а fal берёт деньги за каждую
 * картинку: с num_images = 4 платили вчетверо за то, что видели раз. На ноде
 * ручки количества нет (panelParams её прячет), но она остаётся в старых и
 * перенесённых из файла макросах — поэтому приводим к одной, а не отказываем:
 * отказ сломал бы такой макрос без видимой человеку причины. Обычный запуск
 * с холста отвечает на num_images ≠ 1 отказом (parseParams в routes.ts).
 */
export function singleResultParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!params || params.num_images === undefined || params.num_images === 1) return params
  return { ...params, num_images: 1 }
}

/** Только для тестов. */
export function resetMacroRuns(): void {
  runs.clear()
  cancelled.clear()
}

import type {
  BoardHolder,
  CatalogDefaults,
  CatalogModel,
  GenRef,
  GenerationQuote,
  GenerationQuoteResponse,
  Job,
  JobKind,
  JobResult,
  PricingMode,
  ProjectRef,
  RemoteAccessInfo,
  ServerStatus,
  SessionDraft,
} from './types'
import { logRepeating, resetRepeating } from './diag/log'
import { systemMessage } from './ui/systemMessage'
import { askConfirm } from './ui/confirmBus'
import { newId } from './ui/ids'
import { quoteConfirmationRequest } from './ui/quotePresentation'
import { MAX_MEDIA_UPLOAD_BYTES, MEDIA_UPLOAD_TOO_LARGE } from '../../packages/mediaUploadLimits'
import type { FfmpegStateResponse } from './settings/mediaToolsState'
import type { MacroRunState } from './spaces/canvas/macroRunClient'

import {
  JOB_FAILED,
  JOB_LOST,
  JOB_NO_CONNECTION,
  JOB_TIMED_OUT,
  MAX_CONSECUTIVE_ERRORS,
  POLL_MS,
  jobDeadlineMs,
} from './spaces/canvas/jobPolling'
import type {
  AppendHistoryMessagesInput,
  AppendHistoryMessagesResult,
  BeginTurnInput,
  BeginTurnResult,
  ConversationPage,
  ConversationPatch,
  PromptChatEstimate,
  PromptChatIndexEnvelope,
  PromptChatMetaV2,
  RecordUserMessageInput,
  RecordUserMessageResult,
  PromptChatSummary,
} from './spaces/canvas/promptChatTypes'
import type { OnboardingDocument, OnboardingPatch } from './spaces/canvas/onboardingModel'
import type { MediaImportTask, MediaLinkPreview } from './spaces/canvas/mediaImportTypes'

export interface ComponentInfo {
  id: 'ffmpeg' | 'yt-dlp' | 'face-models' | 'login-browser'
  name: string
  purpose: string
  sizeHint: string
  state: 'ready' | 'missing' | 'unsupported'
  system?: boolean
}

/** «Сообщить о проблеме» (5.9): что добавляет к жалобе сама страница. */
export interface ProblemReportRequest {
  description: string
  clientLog: string
  clientBuild: string
  userAgent: string
}

export interface FaceModelsResponse {
  state: 'ready' | 'missing' | 'downloading' | 'failed'
  percent?: number
  message?: string
  models: Array<{ name: string; license: string }>
}


// Где живёт кнопка макроса: в строке генерации или в окне помощника.
// Слоты нумеруются независимо в каждой области.
export type MacroScope = 'canvas' | 'assistant'

export interface Macro {
  id: string
  name: string
  graph: unknown
  createdAt: number
  updatedAt: number
  revision: number
  // слот-кнопка (0..8) внутри своей области
  slot?: number
  // старые макросы без поля — канвасные
  scope?: MacroScope
  /** Командная или личная библиотека на CanAI Cloud. У локальных макросов поля нет. */
  cloudScope?: 'team' | 'personal'
  /** Опубликована ТЕКУЩАЯ версия. «На полке ли» — см. `onCloudShelf`, не это поле. */
  published?: boolean
  /** Какая версия общего макроса у команды; null — снят с полки. Прежний сервер поля не присылал. */
  publishedVersionId?: string | null
  versionId?: string
  checksum?: string
}

export interface CloudMacroSubmission {
  id: string
  name: string
  note: string
  state: 'pending' | 'accepted' | 'rejected'
  createdAt: number
  updatedAt: number
}

export interface CloudAssistantSubmission {
  id: string
  name: string
  note: string
  state: 'pending' | 'accepted' | 'rejected'
  createdAt: number
  updatedAt: number
}

export interface ProjectMeta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  preview?: { src: string; kind: 'image' | 'video' } | null
  thumb?: string | null
}

export interface TrashedProjectMeta extends ProjectMeta {
  preview?: { src: string; kind: 'image' | 'video' } | null
  itemCount?: number
  trashedAt: number
}

export interface ProjectVersion {
  id: string
  createdAt: number
  items?: number
  preview?: string
}


export type EditProjectStatus = 'active' | 'trashed' | 'missing'
export type ExternalEditState = 'waiting' | 'ready' | 'applied' | 'broken'

export interface PublicEditSession {
  id: string
  projectId: string
  boardSource?: 'local'
  boardName?: string
  sourceItemId: string
  sourceName: string
  fileName: string
  url: string
  createdAt: number
  expiresAt: number
  lastMtime: number
  appliedMtime: number
  placedItemId: string | null
  state: ExternalEditState
  error?: string
  projectName: string | null
  projectStatus: EditProjectStatus
}

export interface StartEditSessionInput {
  src: string
  projectId: string
  sourceItemId: string
  sourceName: string
  /** Командная доска: локального индекса досок, где её искать, не существует. */
  boardSource?: 'local'
  boardName?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let optimiseLargeImages = false

export function uploadMimeFromName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.ogv')) return 'video/ogg'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.m4v')) return 'video/x-m4v'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.wav')) return 'audio/wav'
  return ''
}

export class ApiError extends Error {
  readonly originalMessage: string
  code?: string
  details?: unknown
  estimate?: PromptChatEstimate
  quote?: GenerationQuoteResponse['quote']
  idempotencyKey?: string
  // HTTP-статус ответа: 404 у опроса задачи означает «сервер её забыл»
  status?: number
  // ⚠️ Подробности нужны УЖЕ в конструкторе: по ним собирается текст отказа
  // (paramRefusal.ts), а присвоенные после `super` они до него не доезжали.
  constructor(message: string, code?: string, status?: number, details?: unknown) {
    super(systemMessage(message, undefined, code, details))
    this.originalMessage = message
    this.code = code
    this.status = status
    this.details = details
  }
}

export const LOCAL_SERVICE_UNAVAILABLE = 'LOCAL_SERVICE_UNAVAILABLE'
export const LOCAL_SERVICE_UNAVAILABLE_MESSAGE = 'CanAI is temporarily unavailable'

export function isLocalServiceUnavailable(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === LOCAL_SERVICE_UNAVAILABLE
}

function localServiceUnavailable(status?: number): ApiError {
  return new ApiError(
    LOCAL_SERVICE_UNAVAILABLE_MESSAGE,
    LOCAL_SERVICE_UNAVAILABLE,
    status,
  )
}

function isGatewayFailureWithoutBody(status: number, body: unknown): boolean {
  return body === null && [500, 502, 503, 504].includes(status)
}

/** Метод и путь без строки запроса — ключ, по которому сжимаются повторы. */
function requestKey(url: string, init?: RequestInit): string {
  return `${init?.method ?? 'GET'} ${url.split('?')[0]}`
}

async function request<T>(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const controller = init?.signal ? null : new AbortController()
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : undefined
  let responseReceived = false
  try {
    const res = await fetch(url, controller ? { ...init, signal: controller.signal } : init)
    responseReceived = true
    const body = (await res.json().catch(() => null)) as {
      error?: string
      code?: string
      details?: unknown
      estimate?: PromptChatEstimate
      quote?: GenerationQuoteResponse['quote']
      idempotencyKey?: string
    } | null
    if (!res.ok) {
      if (isGatewayFailureWithoutBody(res.status, body)) {
        throw localServiceUnavailable(res.status)
      }
      const error = new ApiError(
        body?.error ?? `Server error (HTTP ${res.status})`,
        body?.code,
        res.status,
        body?.details,
      )
      error.estimate = body?.estimate
      error.quote = body?.quote
      error.idempotencyKey = body?.idempotencyKey
      logRepeating('warn', 'net', 'server returned an error', `${requestKey(url, init)}:${res.status}`, {
        request: requestKey(url, init),
        status: res.status,
        error: error.originalMessage,
        code: body?.code,
      })
      throw error
    }
    resetRepeating(`${requestKey(url, init)}:network`)
    // Status endpoints can return HTTP 200 with a persisted server failure.
    // Translate only the envelope's system error, never board/chat content.
    if (typeof body?.error === 'string') {
      const error = systemMessage(body.error, undefined, body.code, body.details)
      if (error !== body.error) {
        logRepeating('warn', 'net', 'server reported an error', `${requestKey(url, init)}:stored-error`, {
          request: requestKey(url, init), error: body.error,
        })
        return { ...body, error } as T
      }
    }
    return body as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    logRepeating('warn', 'net', 'request did not reach server', `${requestKey(url, init)}:network`, {
      request: requestKey(url, init),
      reason: controller?.signal.aborted ? 'timed out' : 'connection failed',
      error: err instanceof Error ? err.message : String(err),
    })
    if (controller?.signal.aborted || !responseReceived) throw localServiceUnavailable()
    throw err
  } finally {
    if (timer != null) window.clearTimeout(timer)
  }
}

export const apiRequest = request

/** Одна запись ожидания задач (см. server/src/jobWait.ts). */
export interface JobWaitEntry {
  id: string
  /** Отметка состояния: присылаем её обратно, и сервер ждёт, пока она сменится. */
  version: string
  job?: Job
  /** Задачи нет и не будет — то же, что 404 при поимённом опросе. */
  missing?: true
  failure?: { status: number; error: string }
}

/** Сколько сервер держит ожидание задач. */
export const JOB_WAIT_MS = 15_000

/**
 * Состояние задач одним запросом, с ожиданием изменения (пункт 3.7): ответ
 * приходит в тот же миг, когда исполнитель узнал новость, а не по опросу
 * каждой задачи раз в 0,9 с.
 *
 * ⚠️ `priority: 'low'`: пока в пути три и больше обычных fetch, Chrome
 * придерживает картинки доски по 15 секунд, а этот запрос живёт до пятнадцати
 * секунд по построению (см. «Три долгих fetch» в заметках проекта).
 * ⚠️ null — сервер такого не умеет: реестр вернётся к опросу по одной задаче.
 */
async function waitJobs(
  ids: readonly string[],
  seen: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<JobWaitEntry[] | null> {
  const controller = new AbortController()
  const forward = () => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', forward, { once: true })
  const timer = window.setTimeout(() => controller.abort(), JOB_WAIT_MS + 15_000)
  try {
    const response = await fetch('/api/jobs/wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, seen, waitMs: JOB_WAIT_MS }),
      signal: controller.signal,
      priority: 'low',
    })
    if (response.status === 403 || response.status === 404 || response.status === 405) return null
    const body = await response.json().catch(() => null) as { entries?: unknown; error?: string; code?: string } | null
    if (!response.ok || !body || !Array.isArray(body.entries)) {
      throw new ApiError(body?.error ?? `Server error (HTTP ${response.status})`, body?.code, response.status)
    }
    return body.entries as JobWaitEntry[]
  } finally {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', forward)
  }
}

function post<T>(url: string, payload: unknown, timeoutMs?: number): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, timeoutMs)
}

/**
 * Ручка правки клипа. У файла сетевой доски она своя: файл живёт в кэше, а
 * общие ручки `/api/media/*` принимают только файлы своей доски — на сетевой
 * доске нарезка, поиск склеек и волна отвечали «Ожидается ссылка на файл в
 * media» (находка Ф-3 аудита 24.09.2026, см. server/src/cloudMediaTools.ts).
 */
function mediaToolUrl(_src: string, tool: string): string { return `/api/media/${tool}` }

/**
 * Правке клипа мало общих 30 секунд: пережатие длинного ролика идёт минутами,
 * а у сетевой доски сперва докачивается сам файл. Оборванное ожидание человек
 * увидел бы как «приложение недоступно», хотя работа идёт.
 */
const MEDIA_TOOL_TIMEOUT_MS = 10 * 60_000

// Отправка большой локальной доски включает загрузку всех ещё не отправленных
// медиа. Общий сетевой предел в 30 секунд для этой операции слишком короткий.
const CLOUD_BOARD_COPY_TIMEOUT_MS = 15 * 60_000

async function compressImageIfNeeded(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type.includes('svg') || file.type.includes('gif')) {
    return file
  }
  if (file.size <= 5 * 1024 * 1024) {
    return file
  }
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      const url = URL.createObjectURL(file)
      el.onload = () => {
        URL.revokeObjectURL(url)
        resolve(el)
      }
      el.onerror = (err) => {
        URL.revokeObjectURL(url)
        reject(err)
      }
      el.src = url
    })

    const maxSide = 2560
    let { width, height } = img
    if (width > maxSide || height > maxSide) {
      if (width > height) {
        height = Math.round((height * maxSide) / width)
        width = maxSide
      } else {
        width = Math.round((width * maxSide) / height)
        height = maxSide
      }
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return file

    ctx.drawImage(img, 0, 0, width, height)

    const targetMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, targetMime, 0.88)
    })

    if (blob && blob.size < file.size) {
      const ext = targetMime === 'image/jpeg' ? '.jpg' : '.png'
      return new File([blob], file.name.replace(/\.[^.]+$/, ext), { type: blob.type })
    }
  } catch (e) {
    console.warn('[CanAI] Image compression skipped:', e)
  }
  return file
}

export interface AssistantDoc {
  id: string
  name: string
  chars: number
}

export interface AssistantPreset {
  id: string
  name: string
  instructions: string
  modelId: string
  docs: AssistantDoc[]
  slot: number
}

export interface AssistantsState {
  presets: AssistantPreset[]
  activeId: string | null
}

export interface CloudAssistantProfile {
  id: string
  scope: 'team' | 'personal'
  versionId: string
  version: number
  name: string
  instructions: string
  modelId: string
  /** Опубликована ТЕКУЩАЯ версия. «На полке ли» — см. `onCloudShelf`, не это поле. */
  published: boolean
  /** Какая версия общего помощника у команды; null — снят с полки. Прежний сервер поля не присылал. */
  publishedVersionId?: string | null
  createdAt: number
  updatedAt: number
}

export interface CloudAssistantsState {
  items: CloudAssistantProfile[]
  activeId: string | null
}

export interface CloudMacroQuote {
  quoteHash: string
  amountMicro: number
  amountUsd: number
  needsConfirmation: boolean
  guaranteed: boolean
  meteredUncapped?: boolean
  /** General team confirmation threshold in micro-dollars; `0` disables it. */
  confirmAboveMicro?: number
  pricingMode?: PricingMode
  nodeAmounts: Record<string, number>
  nodeRevisions: Record<string, { contract: string; tariff: string }>
}

export interface GenerationSubmitOptions {
  /** Стабильный ключ preflight и последующего платного submit. */
  idempotencyKey?: string
  quoteId?: string
  quoteHash?: string
  quoteConfirmed?: boolean
}

/** Text-only canvas action preparation. It never carries a media model or
 * launch parameters; the reviewed result is sent to the existing generator. */
export interface CanvasActionPreparationInput {
  projectRef: ProjectRef
  prompt: string
  refs: Extract<GenRef, { kind: 'image' }>[]
  /** `null` is the explicit Universal profile; omitted uses the active one. */
  assistantId?: string | null
  profileVersionId?: string | null
  idempotencyKey?: string
  quoteId?: string
  quoteHash?: string
  quoteConfirmed?: boolean
}

export interface CanvasActionPreparationProfile {
  id: string | null
  versionId: string | null
  modelId: string
}

export interface CanvasActionPreparationStart {
  jobId: string
  status: Job['status']
  idempotencyKey: string
  profile: CanvasActionPreparationProfile
  quote: GenerationQuote | null
}

export interface CanvasActionPreparationStatus extends CanvasActionPreparationStart {
  progressText?: string
  error?: string
  result?: { text: string }
  chargedAmountUsd?: number | null
}

type GenerationTarget = import('./spaces/canvas/generationLaunches').GenerationCanvasTarget

let generationConfirmationTail: Promise<void> = Promise.resolve()

async function confirmGenerationQuote(quote: GenerationQuote, model?: string): Promise<boolean> {
  const previous = generationConfirmationTail
  let release!: () => void
  generationConfirmationTail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    return await askConfirm(quoteConfirmationRequest({
      amountUsd: quote.amountUsd,
      quantity: quote.quantity,
      model,
      pricingMode: quote.pricingMode,
      guaranteed: quote.guaranteed,
      meteredUncapped: quote.meteredUncapped,
      quantityLabel: 'Results',
    }))
  } finally {
    release()
  }
}

export const api = {
  status: () => request<ServerStatus>('/api/status'),

  /**
   * Сообщает серверу, что результаты пошли в дело.
   *
   * ⚠️ Вызывается ПОСЛЕ действия и своей ошибкой ничего не ломает: файлы уже
   * у человека, и красная плашка из-за метрики была бы хуже недосчитанной
   * метрики.
   */
  reportGenerationOutcome: (jobIds: string[], kind: 'exported' | 'published' | 'archived' | 'discarded') =>
    jobIds.length === 0
      ? Promise.resolve({ marked: 0 })
      : request<{ marked: number }>('/api/generation-outcomes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobIds, kind }),
        }).catch(() => ({ marked: 0 })),

  getFalBalance: () => request<{ balance: number | null; currency?: string; error?: string }>('/api/fal-balance'),

  getFalHistory: (cursor?: string) =>
    request<{
      events: Array<{ id: string; endpoint: string; cost: number; time: string }>
      nextCursor: string | null
      hasMore: boolean
      error?: string
    }>(`/api/fal-history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),

  models: () => request<{ models: CatalogModel[]; defaults?: CatalogDefaults; defaultIssues?: string[] }>('/api/models'),

  // target — доска, на которую встанет результат. Она нужна не открытому
  // клиенту (он и так опрашивает задачу), а серверу: если приложение закрыли
  // до конца генерации, результат поставит он сам.
  generate: async (
    kind: JobKind,
    prompt: string,
    refs: GenRef[],
    model?: string,
    params?: Record<string, unknown>,
    target?: GenerationTarget,
    options?: GenerationSubmitOptions,
  ): Promise<{ jobId: string }> => post<{ jobId: string }>('/api/generate', {
    kind, prompt, refs, model, params, target, ...(options ?? {}),
  }),

  quoteGeneration: (
    kind: JobKind,
    prompt: string,
    refs: GenRef[],
    model: string,
    params: Record<string, unknown> | undefined,
    target: import('./spaces/canvas/generationLaunches').GenerationCanvasTarget,
    idempotencyKey: string,
  ) => post<GenerationQuoteResponse>('/api/generation-quotes', {
    kind, prompt, refs, model, params, target, idempotencyKey,
  }),

  prepareCanvasAction: (input: CanvasActionPreparationInput) =>
    post<CanvasActionPreparationStart>('/api/canvas/actions/prepare', input, 10 * 60_000),

  getCanvasAction: (id: string) =>
    request<CanvasActionPreparationStatus>(`/api/canvas/actions/prepare/${encodeURIComponent(id)}`),

  cancelCanvasAction: (id: string) =>
    post<{ ok: boolean; status?: string }>(
      `/api/canvas/actions/prepare/${encodeURIComponent(id)}/cancel`,
      {},
    ),

  job: (id: string) => request<Job>(`/api/jobs/${id}`),

  waitJobs,

  cancelJob: (id: string) => post<{ ok: boolean }>(`/api/jobs/${id}/cancel`, {}),

  previewMediaLink: (url: string) =>
    post<MediaLinkPreview>('/api/media-imports/preview', { url }, 120_000),

  startMediaImport: (url: string, entryIds?: string[]) =>
    post<{ task: MediaImportTask }>('/api/media-imports', { url, entryIds }, 120_000),

  mediaImport: (id: string) =>
    request<{ task: MediaImportTask }>(`/api/media-imports/${encodeURIComponent(id)}`),

  cancelMediaImport: (id: string) =>
    post<{ task: MediaImportTask }>(`/api/media-imports/${encodeURIComponent(id)}/cancel`, {}),

  directVideoPreviewUrl: (url: string) =>
    `/api/media-imports/direct-preview?url=${encodeURIComponent(url)}`,

  getOnboarding: async (): Promise<OnboardingDocument> => {
    const { onboarding } = await request<{ onboarding: OnboardingDocument }>('/api/onboarding')
    return onboarding
  },

  patchOnboarding: async (patch: OnboardingPatch): Promise<OnboardingDocument> => {
    const { onboarding } = await request<{ onboarding: OnboardingDocument }>('/api/onboarding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    return onboarding
  },

  // ── доски (проекты) ───────────────────────────────────────
  listProjects: () => request<{ projects: ProjectMeta[] }>('/api/projects'),

  createProject: (name?: string, initialSnapshot?: unknown) =>
    post<{ project: ProjectMeta }>('/api/projects', { name, initialSnapshot }),

  updateProject: (id: string, patch: { name?: string; pinned?: boolean }) =>
    request<{ project: ProjectMeta }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  renameProject: (id: string, name: string) => api.updateProject(id, { name }),

  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  listProjectTrash: () => request<{ projects: TrashedProjectMeta[] }>('/api/project-trash'),

  // Очистить корзину целиком: по одной доске шесть десятков не удалишь.
  emptyProjectTrash: () =>
    request<{ deleted: number }>('/api/project-trash', { method: 'DELETE' }),

  restoreTrashedProject: (id: string) =>
    post<{ project: ProjectMeta }>(`/api/project-trash/${encodeURIComponent(id)}/restore`, {}),

  deleteTrashedProject: (id: string) =>
    request<{ ok: boolean }>(`/api/project-trash/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listProjectVersions: (id: string) =>
    request<{ versions: ProjectVersion[] }>(`/api/projects/${encodeURIComponent(id)}/versions`),

  restoreProjectVersion: (id: string, version: string) =>
    post<{ project: ProjectMeta }>(
      `/api/projects/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/restore`,
      {},
    ),

  loadProject: (projectId: string) =>
    request<{ snapshot: unknown; revision: number; missingMedia?: string[] }>(`/api/project?project=${encodeURIComponent(projectId)}`),

  saveProject: (projectId: string, snapshot: unknown, expectedRevision: number, conflictKey?: string) =>
    post<{ ok: boolean; revision: number }>(`/api/project?project=${encodeURIComponent(projectId)}`, {
      snapshot,
      expectedRevision,
      conflictKey,
    }),

  // Макросы исполняет СЕРВЕР: браузер просит начать и потом смотрит. Уходить
  // со страницы можно в любой момент — прогон от неё не зависит.
  macroPlan: (macroId: string) =>
    request<{ deliveringNodeIds: string[] }>(`/api/macros/${encodeURIComponent(macroId)}/plan`),

  startMacroRun: (
    macroId: string,
    input: { requestId: string; project: string; refs: unknown; snapshot?: unknown; placeholderIds: string[] },
  ) => post<{ run: MacroRunState }>(`/api/macros/${encodeURIComponent(macroId)}/run`, input),

  listMacroRuns: (projectId?: string) =>
    request<{ runs: MacroRunState[] }>(
      `/api/macro-runs${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`,
    ),

  cancelMacroRun: (runId: string) =>
    post<{ ok: boolean }>(`/api/macro-runs/${encodeURIComponent(runId)}/cancel`, {}),

  // Доступ с планшета настраивается ТОЛЬКО отсюда, с компьютера: сам планшет
  // этих ручек не видит (см. server/src/remoteAllowlist.ts).
  remoteAccess: () => request<RemoteAccessInfo>('/api/remote-access'),

  setRemotePin: (pin: string) => post<RemoteAccessInfo>('/api/remote-access/pin', { pin }),

  setRemoteEnabled: (enabled: boolean) => post<RemoteAccessInfo>('/api/remote-access', { enabled }),

  revokeRemoteDevices: () => post<RemoteAccessInfo>('/api/remote-access/revoke', {}),

  loadSessionDraft: (projectId: string) =>
    request<{ draft: SessionDraft | null; device?: string; updatedAt?: number }>(
      `/api/session-draft?project=${encodeURIComponent(projectId)}`,
    ),

  saveSessionDraft: (projectId: string, draft: SessionDraft, device: string) =>
    post<{ ok: boolean; draft?: SessionDraft | null; updatedAt?: number }>(
      `/api/session-draft?project=${encodeURIComponent(projectId)}`,
      { draft, device },
    ),

  // У командной доски черновик принадлежит аккаунту на сервере команды, а не
  // локальному gateway: иначе desktop и Cloud tablet видели бы разные рычаги.
  boardPresence: (projectId?: string) =>
    request<{ holder?: BoardHolder | null; boards?: Array<{ projectId: string; holder: BoardHolder }> }>(
      `/api/board-presence${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`,
    ),

  boardPresenceAction: (
    projectId: string,
    clientId: string,
    device: string,
    action: 'claim' | 'heartbeat' | 'release',
    visible = true,
  ) =>
    post<{ holder: BoardHolder | null; mine: boolean }>('/api/board-presence', {
      project: projectId,
      clientId,
      device,
      action,
      visible,
    }),

  listPromptChats: (projectId: string) =>
    request<PromptChatIndexEnvelope>(
      `/api/prompt-chats?project=${encodeURIComponent(projectId)}`,
    ),

  setPromptChatPreferences: (projectId: string, patch: { boardMemoryEnabled: boolean }) =>
    request<PromptChatIndexEnvelope>(
      `/api/prompt-chats/preferences?project=${encodeURIComponent(projectId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    ),

  createPromptChat: (projectId: string, requestId: string) =>
    post<{ conversation: PromptChatMetaV2 }>(
      `/api/prompt-chats?project=${encodeURIComponent(projectId)}`,
      { requestId },
    ),

  loadPromptChatPage: (
    projectId: string,
    conversationId: string,
    before?: string,
  ) =>
    request<ConversationPage>(
      `/api/prompt-chats/${encodeURIComponent(conversationId)}?project=${encodeURIComponent(projectId)}&limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    ),

  patchPromptChat: (
    projectId: string,
    conversationId: string,
    requestId: string,
    patch: ConversationPatch,
  ) =>
    request<{ meta: PromptChatMetaV2 }>(
      `/api/prompt-chats/${encodeURIComponent(conversationId)}?project=${encodeURIComponent(projectId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, ...patch }),
      },
    ),

  activatePromptChat: (
    projectId: string,
    conversationId: string,
    requestId: string,
  ) =>
    post<{ meta: PromptChatMetaV2 }>(
      `/api/prompt-chats/${encodeURIComponent(conversationId)}/activate?project=${encodeURIComponent(projectId)}`,
      { requestId },
    ),

  estimatePromptChatMessage: (
    projectId: string,
    conversationId: string,
    text: string,
    attachments: BeginTurnInput['attachments'],
    boardMemoryEnabled?: boolean,
  ) =>
    post<PromptChatEstimate>(
      `/api/prompt-chats/${encodeURIComponent(conversationId)}/estimate?project=${encodeURIComponent(projectId)}`,
      { text, attachments, ...(boardMemoryEnabled === undefined ? {} : { boardMemoryEnabled }) },
    ),

  sendPromptChatMessage: (
    projectId: string,
    conversationId: string,
    input: BeginTurnInput,
  ) =>
    post<BeginTurnResult>(
      `/api/prompt-chats/${encodeURIComponent(conversationId)}/messages?project=${encodeURIComponent(projectId)}`,
      input,
    ),

  recordPromptChatMessage: (
    projectId: string,
    conversationId: string,
    input: RecordUserMessageInput,
  ) =>
    post<RecordUserMessageResult>(
      `/api/prompt-chats/${encodeURIComponent(conversationId)}/history?project=${encodeURIComponent(projectId)}`,
      input,
    ),

  appendPromptChatHistoryMessages: (
    projectId: string,
    conversationId: string,
    input: AppendHistoryMessagesInput,
  ) =>
    post<AppendHistoryMessagesResult>(
      `/api/prompt-chats/${encodeURIComponent(conversationId)}/history/events?project=${encodeURIComponent(projectId)}`,
      input,
    ),

  rebuildPromptChatContext: (
    projectId: string,
    conversationId: string,
  ) =>
    post<{ status: 'skipped' | 'confirmation-required' | 'queued' }>(
      `/api/prompt-chats/${encodeURIComponent(conversationId)}/context/rebuild?project=${encodeURIComponent(projectId)}`,
      {},
    ),

  trashPromptChat: (
    projectId: string,
    conversationId: string,
    requestId: string,
  ) =>
    request<{ ok: true }>(
      `/api/prompt-chats/${encodeURIComponent(conversationId)}?project=${encodeURIComponent(projectId)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      },
    ),

  listPromptChatTrash: (projectId: string) =>
    request<{ conversations: PromptChatSummary[] }>(
      `/api/prompt-chats/trash?project=${encodeURIComponent(projectId)}`,
    ),

  restorePromptChat: (
    projectId: string,
    conversationId: string,
    requestId: string,
  ) =>
    post<{ conversation: PromptChatMetaV2 }>(
      `/api/prompt-chats/${encodeURIComponent(conversationId)}/restore?project=${encodeURIComponent(projectId)}`,
      { requestId },
    ),

  deletePromptChatPermanent: (
    projectId: string,
    conversationId: string,
    requestId: string,
  ) =>
    request<{ ok: true }>(
      `/api/prompt-chats/${encodeURIComponent(conversationId)}/permanent?project=${encodeURIComponent(projectId)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      },
    ),

  // миграция старых base64-ассетов (data-URL из проекта)
  uploadAsset: (dataUrl: string) => post<{ url: string; mime: string }>('/api/assets', { dataUrl }),

  async uploadFile(file: File, signal?: AbortSignal, onProgress?: (loaded: number, total: number) => void): Promise<{ url: string; mime: string }> {
    let payloadFile = optimiseLargeImages ? await compressImageIfNeeded(file) : file
    if (payloadFile.size > MAX_MEDIA_UPLOAD_BYTES) throw new ApiError(MEDIA_UPLOAD_TOO_LARGE, 'FILE_TOO_LARGE', 413)
    
    // На Windows MIME часто пустой или нестандартный. Для поддерживаемого
    // аудио нормализуем его по расширению, чтобы fal получил MP3/WAV.
    if (payloadFile.name) {
      const mime = uploadMimeFromName(payloadFile.name)
      
      if (mime && (!payloadFile.type || mime.startsWith('audio/'))) {
        payloadFile = new File([payloadFile], payloadFile.name, { type: mime })
      }
    }

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Upload cancelled', 'AbortError'))
        return
      }
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/assets/upload')
      xhr.setRequestHeader('Content-Type', payloadFile.type || 'application/octet-stream')
      xhr.upload.onprogress = (event) => onProgress?.(event.loaded, event.total || payloadFile.size)
      xhr.onerror = () => reject(new ApiError('The connection was interrupted during upload'))
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))
      xhr.onload = () => {
        type UploadResponse = { url?: string; mime?: string; error?: string }
        let body: UploadResponse | null = null
        try {
          body = JSON.parse(xhr.responseText || 'null') as UploadResponse | null
        } catch {
          reject(new ApiError(
            xhr.status >= 200 && xhr.status < 300
              ? 'The server returned an invalid upload response'
              : `Upload error (HTTP ${xhr.status})`,
          ))
          return
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new ApiError(body?.error ?? `Upload error (HTTP ${xhr.status})`))
        } else if (!body || typeof body.url !== 'string' || typeof body.mime !== 'string') {
          reject(new ApiError('The server returned an invalid upload response'))
        } else {
          resolve({ url: body.url, mime: body.mime })
        }
      }
      signal?.addEventListener('abort', () => xhr.abort(), { once: true })
      xhr.send(payloadFile)
    })
  },

  getSettings: async () => {
    const settings = await request<{
      externalEditorPath: string | null
      /** Система, на которой работает приложение: подсказки путей у Windows и
       *  macOS разные. Поле новое — старый сервер его не пришлёт. */
      platform?: string
      falKeySet: boolean
      optimiseLargeImages: boolean
      confirmCostAboveUsd: number
      assistantModelId: string
      assistantSystemPrompt: string
      shareLanAccess?: boolean
      faceThreshold?: number
      /** Вход на площадки для импорта по ссылке. Поля новые — старый сервер
       *  их не пришлёт, и тогда вход просто не настроен. */
      extractorCookiesMode?: 'none' | 'app' | 'file'
      extractorCookiesFile?: string | null
      /** Дневной лимит оплачиваемых локальных генераций с планшета, 0 = выключено. */
      tabletDailyGenerationLimit?: number
      /** Дневной лимит подтверждённых ПЛАТНЫХ решений агентов с планшета, 0 = выключено. */
      tabletApproveDailyLimit?: number
    }>('/api/settings')
    optimiseLargeImages = settings.optimiseLargeImages
    return settings
  },

  sendProblemReport: (input: ProblemReportRequest) =>
    post<{ id: string }>('/api/diagnostics/report', { ...input, mode: 'send' }, 90_000),
  problemReportBundle: (input: ProblemReportRequest) =>
    post<{ report: unknown }>('/api/diagnostics/report', { ...input, mode: 'bundle' }),

  // Копия сетевых досок на этом компьютере (6.2).
  saveSettings: async (
    externalEditorPath: string | null,
    falKey?: string | null,
    optimise?: boolean,
    confirmCostAboveUsd?: number,
    assistantModelId?: string,
    assistantSystemPrompt?: string,
    shareLanAccess?: boolean,
    faceThreshold?: number,
    /** Вход на площадки — одним объектом: позиционных доводов тут и так много,
     *  и перепутать три подряд строки было бы слишком легко. */
    extractorCookies?: { mode: 'none' | 'app' | 'file'; file: string | null },
    /** Дневной лимит оплачиваемых локальных генераций с планшета, 0 = выключено. */
    tabletDailyGenerationLimit?: number,
    /** Дневной лимит подтверждённых ПЛАТНЫХ решений агентов с планшета, 0 = выключено. */
    tabletApproveDailyLimit?: number,
  ) => {
    const result = await post<{ ok: boolean }>('/api/settings', {
      externalEditorPath,
      falKey,
      optimiseLargeImages: optimise,
      confirmCostAboveUsd,
      assistantModelId,
      assistantSystemPrompt,
      shareLanAccess,
      faceThreshold,
      extractorCookiesMode: extractorCookies?.mode,
      extractorCookiesFile: extractorCookies?.file,
      tabletDailyGenerationLimit,
      tabletApproveDailyLimit,
    })
    if (typeof optimise === 'boolean') optimiseLargeImages = optimise
    return result
  },

  // Частичная правка настроек БЕЗ секретов: порог сходства лиц, порог
  // подтверждения цены, модель помощника. Ею пользуется планшет — ключ fal
  // туда не пускают по построению, а рабочие пороги править надо.
  patchSettings: async (patch: {
    confirmCostAboveUsd?: number
    faceThreshold?: number
    optimiseLargeImages?: boolean
    assistantModelId?: string
  }) => {
    const result = await request<{ ok: boolean }>('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (typeof patch.optimiseLargeImages === 'boolean') optimiseLargeImages = patch.optimiseLargeImages
    return result
  },

  // Склейка видео и звука — локальная операция нашего ffmpeg, денег не стоит.
  muxAudio: (video: string, audio: string) =>
    post<{ url: string; mime: string }>('/api/media/mux-audio', { video, audio }),
  extractAudio: (src: string) =>
    post<{ url: string; mime: string; duration?: number; peaks?: number[] }>(mediaToolUrl(src, 'extract-audio'), { src }, MEDIA_TOOL_TIMEOUT_MS),
  audioPeaks: (src: string) => post<{ peaks?: number[] }>(mediaToolUrl(src, 'audio-peaks'), { src }, MEDIA_TOOL_TIMEOUT_MS),
  probeVideo: (src: string) =>
    post<{ duration: number; width?: number; height?: number; fps?: number; hasAudio: boolean }>(
      mediaToolUrl(src, 'probe-video'),
      { src },
      MEDIA_TOOL_TIMEOUT_MS,
    ),
  /**
   * Ролик сетевой доски начали смотреть — свой сервер скачает его целиком, и
   * перемотка с повтором пойдут с диска. Без просьбы качается только кусок:
   * раньше целиком качался КАЖДЫЙ видимый ролик сразу при открытии доски
   * (находка Ф-2 аудита 24.09.2026, см. `/warm` в server/src/cloudAssets.ts).
   */
  detectShots: (src: string) =>
    post<{ candidates: Array<{ time: number; score: number }> }>(mediaToolUrl(src, 'detect-shots'), { src }, MEDIA_TOOL_TIMEOUT_MS),
  cutVideo: (
    src: string,
    segments: Array<{ start: number; end: number }>,
    crop?: { x: number; y: number; w: number; h: number },
  ) =>
    post<{ pieces: Array<{ url: string; mime: string; duration: number; width?: number; height?: number }> }>(
      mediaToolUrl(src, 'cut-video'),
      { src, segments, crop },
      MEDIA_TOOL_TIMEOUT_MS,
    ),

  // Номера для экспорта: сервер выдаёт и ЗАПОМИНАЕТ их, поэтому повторный
  // экспорт той же метки продолжает нумерацию, а не начинает с единицы.
  reserveExportNumbers: (project: string, groups: Array<{ mark: number; count: number }>) =>
    post<{ board: string; starts: Record<string, number> }>(
      "/api/exports/reserve",
      { project, groups },
    ),

  ffmpegState: () => request<FfmpegStateResponse>('/api/media-tools/ffmpeg'),
  prepareFfmpeg: () => post<FfmpegStateResponse>('/api/media-tools/ffmpeg/prepare', {}),

  // Модели сравнения лиц: состояние и загрузка по кнопке (файлы отдаёт сервер
  // из runtime/face-models, считает браузер).
  // Опись портативных компонентов: только смотрит, ничего не качает.
  components: () => request<{ components: ComponentInfo[] }>('/api/components'),
  faceModelsState: () => request<FaceModelsResponse>('/api/face-models'),
  prepareFaceModels: () => post<FaceModelsResponse>('/api/face-models/prepare', {}),

  browseEditor: () => post<{ path: string }>('/api/settings/editor/browse', {}),
  browseCookiesFile: () => post<{ path: string }>('/api/settings/cookies/browse', {}),

  /** Вход на площадку прямо с карточки ссылки — см. server/loginBrowser.ts. */
  extractorLogin: () => request<{
    available: boolean
    signedIn: boolean
    mode: string
    browser?: import('./settings/extractorLoginState').LoginBrowserState
  }>('/api/extractor-login'),
  prepareLoginBrowser: () => post<{
    browser?: import('./settings/extractorLoginState').LoginBrowserState
  }>('/api/extractor-login/prepare', {}),
  openExtractorLogin: (provider: string) => post<{ ok: boolean }>('/api/extractor-login/open', { provider }),
  forgetExtractorLogin: () => post<{ ok: boolean }>('/api/extractor-login/forget', {}),
  testEditor: (path: string) => post<{ ok: boolean; message: string }>('/api/settings/editor/test', { path }),

  listEditSessions: async () =>
    (await request<{ sessions: PublicEditSession[] }>('/api/edit-sessions')).sessions,

  startEditSession: (input: StartEditSessionInput) =>
    post<PublicEditSession>('/api/edit-sessions', input),

  acknowledgeEditSession: (
    id: string,
    input: { appliedMtime: number; placedItemId: string },
  ) => request<{ session: PublicEditSession }>(`/api/edit-sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }),

  stopEditSession: (id: string) =>
    request<{ ok: true }>(`/api/edit-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  editSessionMtime: (id: string) => request<{ mtime: number }>(`/api/edit-sessions/${id}`),

  revealFile: async (src: string) => {
    if (!src.startsWith('/media/')) throw new Error('Invalid local media path.')
    return post<{ ok: boolean }>('/api/media/reveal', { src })
  },

  // нодовые workflow (workflow-draft — легаси, клиент им больше не пользуется)
  // Помощники: пресет = имя + инструкции + модель + документы знаний.
  // Включён ровно один (или ни одного) — кнопки в окне помощника переключают.
  listAssistants: () => request<AssistantsState>('/api/assistants'),
  saveAssistant: (input: { id?: string | null; name: string; instructions: string; modelId: string }) =>
    post<{ preset: AssistantPreset }>('/api/assistants', input),
  // Копия делается НА СЕРВЕРЕ: вместе с пресетом надо скопировать файлы
  // документов, а они лежат на диске — клиент их не видит.
  duplicateAssistant: (id: string) =>
    post<{ preset: AssistantPreset }>(`/api/assistants/${encodeURIComponent(id)}/duplicate`, {}),
  deleteAssistant: (id: string) =>
    request<{ ok: boolean }>(`/api/assistants/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Файл обмена: помощник целиком, с текстами документов знаний (их клиент
  // иначе не видит — только имя и длину).
  exportAssistant: (id: string) =>
    request<{ name: string; instructions: string; modelId: string; docs: Array<{ name: string; text: string }> }>(
      `/api/assistants/${encodeURIComponent(id)}/export`,
    ),
  // `notes` — что при приёме пришлось урезать (инструкции, лишние документы):
  // молча обрезанный помощник выглядел бы «тем же самым, только поглупевшим».
  importAssistant: (input: { name: string; instructions: string; modelId: string; docs: Array<{ name: string; text: string }> }) =>
    post<{ preset: AssistantPreset; notes?: string[] }>('/api/assistants/import', input),
  setActiveAssistant: (id: string | null) => post<AssistantsState>('/api/assistants/active', { id }),
  addAssistantDoc: (presetId: string, name: string, text: string) =>
    request<{ doc: AssistantDoc }>(`/api/assistants/${encodeURIComponent(presetId)}/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'x-file-name': encodeURIComponent(name) },
      body: text,
    }),
  removeAssistantDoc: (presetId: string, docId: string) =>
    request<{ ok: boolean }>(
      `/api/assistants/${encodeURIComponent(presetId)}/docs/${encodeURIComponent(docId)}`,
      { method: 'DELETE' },
    ),
  listMacros: () => request<{ macros: Macro[] }>('/api/macros'),
  saveMacro: (
    name: string,
    graph: unknown,
    id?: string,
    slot?: number,
    baseRevision?: number,
    scope: MacroScope = 'canvas',
  ) => post<{ macro: Macro }>('/api/macros', { name, graph, id, slot, baseRevision, scope }),
  // порядок кнопок области целиком: слот = позиция в списке, одной записью
  reorderMacros: (scope: MacroScope, ids: string[]) =>
    post<{ macros: Macro[] }>('/api/macros/order', { scope, ids }),
  deleteMacro: (id: string, baseRevision: number) =>
    request<{ ok: boolean }>(`/api/macros/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision }),
    }),

  // запустить генерацию и дождаться результата (для движка нод и макросов)
  async generateAndWait(
    kind: JobKind,
    prompt: string,
    refs: GenRef[],
    model?: string,
    params?: Record<string, unknown>,
    onProgress?: (text: string) => void,
    isCancelled?: () => boolean,
    pollMs = POLL_MS,
    onJobId?: (id: string) => void,
  ): Promise<JobResult> {
    const { jobId } = await this.generate(kind, prompt, refs, model, params)
    onJobId?.(jobId)
    const deadline = Date.now() + jobDeadlineMs(kind)
    let consecutiveErrors = 0
    while (Date.now() < deadline) {
      await sleep(pollMs)
      if (isCancelled?.()) {
        // снимаем задачу и на сервере — деньги за неначатую генерацию не спишутся
        void this.cancelJob(jobId).catch(() => {})
        throw new Error('cancelled')
      }
      try {
        const job = await this.job(jobId)
        consecutiveErrors = 0
        if (job.progressText) onProgress?.(job.progressText)
        if (job.status === 'done' && job.result) return job.result
        if (job.status === 'error') throw new Error(job.error ?? JOB_FAILED)
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) throw new Error(JOB_LOST)
        if (!(err instanceof ApiError)) throw err
        consecutiveErrors++
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          void this.cancelJob(jobId).catch(() => {})
          throw new Error(JOB_NO_CONNECTION)
        }
      }
    }
    void this.cancelJob(jobId).catch(() => {})
    throw new Error(JOB_TIMED_OUT)
  },
}

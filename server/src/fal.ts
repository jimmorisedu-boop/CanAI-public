import { fal } from '@fal-ai/client'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Agent, fetch as undiciFetch } from 'undici'
import type { ResolvedModel } from './catalog.js'
import { config } from './config.js'
import { LLM_DEFAULT_MODEL } from './models.js'
import { binarizePngMask, getImageDimensions } from './mask.js'
import { isNetworkError, withFalUploadMirror } from './falCdn.js'
import { mediaFilePath, fetchSafeBuffer } from './storage.js'

// CDN fal (v3.fal.media и т.п.) из части сетей отвечает медленно: дефолтный
// connectTimeout undici 10с даёт «fetch failed» на загрузке референсов ~6МБ.
// Свой Agent: дольше connect + body, чтобы upload/queue не рвались на сети.
const falAgent = new Agent({
  connectTimeout: 60_000,
  headersTimeout: 120_000,
  bodyTimeout: 300_000,
  keepAliveTimeout: 30_000,
})

const falFetchBase: typeof fetch = (input, init) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as object),
    dispatcher: falAgent,
  }) as unknown as Promise<Response>
const falFetch = withFalUploadMirror(falFetchBase)

// применяем текущий ключ; зовётся и при старте, и после смены ключа в настройках
export function reconfigureFal(): void {
  if (config.falKey) {
    fal.config({ credentials: config.falKey, fetch: falFetch })
  } else {
    // Ключ убрали из настроек — SDK обязан забыть прежние credentials, иначе
    // отмена/резюм старых задач продолжала ходить в fal с удалённым ключом.
    // Пустой ключ честно ломается авторизацией вместо тихой работы.
    fal.config({ credentials: '', fetch: falFetch })
  }
}
reconfigureFal()

export interface GeneratedResult {
  url?: string
  width?: number
  height?: number
  mime?: string
  text?: string
  seed?: number
}

export interface FalTextUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd: number
  reasoningTokens?: number
  cacheWriteTokens?: number
  cacheReadTokens?: number
}

export interface FalTextResult {
  text: string
  usage: FalTextUsage
}

function describeQueue(status: string, position?: number): string {
  if (status === 'IN_QUEUE') return position != null ? `in queue fal (№${position + 1})` : 'in queue fal…'
  if (status === 'IN_PROGRESS') return 'generating model…'
  return 'processing…'
}

// транзиентные сбои (перегрузка/сеть) — стоит повторить; ошибки валидации — нет
const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504])

function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  if (typeof status === 'number') return RETRIABLE_STATUS.has(status)
  // сетевые сбои fetch прилетают TypeError'ом без status
  return err instanceof TypeError
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Submit выполняется ровно ОДИН раз. При сетевом сбое повторяем только ожидание
// уже известного requestId: повторный fal.subscribe создавал новую платную задачу.
type OnEnqueued = (requestId: string, endpoint: string) => void | Promise<void>

async function waitForResult(
  endpoint: string,
  requestId: string,
  onProgress: (text: string) => void,
  signal: AbortSignal,
): Promise<unknown> {
  let statusError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fal.queue.subscribeToStatus(endpoint, {
        requestId,
        logs: false,
        abortSignal: signal,
        onQueueUpdate(update) {
          const position =
            'queue_position' in update ? (update as { queue_position?: number }).queue_position : undefined
          onProgress(describeQueue(update.status, position))
        },
      })
      statusError = undefined
      break
    } catch (err) {
      statusError = err
      if (signal.aborted || !isTransient(err) || attempt === 2) throw err
      onProgress('Connection to fal was interrupted; continuing to wait for the same job…')
      await sleep(1000 + attempt * 2000)
    }
  }
  if (statusError) throw statusError

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await fal.queue.result(endpoint, { requestId, abortSignal: signal })
      return result.data
    } catch (err) {
      if (signal.aborted || !isTransient(err) || attempt === 2) throw err
      await sleep(1000 + attempt * 2000)
    }
  }
  throw new Error('fal.ai did not return a result')
}

async function withDeadline<T>(
  endpoint: string,
  timeoutMs: number,
  getRequestId: () => string | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref()

  try {
    return await run(controller.signal)
  } catch (err) {
    if (timedOut) {
      const requestId = getRequestId()
      // Отмена после дедлайна — best effort: fal уже мог потерять связь, и
      // зависший cancel не должен удерживать задачу и слот генерации навсегда.
      if (requestId) {
        try {
          void fal.queue.cancel(endpoint, { requestId }).catch(() => {})
        } catch {
          // Синхронный сбой SDK тоже не маскирует исходный таймаут.
        }
      }
      throw new Error(`generation exceeded ${Math.round(timeoutMs / 60000)} min — cancelled`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function subscribe(
  endpoint: string,
  input: Record<string, unknown>,
  onProgress: (text: string) => void,
  timeoutMs: number,
  onEnqueued?: OnEnqueued,
): Promise<unknown> {
  let requestId: string | undefined
  return withDeadline(endpoint, timeoutMs, () => requestId, async (signal) => {
    const submitted = await fal.queue.submit(endpoint, { input, abortSignal: signal })
    requestId = submitted.request_id
    await onEnqueued?.(requestId, endpoint)
    return waitForResult(endpoint, requestId, onProgress, signal)
  })
}

async function resumeSubscription(
  endpoint: string,
  requestId: string,
  onProgress: (text: string) => void,
  timeoutMs: number,
): Promise<unknown> {
  return withDeadline(
    endpoint,
    timeoutMs,
    () => requestId,
    (signal) => waitForResult(endpoint, requestId, onProgress, signal),
  )
}

// Отменить запрос в очереди fal (успевает, пока задача не ушла в работу;
// если уже генерируется — fal может отказать, это не ошибка для нас)
export async function cancelFalRequest(endpoint: string, requestId: string): Promise<void> {
  await fal.queue.cancel(endpoint, { requestId })
}

// один детектор сетевых сбоев на весь сервер — см. falCdn.ts
const isNetworkFetchError = isNetworkError

// Кладёт файл в хранилище fal и возвращает публичный URL —
// модели принимают референсы только по URL. Повторы на сетевых сбоях CDN.
// Сорвалась ОТПРАВКА референса — то есть до вызова модели дело не дошло.
// Отдельный тип нужен ради денег: сообщение «сеть оборвалась при загрузке»
// одинаково выглядело и здесь, и при скачивании готового результата, а разница
// принципиальная. Здесь повтор бесплатен, там — стоит ещё одну генерацию.
export class FalRefUploadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'FalRefUploadError'
    this.cause = cause
  }
}

export async function uploadToFal(buffer: Buffer, mime: string): Promise<string> {
  const ext = mime.split('/')[1]?.split('+')[0] ?? 'bin'
  const file = new File([new Uint8Array(buffer)], `ref.${ext}`, { type: mime })
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fal.storage.upload(file)
    } catch (err) {
      lastErr = err
      if (!isNetworkFetchError(err) || attempt === 2) throw new FalRefUploadError(err)
      await sleep(1000 + attempt * 2000)
    }
  }
  throw new FalRefUploadError(lastErr)
}

async function readMediaBuffer(url: string): Promise<Buffer> {
  if (url.startsWith('/media/')) {
    // Путь ищет раскладка: в ссылке только имя файла (см. mediaLayout).
    return fs.readFile(mediaFilePath(url))
  }
  if (url.startsWith('data:')) {
    const base64 = url.split(',')[1] ?? ''
    return Buffer.from(base64, 'base64')
  }
  // только HTTPS + SSRF-guard (маски с fal.storage после uploadToFal)
  return fetchSafeBuffer(url)
}

// Очистка маски обязательна: при сбое НЕ отдаём «грязный» URL дальше в fal
// (раньше return url мог отправить необработанную/небезопасную маску).
async function sanitizeMaskUrl(url: string, targetImageUrl?: string): Promise<string> {
  const inputBuf = await readMediaBuffer(url)
  let targetW: number | undefined
  let targetH: number | undefined
  if (targetImageUrl) {
    try {
      const targetBuf = await readMediaBuffer(targetImageUrl)
      const dims = getImageDimensions(targetBuf)
      if (dims) {
        targetW = dims.width
        targetH = dims.height
      }
    } catch (err) {
      console.warn('[CanAI] Could not read target image dimensions:', err)
    }
  }
  const cleanBuf = binarizePngMask(inputBuf, 128, targetW, targetH)
  return uploadToFal(cleanBuf, 'image/png')
}

// Отбрасываем пустые значения; seed<0 не шлём (fal сам берёт случайный).
function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === '' || v === null || v === undefined) continue
    if (k === 'seed' && typeof v === 'number' && v < 0) continue
    if (k === 'image_size' && typeof v === 'string' && /^\d+x\d+$/.test(v)) {
      const [w, h] = v.split('x').map(Number)
      out[k] = { width: w, height: h }
      continue
    }
    out[k] = v
  }
  return out
}

export function parseGeneratedResult(model: ResolvedModel, data: unknown): GeneratedResult {
  if (model.kind === 'text') {
    return { text: parseTextOutput(data) }
  }

  if (model.kind === 'image') {
    const image = (data as { images?: Array<{ url: string; width?: number; height?: number; content_type?: string }> })
      ?.images?.[0]
    if (!image?.url) throw new Error('fal.ai returned an empty result')
    console.log('[fal] ← image', image.width ?? '?', '×', image.height ?? '?')
    return { url: image.url, width: image.width, height: image.height, mime: image.content_type ?? 'image/jpeg' }
  }

  if (model.kind === 'audio') {
    // Lyria и обе модели ElevenLabs отдают {audio:{url}} (сверено по openapi).
    const audio = (data as { audio?: { url?: string; content_type?: string } })?.audio
    if (audio?.url) {
      console.log('[fal] ← audio')
      return { url: audio.url, width: 0, height: 0, mime: audio.content_type ?? 'audio/mpeg' }
    }
    // Разделение (SAM Audio) отдаёт ДВЕ дорожки: target — то, что просили
    // достать, residual — всё остальное. На холст кладём target: за ним и
    // приходили, а задача возвращает один результат.
    const target = (data as { target?: { url?: string; content_type?: string } })?.target
    if (target?.url) {
      console.log('[fal] ← track selected')
      return { url: target.url, width: 0, height: 0, mime: target.content_type ?? 'audio/mpeg' }
    }
    throw new Error('fal.ai returned an empty result')
  }

  if (model.kind === 'other') {
    // SAM 3 и подобные: основной результат — masks[] (черно-белая маска для mask_url),
    // рядом лежит image (превью). Для нодовых связей отдаём сначала маску.
    type ImgOut = { url?: string; width?: number; height?: number; content_type?: string }
    const d = data as { image?: ImgOut; images?: ImgOut[]; masks?: ImgOut[]; seed?: number }
    const out = d?.masks?.[0] ?? d?.image ?? d?.images?.[0]
    if (!out?.url) throw new Error('fal.ai returned an empty result')
    return {
      url: out.url,
      width: out.width,
      height: out.height,
      mime: out.content_type ?? 'image/png',
      ...(typeof d.seed === 'number' ? { seed: d.seed } : {}),
    }
  }

  const video = (data as { video?: { url?: string } })?.video
  if (!video?.url) throw new Error('fal.ai returned an empty result')
  return { url: video.url, width: 0, height: 0, mime: 'video/mp4' }
}

function parseTextOutput(data: unknown): string {
  const out = data as { output?: string; text?: string; response?: string }
  const text = out?.output ?? out?.text ?? out?.response
  if (typeof text !== 'string' || !text.trim()) throw new Error('LLM returned an empty response')
  return text.trim()
}

export function parseFalTextUsage(data: unknown): FalTextUsage {
  const raw = (data as { usage?: Record<string, unknown> })?.usage
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('fal.ai did not return the required LLM usage data')
  const numberField = (name: string, minimum = 0): number => {
    const value = raw[name]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`fal.ai returned invalid usage.${name}`)
    return value
  }
  const cost = raw.cost
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new Error('fal.ai did not return valid LLM usage.cost')
  const optionalNumberField = (name: string): number | undefined => {
    if (raw[name] === undefined) return undefined
    return numberField(name)
  }
  const inputTokens = optionalNumberField('prompt_tokens') ?? 0
  const outputTokens = optionalNumberField('completion_tokens') ?? 0
  const totalRaw = raw.total_tokens
  const totalTokens = totalRaw === undefined
    ? inputTokens + outputTokens
    : numberField('total_tokens')
  const details = raw.prompt_tokens_details
  const detailRecord = details && typeof details === 'object' && !Array.isArray(details)
    ? details as Record<string, unknown>
    : undefined
  const cacheWriteRaw = raw.cache_write_tokens ?? detailRecord?.cache_write_tokens
  const cacheWriteTokens = cacheWriteRaw === undefined ? undefined : (() => {
    if (typeof cacheWriteRaw !== 'number' || !Number.isSafeInteger(cacheWriteRaw) || cacheWriteRaw < 0) throw new Error('fal.ai returned invalid cache_write_tokens')
    return cacheWriteRaw
  })()
  const cacheReadRaw = raw.cache_read_tokens ?? detailRecord?.cache_read_tokens ?? detailRecord?.cached_tokens
  const cacheReadTokens = cacheReadRaw === undefined ? undefined : (() => {
    if (typeof cacheReadRaw !== 'number' || !Number.isSafeInteger(cacheReadRaw) || cacheReadRaw < 0) throw new Error('fal.ai returned invalid cache_read_tokens')
    return cacheReadRaw
  })()
  const reasoningTokens = optionalNumberField('reasoning_tokens') ?? (() => {
    const nested = detailRecord?.reasoning_tokens
    if (nested === undefined) return undefined
    if (typeof nested !== 'number' || !Number.isSafeInteger(nested) || nested < 0) throw new Error('fal.ai returned invalid reasoning_tokens')
    return nested
  })()
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: cost,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
  }
}

function timeoutFor(model: ResolvedModel): number {
  return model.kind === 'video' ? 15 * 60_000 : 4 * 60_000
}

export function textEndpoint(
  endpoint: string,
  imageUrls: string[],
  videoUrls: string[] = [],
  audioUrls: string[] = [],
): string {
  if (endpoint !== 'openrouter/router') return endpoint
  const mediaKinds = Number(imageUrls.length > 0) + Number(videoUrls.length > 0) + Number(audioUrls.length > 0)
  if (mediaKinds > 1) throw new Error('OpenRouter through fal accepts only one media type per launch')
  if (audioUrls.length > 0) return 'openrouter/router/audio'
  if (videoUrls.length > 0) return 'openrouter/router/video'
  if (imageUrls.length > 0) return 'openrouter/router/vision'
  return endpoint
}

export function buildTextRequest(
  endpoint: string,
  prompt: string,
  imageUrls: string[],
  params: Record<string, unknown>,
  videoUrls: string[] = [],
  audioUrls: string[] = [],
): { endpoint: string; input: Record<string, unknown> } {
  const resolvedEndpoint = textEndpoint(endpoint, imageUrls, videoUrls, audioUrls)
  const input: Record<string, unknown> = { prompt, model: LLM_DEFAULT_MODEL, ...params }
  if (imageUrls.length) {
    if (resolvedEndpoint === 'openrouter/router/vision') {
      input.image_urls = imageUrls
    } else {
      // Не меняем контракт пользовательских text/VLM endpoint'ов.
      input.image_url = imageUrls[0]
      input.image_urls = imageUrls
    }
  }
  if (videoUrls.length) {
    if (resolvedEndpoint === 'openrouter/router/video') input.video_urls = videoUrls
    else {
      input.video_url = videoUrls[0]
      input.video_urls = videoUrls
    }
  }
  if (audioUrls.length) {
    if (resolvedEndpoint === 'openrouter/router/audio') input.audio_url = audioUrls[0]
    else {
      input.audio_url = audioUrls[0]
      input.audio_urls = audioUrls
    }
  }
  return { endpoint: resolvedEndpoint, input }
}

function agentPrompt(messages: Array<{ role: 'system' | 'user' | 'assistant'; text: string }>): { prompt: string; systemPrompt?: string } {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.text).join('\n\n').trim()
  const dialogue = messages
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}:\n${message.text}`)
    .join('\n\n')
    .trim()
  return { prompt: dialogue || system, ...(system && dialogue ? { systemPrompt: system } : {}) }
}

/** Build the closed, text-only parameter set used by Agent Host requests. */
export function buildAgentTextInput(
  model: ResolvedModel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; text: string }>,
  maxTokens: number,
): { endpoint: string; input: Record<string, unknown> } {
  if (model.kind !== 'text' || model.endpoint !== 'openrouter/router') throw new Error('LLM endpoint not allowed for Agent Host')
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 16_000) throw new Error('Invalid LLM token limit')
  const prompt = agentPrompt(messages)
  const pinnedProviderModel = model.defaults.model
  if (typeof pinnedProviderModel !== 'string' || !pinnedProviderModel.trim()) throw new Error('The text model has no pinned provider model')
  return {
    endpoint: model.endpoint,
    input: {
      prompt: prompt.prompt,
      model: pinnedProviderModel,
      max_tokens: maxTokens,
      reasoning: false,
      enable_web_search: false,
      ...(prompt.systemPrompt ? { system_prompt: prompt.systemPrompt } : {}),
    },
  }
}

/** Narrow text-only adapter for the Agent Host; it never accepts an endpoint from the package. */
export async function generateTextForAgent(
  model: ResolvedModel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; text: string }>,
  maxTokens: number,
  onEnqueued?: OnEnqueued,
): Promise<FalTextResult> {
  const request = buildAgentTextInput(model, messages, maxTokens)
  const data = await subscribe(request.endpoint, request.input, () => {}, timeoutFor(model), onEnqueued)
  return { text: parseTextOutput(data), usage: parseFalTextUsage(data) }
}

export async function resumeTextForAgent(
  model: ResolvedModel,
  requestId: string,
): Promise<FalTextResult> {
  if (model.kind !== 'text' || model.endpoint !== 'openrouter/router') throw new Error('LLM endpoint not allowed for Agent Host')
  const data = await resumeSubscription(model.endpoint, requestId, () => {}, timeoutFor(model))
  return { text: parseTextOutput(data), usage: parseFalTextUsage(data) }
}

export function buildImageInput(
  model: ResolvedModel,
  prompt: string,
  imageUrls: string[],
  videoUrls: string[],
  audioUrls: string[],
  params: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = { output_format: 'png', ...params }
  if (model.promptInput) input[model.promptInput] = prompt
  if (model.refs && imageUrls.length) {
    input[model.imageInput] = model.imageInput === 'image_urls' ? imageUrls : imageUrls[0]
  }
  if (model.videoInput && videoUrls.length) {
    input[model.videoInput] = model.videoInput === 'video_urls' ? videoUrls : videoUrls[0]
  }
  if (model.audioInput && audioUrls.length) {
    input[model.audioInput] = model.audioInput === 'audio_urls' ? audioUrls : audioUrls[0]
  }
  return input
}

export function buildVideoInput(
  model: ResolvedModel,
  prompt: string,
  imageUrls: string[],
  videoUrls: string[],
  audioUrls: string[],
  params: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt, ...params }
  if (imageUrls.length) {
    // ⚠️ «Первый/последний кадр» — по ЯВНОМУ полю каталога, а не по строке
    // endpoint'а: раньше здесь была прибитая проверка на Seedance, и вторая
    // такая модель (MiniMax H3 Max) молча теряла бы последний кадр.
    if (model.endImageInput) {
      input.image_url = imageUrls[0]
      if (imageUrls[1]) input[model.endImageInput] = imageUrls[1]
    } else if (model.imageInput === 'image_urls') {
      input.image_urls = imageUrls
    } else {
      input.image_url = imageUrls[0]
    }
  }
  if (model.videoInput && videoUrls.length) {
    input[model.videoInput] = model.videoInput === 'video_urls' ? videoUrls : videoUrls[0]
  }
  if (model.audioInput && audioUrls.length) {
    input[model.audioInput] = model.audioInput === 'audio_urls' ? audioUrls : audioUrls[0]
  }
  return input
}

// Звук собирается СВОИМ путём: у него бывает своё имя поля промпта (у обеих
// моделей ElevenLabs это text, а не prompt) и свой вход для дорожки. Пока этой
// функции не было, звук уходил в видео-ветку, где промпт кладётся в prompt
// жёстко, — и ElevenLabs отвечал «Field required», то есть не запускался вовсе
// (проверено 20.08.2026).
export function buildAudioInput(
  model: ResolvedModel,
  prompt: string,
  audioUrls: string[],
  params: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = { ...params }
  if (model.promptInput) input[model.promptInput] = prompt
  if (model.audioInput && audioUrls.length) {
    input[model.audioInput] = model.audioInput === 'audio_urls' ? audioUrls : audioUrls[0]
  }
  return input
}

export function buildOtherInput(
  model: ResolvedModel,
  prompt: string,
  imageUrls: string[],
  params: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = { ...params }
  if (model.promptInput) input[model.promptInput] = prompt
  if (imageUrls.length) input.image_url = imageUrls[0]
  return input
}

// Универсальный вызов любой fal-модели по разрешённому endpoint'у.
// input = prompt + дефолты модели + настройки с ноды (userParams) + референсы.
export async function generateByModel(
  model: ResolvedModel,
  prompt: string,
  imageUrls: string[],
  videoUrls: string[],
  audioUrls: string[],
  userParams: Record<string, unknown>,
  onProgress: (text: string) => void,
  onEnqueued?: OnEnqueued,
  // роль каждого image-референса (по порядку imageUrls) — для моделей с
  // именованными входами (Ideogram: image_url/mask_url/reference_image_urls).
  // Пусто (канвас/обычные модели) → маппинг позиционный.
  imageRoles: Array<string | undefined> = [],
): Promise<GeneratedResult> {
  const params = { ...model.defaults, ...cleanParams(userParams) }
  // лог в окно сервера: какой endpoint и какие параметры реально уходят (для
  // проверки, что настройки — размер и т.п. — доносятся; ключ тут не светится)
  console.log('[fal] →', model.endpoint, JSON.stringify(params))

  // видео честно делается минутами; картинка/текст, зависшие на 4+ минут, — сбой
  const timeoutMs = timeoutFor(model)

  if (model.kind === 'text') {
    const request = buildTextRequest(model.endpoint, prompt, imageUrls, params, videoUrls, audioUrls)
    const data = await subscribe(request.endpoint, request.input, onProgress, timeoutMs, onEnqueued)
    return parseGeneratedResult(model, data)
  }

  if (model.endpoint === 'fal-ai/ideogram/character/edit') {
    // Вход разбирается по РОЛИ порта (нода Ideogram даёт именованные входы —
    // «картинка»/«маска»/«персонаж»), а не по порядку связей. Если роли не
    // пришли (свой endpoint / канвас) — падаем на позиционный разбор.
    const hasRoles = imageRoles.some(Boolean)
    const byRole = (role: string, posFallback: number): string | undefined => {
      const i = imageRoles.indexOf(role)
      if (i >= 0) return imageUrls[i]
      return hasRoles ? undefined : imageUrls[posFallback]
    }
    const imageUrl = byRole('image_url', 0)
    const maskUrl = byRole('mask_url', 1)
    const rawRefImages = hasRoles
      ? imageUrls.filter((_, i) => imageRoles[i] === 'reference_image_urls')
      : imageUrls.slice(2)
    const refImages = rawRefImages.length > 0 ? rawRefImages : imageUrl ? [imageUrl] : []
    if (!imageUrl || !maskUrl) {
      throw new Error('Ideogram Character Edit: requires image and mask (connect inputs)')
    }
    onProgress('clearing mask (100% black and white)…')
    const cleanMaskUrl = await sanitizeMaskUrl(maskUrl, imageUrl)
    const input: Record<string, unknown> = {
      prompt,
      ...params,
      image_url: imageUrl,
      mask_url: cleanMaskUrl,
      reference_image_urls: refImages,
    }
    const data = await subscribe(model.endpoint, input, onProgress, timeoutMs, onEnqueued)
    return parseGeneratedResult(model, data)
  }

  if (model.kind === 'image') {
    const input = buildImageInput(model, prompt, imageUrls, videoUrls, audioUrls, params)
    const data = await subscribe(model.endpoint, input, onProgress, timeoutMs, onEnqueued)
    return parseGeneratedResult(model, data)
  }

  if (model.kind === 'audio') {
    const input = buildAudioInput(model, prompt, audioUrls, params)
    const data = await subscribe(model.endpoint, input, onProgress, timeoutMs, onEnqueued)
    return parseGeneratedResult(model, data)
  }

  if (model.kind === 'other') {
    const input = buildOtherInput(model, prompt, imageUrls, params)
    const data = await subscribe(model.endpoint, input, onProgress, timeoutMs, onEnqueued)
    return parseGeneratedResult(model, data)
  }

  // video — картинка-референс либо одной image_url, либо массивом image_urls
  // (reference-to-video); видео-референс (редактирование) — video_url (одно)
  // либо video_urls (массив, может идти ОДНОВРЕМЕННО с image_urls на Seedance)
  const input = buildVideoInput(model, prompt, imageUrls, videoUrls, audioUrls, params)
  const data = await subscribe(model.endpoint, input, onProgress, timeoutMs, onEnqueued)
  return parseGeneratedResult(model, data)
}

// После перезапуска продолжаем ждать уже оплаченную задачу fal по прежнему requestId.
// Повторного queue.submit здесь принципиально нет.
export async function resumeByModel(
  model: ResolvedModel,
  requestId: string,
  onProgress: (text: string) => void,
  endpoint = model.endpoint,
): Promise<GeneratedResult> {
  const data = await resumeSubscription(endpoint, requestId, onProgress, timeoutFor(model))
  return parseGeneratedResult(model, data)
}

interface FalDetailItem {
  loc?: string[];
  msg?: string;
  type?: string;
}

// fal кладёт детали ошибки в body.detail — вытаскиваем человекочитаемый текст
// Поставщик модели иногда отвечает своей внутренней простынёй — дампом HTTP
// заголовков или трассировкой. Человеку из неё нужна только первая фраза
// («Sound effect generation failed»), остальное закрывает экран и пугает.
export function trimProviderNoise(text: string): string {
  const at = text.search(/headers:\s*\{|Traceback \(most recent call last\)/i)
  const cut = (at > 0 ? text.slice(0, at) : text).trim().replace(/[\s:,;-]+$/, '')
  return (cut || text.trim()).slice(0, 300)
}

export function falErrorMessage(err: unknown): string {
  // Про деньги — первым делом: референс не доехал до fal, модель не звали,
  // списания не было. Повторять можно смело, и это надо сказать вслух —
  // раньше здесь стояла та же фраза, что при обрыве скачивания результата,
  // где повтор означает вторую оплату.
  if (err instanceof FalRefUploadError) {
    return 'The reference could not be sent to fal.ai; generation did not start and you were not charged. Try again.'
  }

  const anyErr = err as { body?: { detail?: unknown }; message?: string }

  // 1. Попробуем разобрать детальную информацию об ошибке от fal.ai
  if (anyErr?.body?.detail) {
    const detail = anyErr.body.detail
    let parsed: unknown = detail

    if (typeof detail === 'string') {
      try {
        parsed = JSON.parse(detail)
      } catch {
        // не JSON, оставим как строку
      }
    }

    // Если detail — массив ошибок (стандарт для FastAPI / Pydantic)
    if (Array.isArray(parsed)) {
      const messages = parsed.map((item: unknown) => {
        if (item && typeof item === 'object') {
          const detailItem = item as FalDetailItem
          const msg = detailItem.msg || ''
          const type = detailItem.type || ''
          const loc = detailItem.loc || []

          // Переводим частые ошибки безопасности и валидации
          const isSafetyOrLikeness =
            msg.includes('likenesses of real people') ||
            msg.includes('safety') ||
            msg.includes('private information')

          if (type === 'content_policy_violation' || isSafetyOrLikeness) {
            if (isSafetyOrLikeness) {
              const hasImageLoc = loc.includes('image_url') || loc.includes('image_urls')
              const hasVideoLoc = loc.includes('video_url') || loc.includes('video_urls')
              
              if (hasImageLoc && !hasVideoLoc) {
                return 'The image contains real people’s faces or personal data (blocked by fal.ai safety policy)'
              } else if (hasVideoLoc && !hasImageLoc) {
                return 'The video contains real people’s faces or personal data (blocked by fal.ai safety policy)'
              } else {
                const isImage = hasImageLoc || msg.includes('images')
                const isVideo = hasVideoLoc || msg.includes('videos')
                if (isImage && isVideo) {
                  return 'Images or video contain real people’s faces or personal data (blocked by fal.ai safety policy)'
                } else if (isVideo) {
                  return 'The video contains real people’s faces or personal data (blocked by fal.ai safety policy)'
                } else if (isImage) {
                  return 'The image contains real people’s faces or personal data (blocked by fal.ai safety policy)'
                } else {
                  return 'Content contains faces of real people or personal data, which fal.ai safety rules forbid'
                }
              }
            }
            return 'Request blocked by fal.ai content-safety policy'
          }

          if (type === 'content_policy_violation') {
            return 'Request blocked by fal.ai content-safety policy'
          }

          if (type.startsWith('value_error.missing')) {
            const field = loc[loc.length - 1] || ''
            return `Required parameter is missing${field ? ` "${field}"` : ''}`
          }

          return msg || type || 'error validation'
        }
        return String(item)
      })

      return messages.filter(Boolean).join('; ').slice(0, 300)
    }

    // Если detail — одиночный объект
    if (parsed && typeof parsed === 'object') {
      const detailItem = parsed as FalDetailItem
      if (detailItem.msg) {
        const msg = detailItem.msg
        if (
          detailItem.type === 'content_policy_violation' ||
          msg.includes('likenesses of real people') ||
          msg.includes('safety') ||
          msg.includes('private information')
        ) {
          return 'The content contains real people’s faces or personal data (blocked by fal.ai safety policy)'
        }
        return msg.slice(0, 300)
      }
    }

    // Резервный вариант для текстовой детали
    const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail)
    if (detailStr.includes('content_policy_violation') || detailStr.includes('likenesses of real people')) {
      return 'The content contains real people’s faces or personal data (blocked by fal.ai safety policy)'
    }
    return trimProviderNoise(detailStr)
  }

  // 2. Если деталей нет, обрабатываем общее сообщение об ошибке
  if (anyErr?.message) {
    const msg = anyErr.message
    const causeMsg = String((anyErr as { cause?: { message?: string; code?: string } })?.cause?.message ?? '')
    const causeCode = String((anyErr as { cause?: { code?: string } })?.cause?.code ?? '')
    const netBlob = `${msg} ${causeMsg} ${causeCode}`

    if (msg.includes('401') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('api key')) {
      return 'Invalid fal.ai API key or blocked access'
    }
    if (msg.includes('402') || msg.toLowerCase().includes('payment') || msg.toLowerCase().includes('balance')) {
      return 'Insufficient funds in your fal.ai balance'
    }
    if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
      return 'Request limit exceeded. Please wait a moment.'
    }
    if (/Connect Timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(netBlob)) {
      return 'Could not contact fal.ai storage (network timeout). Check your internet/VPN and try again'
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(netBlob)) {
      return 'Could not resolve fal.ai. Check your internet or DNS settings'
    }
    if (/fetch failed|ECONNRESET|ECONNREFUSED|network/i.test(netBlob)) {
      // Сюда попадает обрыв при СКАЧИВАНИИ готового результата: работа уже
      // оплачена, поэтому про повтор говорим осторожнее (отправку референса
      // ловит FalRefUploadError выше — там повтор бесплатен).
      return 'The connection to fal.ai was interrupted while receiving the result; you were already charged. Retry in a minute (a VPN or firewall may have interrupted the CDN).'
    }
    if (msg.includes('504') || msg.toLowerCase().includes('timeout')) {
      return 'Timed out waiting for a response from fal.ai'
    }
    if (
      msg.includes('502') ||
      msg.includes('503') ||
      msg.toLowerCase().includes('bad gateway') ||
      msg.toLowerCase().includes('service unavailable')
    ) {
      return 'fal.ai is temporarily unavailable. Try again later'
    }
    // не светим сырой «fetch failed» без контекста — добавляем cause, если есть
    if (msg === 'fetch failed' && causeMsg) return `network: ${causeMsg}`.slice(0, 300)
    return trimProviderNoise(msg)
  }

  return 'Unknown error'
}

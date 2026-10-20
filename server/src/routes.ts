import { MAX_PROMPT_CHARS } from './promptLimits.js'
import { MAX_MEDIA_UPLOAD_BYTES, MEDIA_UPLOAD_TOO_LARGE } from '../../packages/mediaUploadLimits.js'
import { catalogLibrary } from './catalogLibrary.js'
import { catalogLibraryRouter } from './catalogLibraryRoutes.js'
import { randomUUID } from 'node:crypto'
import { extForMime } from './mediaTypes.js'
import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Router, type Response } from 'express'
import { config } from './config.js'
import { hasPendingDurableRecovery } from './durableJsonRecovery.js'
import { looksLikeBrowser, markBrowserPoll, uiAlive, uiOpened } from './uiOpened.js'
import {
  acknowledgeEditSession,
  EditSessionError,
  getSessionMtime,
  listEditSessions,
  startEditSession,
  stopEditSession,
} from './editSessions.js'
import { CATALOG, normalizeEndpoint } from './catalog.js'
import { falBillingRouter, resetFalBalanceCache } from './falBillingRoutes.js'
import { cancelFalRequest } from './fal.js'
import { jobs, JobLimitError, MAX_LIVE_JOBS } from './jobs.js'
import { onboarding } from './onboarding.js'
import { listProjects } from './projects.js'
import { projectRouter } from './projectRoutes.js'
import { assistantRouter } from './assistantRoutes.js'
import { continuityRouter } from './continuityRoutes.js'
import { macroRunRouter } from './macroRunRoutes.js'
import { remoteAccessRouter } from './remoteRoutes.js'
import { promptChatRouter } from './promptChatRoutes.js'
import { parseRefs, type IncomingRef } from './refs.js'
import {
  generationGate,
  GenerationRouteError,
  GenerationShuttingDownError,
  selectGenerationRoute,
} from './generationGate.js'
import type { CanvasJobTarget } from './canvasDelivery.js'
import { cancelJobById, deliverJobResult, persistAndEnqueueJob } from './runner.js'
import { buildInfo } from './buildInfo.js'
import { loadSettings, saveFalKey, saveSettings } from './settings.js'
import { takeLocalGenerationFromTablet } from './tabletDailyLimit.js'
import { findIdempotentReplay, idempotencyAppliesTo } from './idempotency.js'
import { isCookieMode } from './extractorCookies.js'
import { FilePickError, pickFilePath, type PickTarget } from './filePicker.js'
import { mediaFilePath, dataUrlToBuffer, saveBuffer, saveStream, UploadTooLargeError } from './storage.js'
import { workflowRouter } from './workflowRoutes.js'
import { validateModelRefs } from './modelRefLimits.js'
import { validateModelParams, modelExecutionError } from './modelParams.js'
import type { LifecycleManager } from './lifecycle.js'
import { loadProjectSnapshot } from './projects.js'
import { localNetworkAddresses } from './shareLan.js'
import { MediaImportStore } from './mediaImportStore.js'
import { MediaImportManager } from './mediaImportManager.js'
import { createMediaImportRouter } from './mediaImportRoutes.js'
import { createLoginBrowserRouter } from './loginBrowserRoutes.js'
import { loginBrowser, loginBrowserInstall } from './loginBrowser.js'
import { PortableMediaTools } from './portableMediaTools.js'
import { createMediaToolsRouter } from './mediaToolsRoutes.js'
import { createFaceRouter } from './faceRoutes.js'
import { componentInventory } from './components.js'
import { EditorPathError, resolveEditorTarget } from './editorTarget.js'
import { createDiagnosticRouter } from './diagnosticRoutes.js'
import { MAX_WAITED_JOBS, publicLocalJob, waitForJobs, type JobWaitDeps } from './jobWait.js'
import { ffmpegBinary } from './ffmpegTools.js'
import { resolveMediaLink } from './mediaLinkResolver.js'
import { formatExactUsd } from './priceFormat.js'
import { createAgentRouter } from './agents/routes.js'
import { agentHost, agentPackageManager, agentPackageRegistry } from './agents/runtime.js'
import { canvasActionRouter } from './canvasActionRoutes.js'

export const apiRouter = Router()
// «Сообщить о проблеме» (5.9): жалоба с журналами — на сервер команды или файлом.
apiRouter.use('/diagnostics', createDiagnosticRouter())
const portableMediaTools = new PortableMediaTools({ toolsDir: config.mediaToolsDir })
export const mediaImportManager = new MediaImportManager({
  store: new MediaImportStore(config.mediaImportsFile),
  mediaDir: config.mediaDir,
  resolve: (url) => resolveMediaLink(url, { tools: portableMediaTools }),
  locateTool: (tool) => portableMediaTools.locate(tool),
})
let lifecycle: LifecycleManager | null = null
let lifecycleShutdown: (() => Promise<void>) | null = null

/** Public identity only; the shutdown token remains private. */
export function localRuntimeInstanceId(): string | null {
  return lifecycle?.instanceId ?? null
}

export function attachLifecycle(
  manager: LifecycleManager,
  shutdown: () => Promise<void>,
): void {
  lifecycle = manager
  lifecycleShutdown = shutdown
}

// под-роутеры: workflow, доски, billing fal
apiRouter.use(workflowRouter)
apiRouter.use(catalogLibraryRouter)
apiRouter.use(projectRouter)
apiRouter.use(assistantRouter)
apiRouter.use(continuityRouter)
apiRouter.use(macroRunRouter)
apiRouter.use(remoteAccessRouter)
apiRouter.use(promptChatRouter)
apiRouter.use(falBillingRouter)
apiRouter.use(createMediaImportRouter(mediaImportManager))
apiRouter.use(createLoginBrowserRouter(loginBrowser, loginBrowserInstall))
apiRouter.use(createMediaToolsRouter(ffmpegBinary))
apiRouter.use(createFaceRouter())
apiRouter.use(createAgentRouter(agentHost, agentPackageRegistry, agentPackageManager))
// Text-only preparation for the canvas action dock. It never launches media
// and is deliberately mounted as a separate narrow router.
apiRouter.use(canvasActionRouter)

const MAX_ASSET_DATAURL = 45_000_000 // ~33 МБ файла в base64

// Опись портативных компонентов. Только смотрит — качают их кнопками в
// настройках, каждый своей ручкой.
apiRouter.get('/components', async (_req, res) => {
  res.json({ components: await componentInventory() })
})

apiRouter.get('/status', async (req, res) => {
  if (!lifecycle) return res.status(503).json({ error: 'Lifecycle still not ready' })
  // ⚠️ Опрос состояния шлёт каждая ОТКРЫТАЯ страница — по нему и видно, что
  // вкладка жива прямо сейчас. Без этого лаунчер после перезапуска открывал
  // вторую, и две вкладки на одной доске давали конфликтную копию
  // (см. uiOpened.ts).
  if (looksLikeBrowser({ get: (name: string) => req.get(name) })) markBrowserPoll()
  res.json({
    falConfigured: Boolean(config.falKey),
    recoveryNeedsReview: await hasPendingDurableRecovery(path.dirname(config.projectFile)),
    mockMode: config.mockMode,
    serverFingerprint: config.serverFingerprint,
    // Дошёл ли браузер до интерфейса — по этому лаунчер понимает, надо ли
    // повторить попытку и назвать адрес словами (см. uiOpened.ts).
    uiOpened: uiOpened(),
    // Есть ли открытая вкладка ПРЯМО СЕЙЧАС: по ней лаунчер понимает, что
    // открывать вторую не нужно.
    uiAlive: uiAlive(),
    instanceId: lifecycle.instanceId,
    shuttingDown: lifecycle.shuttingDown,
    // Какая сборка у сервера: интерфейс сверяет со своей (пункт 5.1).
    build: buildInfo(),
  })
})

apiRouter.post('/lifecycle/shutdown', (req, res) => {
  if (!lifecycle || !lifecycleShutdown) {
    return res.status(503).json({ error: 'Lifecycle still not ready' })
  }
  if (!lifecycle.authorize(req.get('x-canai-shutdown-token'))) {
    return res.status(403).json({ error: 'Invalid token completion' })
  }
  res.status(202).json({ shuttingDown: true })
  generationGate.close()
  lifecycle.beginShutdown(lifecycleShutdown)
})

// каталог моделей fal (с описанием настраиваемых параметров) для нод
apiRouter.get('/models', async (_req, res) => {
  const library = catalogLibrary.view()
  res.json({
    models: CATALOG.map(({ contractRevision, adapterVersion, minExecutorVersion, lifecycle, pricingNote, id, name, kind, refs, params, pairId, videoRefs, videoPairId, refTagStyle, canvasHidden, englishPromptOnly, pricing, textPricing, contextWindowTokens, inputModalities, mediaInputMode, minImageRefs, minAudioRefs, minVideoRefs, maxImageRefs, maxVideoRefs, maxAudioRefs, maxTotalRefs, audioRequiresVisualRef, audioFormats, promptInputField, seedOutput }) => ({
      contractRevision, adapterVersion, minExecutorVersion, lifecycle, pricingNote,
      id,
      name,
      kind,
      refs: Boolean(refs),
      pairId,
      videoRefs: Boolean(videoRefs),
      videoPairId,
      refTagStyle: refTagStyle ?? null,
      canvasHidden: Boolean(canvasHidden),
      params: params ?? [],
      pricing,
      textPricing,
      contextWindowTokens,
      inputModalities,
      mediaInputMode,
      maxImageRefs,
      minImageRefs,
      minAudioRefs,
      minVideoRefs,
      maxVideoRefs,
      maxAudioRefs,
      maxTotalRefs,
      audioRequiresVisualRef,
      audioFormats,
      promptRequired: promptInputField !== null,
      englishPromptOnly,
      seedOutput: Boolean(seedOutput),
    })),
    defaults: library.defaults,
    defaultIssues: library.defaultIssues,
  })
})

// принимаем только примитивные значения параметров, ограничиваем число полей
function parseParams(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const entries = Object.entries(raw as Record<string, unknown>)
  // Сервер команды разрешает до 48 динамических полей и 6 полей канона.
  if (entries.length > 30) return null
  const out: Record<string, unknown> = {}
  // `params.model` is a provider input (e.g. Krea berry/jam), independent
  // of the top-level catalog ID. validateModelParams checks its allowed values.
  const reserved = new Set(['prompt', 'image_url', 'image_urls', 'video_url', 'video_urls', 'audio_url', 'audio_urls', 'num_images'])
  for (const [k, v] of entries) {
    const field = k
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field)) return null
    if (['__proto__', 'constructor', 'prototype'].includes(field)) return null
    if (reserved.has(k)) {
      if (k === 'num_images' && v === 1) continue
      return null
    }
    if (typeof v === 'string' && v.length > 8000) return null
    if (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > 1_000_000_000)) return null
    if (!['string', 'number', 'boolean'].includes(typeof v)) return null
    out[k] = v
  }
  return out
}

const SHORT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

function parseCanvasTarget(value: unknown): CanvasJobTarget & { source: 'local' } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (raw.kind !== 'canvas') return undefined
  const nested = raw.projectRef && typeof raw.projectRef === 'object' && !Array.isArray(raw.projectRef) ? raw.projectRef as Record<string, unknown> : null
  const projectId = nested?.id ?? raw.projectId
  if (typeof projectId !== 'string' || !SHORT_ID_RE.test(projectId)) return undefined
  if (nested?.source !== undefined && nested.source !== 'local') return undefined
  if (typeof raw.placeholderId !== 'string' || !SHORT_ID_RE.test(raw.placeholderId)) return undefined
  return { kind: 'canvas', projectId, placeholderId: raw.placeholderId, source: 'local' }
}


/**
 * Отказ сервера команды обязан доехать до человека СЛОВАМИ.
 *
 * ⚠️ Ловился только `CloudAccountError`, а всё остальное — `throw error` прямо
 * из async-обработчика Express, который таких ошибок НЕ ловит: ответа не было
 * вовсе, человек ждал таймаут и получал общее «CanAI временно недоступен», а в
 * логе оседал unhandledRejection. При этом сервер команды объяснил причину
 * дословно: «Модель „Nano Banana 2" сейчас недоступна: у выбранного провайдера
 * нет ключа» — то есть слова были, их выбрасывали по дороге (найдено прогоном
 * сетевой доски 18.09.2026). Причина важна: она показывает, чинить сеть или
 * ключ провайдера, а это разные люди и разные действия.
 */
/** Отдельный preflight для desktop-клиента; submit без него тоже защищён ниже. */
apiRouter.post('/generate', async (req, res) => {
  if (lifecycle?.shuttingDown || generationGate.shuttingDown) {
    return res.status(503).json({ error: 'CanAI is shutting down — try again after restart' })
  }
  const { kind, prompt, refs: rawRefs, model, params: rawParams, target: rawTarget,
    idempotencyKey: rawIdempotencyKey } = (req.body ?? {}) as {
    kind?: unknown
    prompt?: unknown
    refs?: unknown
    model?: unknown
    params?: unknown
    target?: unknown
    idempotencyKey?: unknown
  }

  if (kind !== 'image' && kind !== 'video' && kind !== 'text' && kind !== 'audio' && kind !== 'other') {
    return res.status(400).json({ error: 'kind must be image, video, text, audio or other' })
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is empty' })
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({
      error: `Prompt is too long (maximum ${MAX_PROMPT_CHARS} characters)`,
    })
  }
  if (model !== undefined && (typeof model !== 'string' || model.length > 300)) {
    return res.status(400).json({ error: 'Invalid model format' })
  }
  // Доска, на которую встанет результат. Нужна не для доставки в открытый
  // клиент (он и так опрашивает задачу), а для случая «запустил и закрыл»:
  // тогда результат поставит сам сервер (canvasDelivery).
  const target = parseCanvasTarget(rawTarget)
  if (rawTarget !== undefined && !target) {
    return res.status(400).json({ error: 'Invalid generation target' })
  }
  /**
   * ⚠️ У СЕТЕВОЙ доски каталог моделей ЧУЖОЙ — его отдаёт сервер команды, и
   * имена там свои: например `gpt-image-2` вместо нашего `chatgpt-image-2`.
   * Сверять такую модель со своим каталогом значит отклонять то, что команда
   * законно предлагает: генерация падала с «Не запустилось задач: 1 из 1»
   * (жалоба 03.09.2026). Здесь мы посредник — решает сервер команды, он же и
   * откажет, если модель ему незнакома.
   */
  const localModel = false
  if (
    !localModel &&
    typeof model === 'string' &&
    model.trim() &&
    !CATALOG.some((preset) => preset.id === model) &&
    !normalizeEndpoint(model)
  ) {
    return res.status(400).json({ error: 'Only a fal endpoint in owner/model form or an official fal.ai/models/… link is allowed' })
  }
  const refs = parseRefs(rawRefs)
  if (refs === null) {
    return res.status(400).json({ error: 'References have an invalid format' })
  }
  const params = parseParams(rawParams)
  if (params === null) {
    return res.status(400).json({ error: 'Parameters have an invalid format' })
  }

  if (jobs.liveCount() >= MAX_LIVE_JOBS) {
    return res.status(429).json({ error: 'Too many active generations — wait for the current ones to finish' })
  }
  const settings = await loadSettings().catch(() => null)
  let resolvedModel = typeof model === 'string' && model.trim() ? model.trim() : undefined
  const defaultSlot = kind === 'text'
    ? 'assistant'
    : kind === 'image' || kind === 'video' || kind === 'audio'
      ? kind
      : null
  if (!localModel && !resolvedModel && defaultSlot) {
    resolvedModel = catalogLibrary.defaultModelId(defaultSlot) ?? undefined
  }
  if (kind === 'text' && !resolvedModel) {
    resolvedModel = settings?.assistantModelId || 'gemini'
  }
  const executionError = localModel ? null : modelExecutionError(resolvedModel, kind, refs)
  if (executionError) return res.status(409).json({ error: executionError })
  // ⚠️ Сначала референсы, потом параметры. Ролик к модели, которая роликов не
  // берёт (MiniMax H3), сверялся бы с ЧУЖОЙ моделью — той, на которую
  // resolveModel переключил бы запуск, — и человек читал «Parameters do not
  // match» вместо настоящей причины.
  const refLimitError = validateModelRefs(resolvedModel, kind, refs)
  if (refLimitError) {
    return res.status(400).json({ error: refLimitError })
  }
  if (!localModel && !validateModelParams(resolvedModel, kind, refs, params)) {
    return res.status(400).json({ error: 'Parameters do not match the selected model' })
  }
  let generationRoute
  try {
    const projectSource = target?.source ?? 'local'
    generationRoute = selectGenerationRoute({
      projectSource,
      // Для командной доски сервер команды — часть её контракта, а не
      localConfigured: Boolean(config.falKey),
      mockMode: config.mockMode,
    })
  } catch (error) {
    if (error instanceof GenerationRouteError) {
      const unavailable = error.code === 'local-provider-required'
      return res.status(unavailable ? 503 : 409).json({ error: error.message, code: error.code })
    }
    throw error
  }

      // возвращаем её jobId вместо новой постановки. Проверка идёт ДО дневного
  // лимита планшета, чтобы повтор не сжигал счётчик лишний раз.
  let localIdempotencyKey: string | undefined
  if (idempotencyAppliesTo(generationRoute)) {
    localIdempotencyKey = typeof rawIdempotencyKey === 'string' && rawIdempotencyKey.trim()
      ? rawIdempotencyKey.trim()
      : undefined
    if (localIdempotencyKey !== undefined && localIdempotencyKey.length > 160) {
      return res.status(400).json({ error: 'Run key is too long' })
    }
    if (localIdempotencyKey) {
      const repeated = findIdempotentReplay(jobs.all(), {
        idempotencyKey: localIdempotencyKey,
        generationRoute,
        projectId: target?.kind === 'canvas' ? target.projectId : undefined,
      })
      if (repeated) return res.json({ jobId: repeated.id })
    }
  }
  // ⚠️ Быстрый расход с планшета (пункт плана аудита 3) — дневной лимит локальных
  // генераций, который хозяин ставит на компьютере в настройках. Считаем только
  // честную локальную оплату своим ключом: mock и сетевые проекты сюда не
  // попадают (у тех свой сервер). Маркер res.locals.remoteTablet ставит сама
  // планшетная дверь (remoteApp.ts) после PIN/CSRF/allowlist — клиентский
  // заголовок здесь не источник доверия. Для компьютера хозяина лимита нет.
  const tabletDailyLimit = settings?.tabletDailyGenerationLimit ?? 0
  if (res.locals.remoteTablet === true
    && generationRoute === 'local'
    && tabletDailyLimit > 0) {
    const allowed = await takeLocalGenerationFromTablet(tabletDailyLimit)
    if (!allowed) {
      return res.status(429).json({
        error: `Daily tablet generation limit used (${tabletDailyLimit}) — counter resets after midnight`,
      })
    }
  }
  let job
  try {
    job = jobs.create(kind, prompt.trim(), refs, resolvedModel, params, target)
    job.generationRoute = generationRoute
    // Ключ повтор-ловли сохраняем с задачей: после перезапуска сервер
    // восстановит его из jobs.json и продолжит отдавать тот же jobId повтору.
    if (localIdempotencyKey) job.idempotencyKey = localIdempotencyKey
  } catch (error) {
    if (error instanceof JobLimitError) {
      return res.status(429).json({ error: error.message })
    }
    throw error
  }
  try {
    await persistAndEnqueueJob(job)
  } catch (error) {
    if (error instanceof GenerationShuttingDownError) {
      return res.status(503).json({ error: error.message })
    }
    return res.status(500).json({ error: 'Could not safely persist the job to disk' })
  }
  res.json({ jobId: job.id })
})

// ── импорт медиа (перетащенные/вставленные на канвас файлы) ──
// Кладём в media файлом, чтобы они не жили в проекте как base64 и были
// доступны внешнему редактору. Возвращаем /media/URL взамен data-URL.
// Бинарная загрузка (основной путь для перетащенных файлов, особенно видео):
// файл шлётся как есть, без base64, и ПОТОКОМ уходит на диск — в памяти
// держится только маленький кусок, а не весь файл. Content-Type = mime файла.
apiRouter.post('/assets/upload', async (req, res) => {
  const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim()
  if (!/^(image|video|audio)\//.test(mime)) {
    return res.status(400).json({ error: 'Expected an image, video, or audio file' })
  }
  // ⚠️ Ограничение mp3/wav было ПЕРЕНЕСЕНО не туда. Оно про аудио-РЕФЕРЕНСЫ
  // (Seedance принимает только эти два формата) и живёт в modelRefLimits, где
  // отказ приходит с понятным текстом. А на импорт оно запрещало положить на
  // доску дорожку с телефона (.m4a) или .ogg — при том, что браузер их играет,
  // а ffmpeg под рукой (найдено прогоном 20.08.2026). Здесь остаётся один
  // осмысленный запрет: тип, для которого мы не знаем расширения, иначе файл
  // лёг бы на диск как .bin и потом не открылся бы ничем.
  if (mime.startsWith('audio/') && extForMime(mime) === 'bin') {
    return res.status(400).json({ error: `Audio in format ${mime} not supported — save track in MP3 or WAV` })
  }
  if (mime === 'image/svg+xml') {
    return res.status(400).json({ error: 'SVG cannot be imported directly; save it as PNG or WebP' })
  }
  const declaredLength = Number(req.header('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_UPLOAD_BYTES) {
    return res.status(413).json({ error: MEDIA_UPLOAD_TOO_LARGE })
  }
  try {
    const saved = await saveStream(req, mime, `import-${randomUUID()}`, MAX_MEDIA_UPLOAD_BYTES)
    res.json({ url: saved.url, mime: saved.mime })
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return res.status(413).json({ error: MEDIA_UPLOAD_TOO_LARGE })
    }
    if (err instanceof Error && (err.message === 'empty file' || err.message === 'пустой файл')) {
      return res.status(400).json({ error: 'The file is empty' })
    }
    res.status(500).json({ error: 'Could not save the file' })
  }
})

// data-URL путь оставлен для одноразовой миграции старых base64-ассетов из проекта
apiRouter.post('/assets', async (req, res) => {
  const { dataUrl } = (req.body ?? {}) as { dataUrl?: unknown }
  if (typeof dataUrl !== 'string' || !/^data:(image|video)\//.test(dataUrl) || dataUrl.startsWith('data:image/svg+xml')) {
    return res.status(400).json({ error: 'Expected an image or video data URL' })
  }
  if (dataUrl.length > MAX_ASSET_DATAURL) {
    return res.status(400).json({ error: 'File too large (maximum ~33 MB)' })
  }
  try {
    const { buffer, mime } = dataUrlToBuffer(dataUrl)
    const saved = await saveBuffer(buffer, mime, `import-${randomUUID()}`)
    res.json({ url: saved.url, mime: saved.mime })
  } catch {
    res.status(500).json({ error: 'Could not save the file' })
  }
})

apiRouter.get('/onboarding', async (_req, res) => {
  try {
    res.json({ onboarding: await onboarding.load((await listProjects()).length > 0) })
  } catch {
    res.status(500).json({ error: 'Could not read onboarding progress' })
  }
})

apiRouter.patch('/onboarding', async (req, res) => {
  try {
    res.json({ onboarding: await onboarding.patch(req.body, (await listProjects()).length > 0) })
  } catch (error) {
    const invalid = error instanceof TypeError
    res.status(invalid ? 400 : 500).json({
      error: invalid ? 'Invalid onboarding progress change' : 'Could not save onboarding progress',
    })
  }
})

// ── настройки ───────────────────────────────────────────────

apiRouter.get('/settings', async (_req, res) => {
  try {
    const settings = await loadSettings()
    // Система нужна интерфейсу, чтобы не показывать маковскому пользователю
    // подсказку с путём вида «C:\Program Files\…». Это не про «определить
    // клиента»: сервер и приложение здесь всегда на одной машине.
    res.json({ ...settings, falKeySet: Boolean(config.falKey), platform: os.platform() })
  } catch {
    res.status(500).json({ error: 'Could not read settings' })
  }
})

apiRouter.post('/settings', async (req, res) => {
  const { externalEditorPath, falKey, optimiseLargeImages, confirmCostAboveUsd, assistantModelId, assistantSystemPrompt, shareLanAccess, faceThreshold, extractorCookiesMode, extractorCookiesFile, tabletDailyGenerationLimit, tabletApproveDailyLimit } = (req.body ?? {}) as {
    externalEditorPath?: unknown
    falKey?: unknown
    optimiseLargeImages?: unknown
    confirmCostAboveUsd?: unknown
    assistantModelId?: unknown
    assistantSystemPrompt?: unknown
    shareLanAccess?: unknown
    faceThreshold?: unknown
    extractorCookiesMode?: unknown
    extractorCookiesFile?: unknown
    tabletDailyGenerationLimit?: unknown
    tabletApproveDailyLimit?: unknown
  }
  if (shareLanAccess !== undefined && typeof shareLanAccess !== 'boolean') {
    return res.status(400).json({ error: 'Invalid local-network access setting' })
  }
  if (externalEditorPath !== null && typeof externalEditorPath !== 'string') {
    return res.status(400).json({ error: 'Invalid settings format' })
  }
  if (falKey !== undefined && falKey !== null && typeof falKey !== 'string') {
    return res.status(400).json({ error: 'Invalid key format' })
  }
  if (optimiseLargeImages !== undefined && typeof optimiseLargeImages !== 'boolean') {
    return res.status(400).json({ error: 'Invalid image-optimization setting' })
  }
  if (assistantModelId !== undefined && typeof assistantModelId !== 'string') {
    return res.status(400).json({ error: 'Invalid model ID format' })
  }
  if (assistantSystemPrompt !== undefined && typeof assistantSystemPrompt !== 'string') {
    return res.status(400).json({ error: 'Invalid system prompt format' })
  }
  if (confirmCostAboveUsd !== undefined && (
    typeof confirmCostAboveUsd !== 'number' ||
    !Number.isFinite(confirmCostAboveUsd) ||
    confirmCostAboveUsd < 0 ||
    confirmCostAboveUsd > 1000
  )) return res.status(400).json({ error: 'Invalid cost-confirmation threshold' })
  // Порог держим в разумных пределах: за ними вердикт становится
  // бессмысленным — либо всё «тот же человек», либо ничего.
  if (faceThreshold !== undefined && (
    typeof faceThreshold !== 'number' ||
    !Number.isFinite(faceThreshold) ||
    faceThreshold < 0.1 ||
    faceThreshold > 0.95
  )) return res.status(400).json({ error: 'Invalid face-similarity threshold' })
  // Ежедневный лимит генераций с планшета. 0 — выключен. Держим в разумных
  // пределах: сотни генераций за день с планшета — это уже не «осторожно».
  if (tabletDailyGenerationLimit !== undefined && (
    typeof tabletDailyGenerationLimit !== 'number' ||
    !Number.isInteger(tabletDailyGenerationLimit) ||
    tabletDailyGenerationLimit < 0 ||
    tabletDailyGenerationLimit > 10000
  )) return res.status(400).json({ error: 'Invalid daily generation limit' })
  // Дневной лимит подтверждённых платных решений агентов с планшета.
  // То же правило валидации, что и у лимита генераций: целое 0..10000, 0 = выкл.
  if (tabletApproveDailyLimit !== undefined && (
    typeof tabletApproveDailyLimit !== 'number' ||
    !Number.isInteger(tabletApproveDailyLimit) ||
    tabletApproveDailyLimit < 0 ||
    tabletApproveDailyLimit > 10000
  )) return res.status(400).json({ error: 'Invalid daily approval limit' })
  if (typeof falKey === 'string' && (falKey.length > 500 || /[\r\n\0]/.test(falKey))) {
    return res.status(400).json({ error: 'Invalid key format' })
  }
  if (extractorCookiesMode !== undefined && !isCookieMode(extractorCookiesMode)) {
    return res.status(400).json({ error: 'Invalid platform sign-in method' })
  }
  if (extractorCookiesFile !== undefined && extractorCookiesFile !== null
    && (typeof extractorCookiesFile !== 'string' || /[\r\n\0]/.test(extractorCookiesFile))) {
    return res.status(400).json({ error: 'Invalid cookie-file path' })
  }
  try {
    const trimmed = typeof externalEditorPath === 'string' ? externalEditorPath.trim() : null
    if (trimmed) {
      const ok = await fs.access(trimmed).then(() => true, () => false)
      if (!ok) return res.status(400).json({ error: `File not found: ${trimmed}` })
    }
    // Файл cookies указан, но его нет — молча сохранить такой путь значит
    // обещать вход, которого не будет, а отказ вылезет уже на скачивании.
    const cookiesFile = typeof extractorCookiesFile === 'string' ? extractorCookiesFile.trim() : null
    if (cookiesFile) {
      const ok = await fs.access(cookiesFile).then(() => true, () => false)
      if (!ok) return res.status(400).json({ error: `Cookie file not found: ${cookiesFile}` })
    }
    const currentSettings = await loadSettings().catch(() => ({
      externalEditorPath: null,
      optimiseLargeImages: false,
      confirmCostAboveUsd: 1,
      assistantModelId: 'gemini',
      assistantSystemPrompt: '',
      shareLanAccess: false,
      faceThreshold: 0.36,
      extractorCookiesMode: 'none' as const,
      extractorCookiesFile: null,
      tabletDailyGenerationLimit: 0,
      tabletApproveDailyLimit: 0,
    }))
    const modelId = typeof assistantModelId === 'string' ? assistantModelId.trim() : currentSettings.assistantModelId || 'gemini'
    const systemPrompt = typeof assistantSystemPrompt === 'string' ? assistantSystemPrompt : currentSettings.assistantSystemPrompt || ''
    await saveSettings({
      externalEditorPath: trimmed || null,
      // Частичная отправка (например, только новый ключ) не должна сбрасывать
      // прежние значения — берём их из текущих настроек.
      optimiseLargeImages: typeof optimiseLargeImages === 'boolean' ? optimiseLargeImages : currentSettings.optimiseLargeImages === true,
      confirmCostAboveUsd: typeof confirmCostAboveUsd === 'number' ? confirmCostAboveUsd : currentSettings.confirmCostAboveUsd ?? 1,
      assistantModelId: modelId,
      assistantSystemPrompt: systemPrompt,
      // Переключатель «где выполнять генерацию». Чужое значение молча
      // игнорируем и оставляем прежнее: подменять путь генерации по опечатке в
      // запросе — последнее, что стоит делать.
      shareLanAccess: typeof shareLanAccess === 'boolean' ? shareLanAccess : currentSettings.shareLanAccess === true,
      faceThreshold: typeof faceThreshold === 'number' ? faceThreshold : currentSettings.faceThreshold ?? 0.36,
      extractorCookiesMode: isCookieMode(extractorCookiesMode)
        ? extractorCookiesMode
        : currentSettings.extractorCookiesMode ?? 'none',
      extractorCookiesFile: extractorCookiesFile === undefined
        ? currentSettings.extractorCookiesFile ?? null
        : cookiesFile || null,
      tabletDailyGenerationLimit: typeof tabletDailyGenerationLimit === 'number'
        ? tabletDailyGenerationLimit
        : currentSettings.tabletDailyGenerationLimit ?? 0,
      tabletApproveDailyLimit: typeof tabletApproveDailyLimit === 'number'
        ? tabletApproveDailyLimit
        : currentSettings.tabletApproveDailyLimit ?? 0,
    })
    // ключ: undefined — не трогать; строка — сохранить; null — убрать
    if (typeof falKey === 'string' && falKey.trim()) {
      await saveFalKey(falKey.trim())
      resetFalBalanceCache()
    } else if (falKey === null) {
      await saveFalKey(null)
      resetFalBalanceCache()
    }
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Could not save settings' })
  }
})

// Частичная правка настроек БЕЗ секретов.
//
// Заведена ради планшета. POST /settings принимает ключ fal и путь к внешнему
// редактору, поэтому с планшетной двери он закрыт и закрытым останется: ключ —
// это чужие деньги. Но порог сходства лиц и порог подтверждения цены — обычные
// рабочие настройки, и запрещать их правку с планшета значит делать планшет
// пультом вместо рабочего места.
//
// Список полей ЯВНЫЙ. Новое поле недоступно отсюда, пока его не впишут руками:
// то же правило, что у белого списка ручек (remoteAllowlist.ts).
//
// Дневной лимит генераций с планшета отсюда НАМЕРЕННО не правится: PATCH
// открыт с планшетной двери, а лимит — это то, чем хозяин ограничивает
// планшет. Дай сюда это поле — гость мог бы сам его снять или спрятать.
// Лимит ставится только с компьютера, через POST /settings.
apiRouter.patch('/settings', async (req, res) => {
  const { confirmCostAboveUsd, faceThreshold, optimiseLargeImages, assistantModelId } = (req.body ?? {}) as {
    confirmCostAboveUsd?: unknown
    faceThreshold?: unknown
    optimiseLargeImages?: unknown
    assistantModelId?: unknown
  }
  if (confirmCostAboveUsd !== undefined && (
    typeof confirmCostAboveUsd !== 'number'
    || !Number.isFinite(confirmCostAboveUsd)
    || confirmCostAboveUsd < 0
    || confirmCostAboveUsd > 1000
  )) return res.status(400).json({ error: 'Invalid cost-confirmation threshold' })
  if (faceThreshold !== undefined && (
    typeof faceThreshold !== 'number'
    || !Number.isFinite(faceThreshold)
    || faceThreshold < 0.1
    || faceThreshold > 0.95
  )) return res.status(400).json({ error: 'Invalid face-similarity threshold' })
  if (optimiseLargeImages !== undefined && typeof optimiseLargeImages !== 'boolean') {
    return res.status(400).json({ error: 'Invalid image-optimization setting' })
  }
  if (assistantModelId !== undefined && (typeof assistantModelId !== 'string' || assistantModelId.length > 120)) {
    return res.status(400).json({ error: 'Invalid model ID format' })
  }
  try {
    const current = await loadSettings()
    await saveSettings({
      ...current,
      confirmCostAboveUsd: typeof confirmCostAboveUsd === 'number' ? confirmCostAboveUsd : current.confirmCostAboveUsd,
      faceThreshold: typeof faceThreshold === 'number' ? faceThreshold : current.faceThreshold,
      optimiseLargeImages: typeof optimiseLargeImages === 'boolean' ? optimiseLargeImages : current.optimiseLargeImages,
      assistantModelId: typeof assistantModelId === 'string' && assistantModelId.trim()
        ? assistantModelId.trim()
        : current.assistantModelId,
    })
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Could not save settings' })
  }
})

/**
 * Подключение к серверу CanAI. Наружу отдаём адрес и имя студии, но НИКОГДА
 * токен: он такой же секрет, как ключ fal, и живёт только в server/.env.
 */
// На macOS диалог тоже есть — свой. Когда-то здесь стоял отказ «только в
// Windows», и человеку оставалось вписывать путь руками, не зная даже, что
// указывать надо бандл «.app». Машинерия обоих диалогов — filePicker.ts.
async function browseFor(target: PickTarget, res: Response): Promise<void> {
  try {
    res.json({ path: await pickFilePath(target) })
  } catch (error) {
    const status = error instanceof FilePickError ? error.status : 500
    res.status(status).json({
      error: error instanceof FilePickError ? error.message : 'Could not open the file picker',
    })
  }
}

apiRouter.post('/settings/editor/browse', async (_req, res) => {
  await browseFor('application', res)
})

/** Файл cookies для импорта по ссылке — см. extractorCookies.ts. */
apiRouter.post('/settings/cookies/browse', async (_req, res) => {
  await browseFor('cookies', res)
})

apiRouter.post('/settings/editor/test', async (req, res) => {
  const { path: editorPath } = (req.body ?? {}) as { path?: unknown }
  if (typeof editorPath !== 'string' || !editorPath.trim()) {
    return res.status(400).json({ error: 'Provide the application path' })
  }
  // ⚠️ Проверяем ТЕМ ЖЕ разрешением пути, которым потом запускаем. Прежняя
  // проверка звала fs.access, а он проходит и на папке: «/Applications/…app»
  // получал «Программа найдена и доступна», а F2 падал со spawn EACCES.
  try {
    const target = await resolveEditorTarget(editorPath)
    res.json({
      ok: true,
      message: target.resolvedFrom
        ? 'Program found. Its executable file inside the bundle will be launched.'
        : 'Program found and available',
      executable: target.executable,
    })
  } catch (error) {
    res.status(400).json({
      error: error instanceof EditorPathError ? error.message : `File not found: ${editorPath.trim()}`,
    })
  }
})

// ── Открытие файла в Проводнике/Finder ───────────────────────

apiRouter.post('/media/reveal', async (req, res) => {
  const { src } = (req.body ?? {}) as { src?: unknown }
  if (typeof src !== 'string' || !src.startsWith('/media/') || src.includes('..')) {
    return res.status(400).json({ error: 'Invalid file path' })
  }
  try {
    // «Показать в папке»: путь ищет раскладка, иначе Проводник открылся бы
    // на корне media, где файла уже нет.
    const absolutePath = path.resolve(mediaFilePath(src))

    // Проверяем доступность файла
    await fs.access(absolutePath)

    const platform = os.platform()
    // Без shell: путь доходит аргументом, а не частью командной строки —
    // имя доски (и media-файла) не может исполнить команду.
    if (platform === 'win32') {
      // explorer принимает /select,"путь" только слитной строкой; вербатим-арг
      // собирает её без cmd.exe. explorer часто отвечает кодом 1 даже при
      // успехе — ошибки запуска игнорируем.
      spawn('explorer.exe', [`/select,"${absolutePath}"`], {
        windowsVerbatimArguments: true,
        detached: true,
        stdio: 'ignore',
      }).on('error', () => {}).unref()
    } else if (platform === 'darwin') {
      execFile('open', ['-R', absolutePath], () => {})
    } else {
      execFile('xdg-open', [path.dirname(absolutePath)], () => {})
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Could not show the file in Explorer' })
  }
})

// ── «Открыть в …» (внешний редактор) ────────────────────────

function isSafeEditIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

apiRouter.post('/edit-sessions', async (req, res) => {
  const { src, projectId, sourceItemId, sourceName, boardSource, boardName } =
    (req.body ?? {}) as Record<string, unknown>
  if (typeof src !== 'string' || !src.startsWith('/media/') || src.includes('..')) {
    return res.status(400).json({ error: 'Invalid file path' })
  }
  if (
    !isSafeEditIdentifier(projectId) ||
    !isSafeEditIdentifier(sourceItemId) ||
    typeof sourceName !== 'string' ||
    !sourceName.trim() ||
    sourceName.length > 200 ||
    (boardSource !== undefined && boardSource !== 'local') ||
    (boardName !== undefined && (typeof boardName !== 'string' || boardName.length > 200))
  ) {
    return res.status(400).json({ error: 'Invalid editor-session data' })
  }
  try {
    res.json(await startEditSession({
      src,
      projectId,
      sourceItemId,
      sourceName: sourceName.trim(),
      ...(typeof boardName === 'string' && boardName.trim() ? { boardName: boardName.trim() } : {}),
    }))
  } catch (err) {
    if (err instanceof EditSessionError) {
      return res.status(400).json({ error: err.message, code: err.code })
    }
    res.status(500).json({ error: 'Could not open the file in the editor' })
  }
})

apiRouter.get('/edit-sessions', async (_req, res) => {
  try {
    res.json({ sessions: await listEditSessions() })
  } catch {
    res.status(500).json({ error: 'Could not read the editor session' })
  }
})

apiRouter.patch('/edit-sessions/:id', async (req, res) => {
  if (!isSafeEditIdentifier(req.params.id)) {
    return res.status(400).json({ error: 'Invalid session ID' })
  }
  const { appliedMtime, placedItemId } = (req.body ?? {}) as Record<string, unknown>
  if (!Number.isFinite(appliedMtime) || !isSafeEditIdentifier(placedItemId)) {
    return res.status(400).json({ error: 'Invalid edit confirmation' })
  }
  try {
    const session = await acknowledgeEditSession(req.params.id, {
      appliedMtime: appliedMtime as number,
      placedItemId,
    })
    if (!session) return res.status(404).json({ error: 'Session not found' })
    res.json({ session })
  } catch (err) {
    if (err instanceof Error && /новее|newer|more recent/i.test(err.message)) {
      return res.status(400).json({ error: err.message })
    }
    res.status(500).json({ error: 'Could not confirm the edit' })
  }
})

apiRouter.delete('/edit-sessions/:id', async (req, res) => {
  if (!isSafeEditIdentifier(req.params.id)) {
    return res.status(400).json({ error: 'Invalid session ID' })
  }
  try {
    if (!await stopEditSession(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' })
    }
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Could not stop tracking' })
  }
})

apiRouter.get('/edit-sessions/:id', async (req, res) => {
  if (!isSafeEditIdentifier(req.params.id)) {
    return res.status(400).json({ error: 'Invalid session ID' })
  }
  try {
    const mtime = await getSessionMtime(req.params.id)
    if (mtime === null) return res.status(404).json({ error: 'Session not found' })
    res.json({ mtime })
  } catch {
    res.status(500).json({ error: 'Could not read the editor session' })
  }
})

apiRouter.get('/jobs/:id', async (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job || job.internal) return res.status(404).json({ error: 'Job not found' })
  // refs наружу не отдаём: там могут быть большие data-URI
  res.json(publicLocalJob(job))
})

/**
 * Состояние сразу нескольких задач с ожиданием изменения (пункт 3.7): вместо
 * опроса каждой задачи раз в 0,9 с приложение держит один запрос, и ответ
 * приходит в тот же миг, когда исполнитель узнал новость. См. `jobWait.ts`.
 */
apiRouter.post('/jobs/wait', async (req, res) => {
  const body = (req.body ?? {}) as { ids?: unknown; seen?: unknown; waitMs?: unknown }
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 400))]
    : []
  if (ids.length === 0 || ids.length > MAX_WAITED_JOBS) {
    return res.status(400).json({ error: 'No jobs specified' })
  }
  const seen: Record<string, string> = {}
  if (body.seen && typeof body.seen === 'object' && !Array.isArray(body.seen)) {
    for (const [id, version] of Object.entries(body.seen as Record<string, unknown>)) {
      if (typeof version === 'string') seen[id] = version
    }
  }
  const waitMs = typeof body.waitMs === 'number' && Number.isFinite(body.waitMs) ? body.waitMs : 0
  // ⚠️ Уход клиента ловим на ОТВЕТЕ: у POST событие close запроса приходит,
  // как только прочитано тело, — задолго до того, как клиент ушёл.
  const gone = { aborted: false }
  res.on('close', () => { if (!res.writableEnded) gone.aborted = true })
  const entries = await waitForJobs(ids, seen, waitMs, jobWaitDeps, gone)
  if (gone.aborted || res.writableEnded) return
  res.json({ entries })
})

const jobWaitDeps: JobWaitDeps = {
  local: (id) => jobs.get(id),
  allLocal: () => jobs.all(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

// отмена генерации: помечаем задачу и просим fal снять её из очереди.
// Задачу В ОЧЕРЕДИ отменяем сразу (денег ещё не потрачено). Задачу В РАБОТЕ
// не перетираем: fal может отказать в отмене (генерация уже оплачена) — тогда
// runner доведёт её до done и результат НЕ потеряется (аудит GEN-02);
// если fal успел снять запрос — runner сам поставит «отменено».
apiRouter.post('/jobs/:id/cancel', async (req, res) => {
  // Сама отмена живёт в runner (cancelJobById): тем же путём отменяет шаги
  // макроса, и двум копиям этой логики расходиться нельзя — это деньги.
  // Отказ сервера команды — его словами и его кодом: «остановить может только
  // тот, кто запустил» не имеет ничего общего с записью на диск.
  try {

    const outcome = await cancelJobById(req.params.id)
    if (outcome === 'not-found') return res.status(404).json({ error: 'Job not found' })
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Cancellation accepted but could not be saved to disk' })
  }
})

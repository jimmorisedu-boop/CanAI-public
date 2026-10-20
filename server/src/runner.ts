import { randomUUID } from 'node:crypto'
import { resolveCatalogPreset, type ResolvedModel, CATALOG, type CatalogModel } from './catalog.js'
import { resolveForRefs } from './modelRefLimits.js'
import { JobRefsRefusedError, newJobRefsRefusal } from './jobRefsGuard.js'
import { config } from './config.js'
import { cancelFalRequest, falErrorMessage, generateByModel, resumeByModel } from './fal.js'
import {
  generationGate,
  type GenerationLease,
  type GenerationRoute,
  withGenerationAdmission,
} from './generationGate.js'
import {
  findEffectiveCatalogPreset,
  prepareImageParams,
  usesImageParamAdapter,
} from './imageParams.js'
import { deliverCanvasJob, isCanvasTarget } from './canvasDelivery.js'
import { jobs, type Job } from './jobs.js'
import { logError } from './log.js'
import { mockImage, mockText, mockVideo } from './mock.js'
import { applyRefTags, resolveRefs, withTextContext, withTextSuffix } from './refs.js'
import { parseCanvasActionPreparationResponse } from './canvasActionPreparation.js'
import { probeLocalMediaDimensions, saveBuffer, saveFromUrl } from './storage.js'
import {
  finalizeCompactionJob,
  finalizePromptChatJob,
  prepareCompactionJob,
  preparePromptChatJob,
  promptChatRepository,
  schedulePromptChatCompaction,
  type CompactionJobDescriptor,
} from './promptChatDelivery.js'
import { loadSettings } from './settings.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_CONCURRENT_JOBS = 3

class JobCancelledError extends Error {}
class JobDeferredForShutdownError extends Error {}

export async function persistUntilDurableForShutdown(
  persist: () => Promise<void>,
  lease: GenerationLease,
  onError: (error: unknown) => void,
  waitForRetry: () => Promise<void> = () => sleep(1_000),
): Promise<void> {
  while (true) {
    try {
      await persist()
      lease.release()
      return
    } catch (error) {
      onError(error)
      await waitForRetry()
    }
  }
}

function ensureActive(job: Job): void {
  if (job.cancelled) throw new JobCancelledError('Cancelled')
}

// Скачивание оплаченного результата — самый уязвимый шаг: fal работу уже
// выполнил и списал деньги, а его CDN может моргнуть на несколько секунд.
// Сохраняем URL в job.paidResult (переживает рестарт) и делаем несколько
// терпеливых раундов с паузой — раньше один затяжной сбой сети терял
// оплаченный файл навсегда.
async function downloadPaidResult(
  job: Job,
  paid: { url: string; width?: number; height?: number; seed?: number },
  progress: (text: string) => void,
): Promise<void> {
  job.paidResult = paid
  let lastError: unknown
  for (let round = 0; round < 3; round++) {
    try {
      progress(round === 0 ? 'downloading result…' : 'CDN did not respond — retrying the download…')
      const saved = await saveFromUrl(paid.url, job.id)
      job.result = { url: saved.url, width: paid.width, height: paid.height, mime: saved.mime, seed: paid.seed }
      // Файл у нас — сервер CanAI может убрать свою копию. Ошибку подтверждения
      // глотаем намеренно: результат уже сохранён, а копия уйдёт по сроку.
      return
    } catch (err) {
      lastError = err
      if (round < 2) await sleep(20_000)
    }
  }
  throw lastError
}

async function runReal(
  job: Job,
  model: ResolvedModel,
  promptInput: string,
  refsInput: Job['refs'],
  releaseExecutionLease: () => void,
): Promise<void> {
  const progress = (text: string) => {
    job.progressText = text
  }
  // координаты запроса в очереди fal — для отмены с клиента
  const enqueued = async (requestId: string, endpoint: string) => {
    job.falEndpoint = endpoint
    job.falRequestId = requestId
    if (job.cancelled) void cancelFalRequest(endpoint, requestId).catch(() => {})
    try {
      await jobs.persistNow()
      releaseExecutionLease()
    } catch (err) {
      logError('jobs', `could not save requestId ${job.id}: ${falErrorMessage(err)}`)
      // Не отпускаем lease: если в этот момент начнётся shutdown, старый
      // процесс останется alive до завершения job и повторной записи ниже.
      // Это безопаснее потери или повторной оплаты fal-request.
    }
  }

  const params = job.params ?? {}
  const existingRequestId = job.falEndpoint ? job.falRequestId : undefined

  // после того как generateByModel/resumeByModel ВЕРНУЛИ результат, ensureActive
  // больше не зовём: работа уже оплачена fal'ом, и выбрасывать её из-за поздней
  // отмены — прямая потеря денег (аудит GEN-02). Отмена честно работает только
  // ДО старта оплачиваемой работы.
  // Докачка после сбоя/рестарта: результат уже оплачен и его URL сохранён —
  // никакого нового submit, только скачивание.
  if (job.paidResult && !job.result) {
    releaseExecutionLease()
    await downloadPaidResult(job, job.paidResult, progress)
    return
  }

  if (existingRequestId) {
    releaseExecutionLease()
    progress('restoring waiting jobs fal…')
    const restored = await resumeByModel(model, existingRequestId, progress, job.falEndpoint)
    if (model.kind === 'text') {
      job.result = { text: restored.text }
      return
    }
    await downloadPaidResult(job, {
      url: restored.url as string,
      width: restored.width,
      height: restored.height,
      seed: restored.seed,
    }, progress)
    return
  }

  if (model.kind === 'text') {
    ensureActive(job)
    const { imageUrls, videoUrls, audioUrls, textParts } = await resolveRefs(refsInput, progress)
    ensureActive(job)
    const tagged = applyRefTags(promptInput, refsInput, model.refTagStyle)
    const prompt = withTextContext(tagged, textParts)
    if (generationGate.shuttingDown) throw new JobDeferredForShutdownError()
    const out = await generateByModel(model, prompt, imageUrls, videoUrls, audioUrls, params, progress, enqueued)
    job.result = { text: out.text }
    return
  }

  ensureActive(job)
  const { imageUrls, videoUrls, audioUrls, textParts } = await resolveRefs(refsInput, progress)
  ensureActive(job)
  // сначала переводим @n-ссылки на референсы в синтаксис модели (или убираем,
  // если не поддерживает), затем дописываем текст-референсы в конец промпта
  const tagged = applyRefTags(promptInput, refsInput, model.refTagStyle)
  const prompt = withTextSuffix(tagged, textParts)
  // роли image-референсов в порядке imageUrls (resolveRefs грузит их тем же
  // обходом job.refs) — для моделей с именованными входами (Ideogram)
  const imageRoles = refsInput.filter((r) => r.kind === 'image').map((r) => r.role)
  if (generationGate.shuttingDown) throw new JobDeferredForShutdownError()
  const media = await generateByModel(model, prompt, imageUrls, videoUrls, audioUrls, params, progress, enqueued, imageRoles)

  await downloadPaidResult(job, {
    url: media.url as string,
    width: media.width,
    height: media.height,
    seed: media.seed,
  }, progress)
}

async function runMock(
  job: Job,
  model: ResolvedModel,
  promptInput: string,
  refsInput: Job['refs'],
): Promise<void> {
  job.progressText = 'mock-mode: building placeholder…'
  await sleep(1200)
  ensureActive(job)
  if (model.kind === 'text') {
    if (job.target?.kind === 'canvas-action') {
      // Mock mode still exercises the closed preparation boundary. Return the
      // same machine-readable shape as a real LLM, while keeping the fixture
      // deterministic and free of model/URL/params/tool fields.
      job.result = { text: JSON.stringify({ prompt: job.prompt }) }
      return
    }
    const textParts = refsInput.filter((r) => r.kind === 'text' && r.text).map((r) => r.text as string)
    const imageRefsCount = refsInput.filter((r) => r.kind === 'image').length
    const videoRefsCount = refsInput.filter((r) => r.kind === 'video').length
    const audioRefsCount = refsInput.filter((r) => r.kind === 'audio').length
    let contextStr = withTextContext(promptInput, textParts)
    if (imageRefsCount) {
      contextStr += `\n\n[Image references: ${imageRefsCount}]`
    }
    if (videoRefsCount) contextStr += `\n\n[Video-references: ${videoRefsCount}]`
    if (audioRefsCount) contextStr += `\n\n[Audio-references: ${audioRefsCount}]`
    job.result = { text: mockText(contextStr) }
  } else if (model.kind === 'image' || model.kind === 'other') {
    const imageRefs = refsInput.filter((r) => r.kind === 'image').length
    const textRefs = refsInput.filter((r) => r.kind === 'text').length
    const mock = mockImage(promptInput, imageRefs, textRefs, job.params)
    const saved = await saveBuffer(mock.buffer, 'image/svg+xml', job.id)
    const mockSeed = job.model === 'seedvr-seamless-upscale'
      ? (typeof job.params?.seed === 'number' && job.params.seed >= 0 ? job.params.seed : 42)
      : undefined
    job.result = {
      url: saved.url,
      width: mock.width,
      height: mock.height,
      mime: saved.mime,
      seed: mockSeed,
    }
  } else {
    const mock = await mockVideo(job.id)
    job.result = { url: mock.url, width: mock.width, height: mock.height, mime: 'video/mp4' }
  }
}

function effectiveGenerationRoute(job: Job): GenerationRoute {
  return job.generationRoute ?? (config.mockMode ? 'mock' : 'local')
}

function parseRatio(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(?::|x)(\d+(?:\.\d+)?)$/.exec(v)
  if (m) {
    const w = Number(m[1])
    const h = Number(m[2])
    if (w > 0 && h > 0) return w / h
  }

  const IMAGE_SIZE_RATIO: Record<string, number> = {
    square: 1,
    square_hd: 1,
    portrait_4_3: 3 / 4,
    portrait_16_9: 9 / 16,
    landscape_4_3: 4 / 3,
    landscape_16_9: 16 / 9,
  }
  return IMAGE_SIZE_RATIO[v] ?? null
}

function parseVideoHeight(opt: string): number | null {
  if (opt === '1k') return 1024
  if (opt === '2k') return 2048
  if (opt === '4k') return 2160
  const m = /^(\d+)p$/.exec(opt)
  return m ? Number(m[1]) : null
}

function resolveAutoParams(
  userParams: Record<string, unknown>,
  refs: Job['refs'],
  preset?: CatalogModel,
): Record<string, unknown> {
  const params = { ...userParams }
  if (!preset) return params

  let firstMediaRef = refs.find((r) => (r.kind === 'image' || r.kind === 'video') && r.width && r.height)
  if (!firstMediaRef) {
    const rawRef = refs.find((r) => (r.kind === 'image' || r.kind === 'video') && r.src)
    if (rawRef) {
      const probed = probeLocalMediaDimensions(rawRef.src)
      if (probed) {
        firstMediaRef = { ...rawRef, width: probed.width, height: probed.height }
      }
    }
  }

  // Для моделей без специального image-адаптера сохраняем прежний auto-резолв:
  // выбираем ближайшую поддерживаемую пропорцию по первому медиа-референсу.
  if (params.aspect_ratio === 'auto' && !usesImageParamAdapter(preset)) {
    const spec = preset.params?.find((p) => p.name === 'aspect_ratio')
    if (spec && spec.options) {
      const refRatio = firstMediaRef && firstMediaRef.width && firstMediaRef.height
        ? firstMediaRef.width / firstMediaRef.height
        : null

      let bestOption: string | null = null
      if (refRatio !== null) {
        let minDiff = Infinity
        for (const opt of spec.options) {
          if (opt.value === 'auto') continue
          const optRatio = parseRatio(opt.value)
          if (optRatio === null) continue

          const diff = Math.abs(refRatio - optRatio)
          if (diff < minDiff) {
            minDiff = diff
            bestOption = opt.value
          }
        }
      }

      if (bestOption) {
        params.aspect_ratio = bestOption
      } else {
        const defaultOpt = spec.default && spec.default !== 'auto' ? String(spec.default) : null
        const fallbackOpt = defaultOpt ?? spec.options.find((o) => o.value !== 'auto')?.value
        if (fallbackOpt) params.aspect_ratio = fallbackOpt
      }
    }
  }

  if (params.resolution === 'auto') {
    const spec = preset.params?.find((p) => p.name === 'resolution')
    if (spec && spec.options) {
      if (firstMediaRef && firstMediaRef.height) {
        let bestVideoOpt: string | null = null
        let minDiff = Infinity
        const refHeight = firstMediaRef.height

        for (const opt of spec.options) {
          if (opt.value === 'auto') continue
          const optHeight = parseVideoHeight(opt.value)
          if (optHeight === null) continue

          const diff = Math.abs(refHeight - optHeight)
          if (diff < minDiff) {
            minDiff = diff
            bestVideoOpt = opt.value
          }
        }
        if (bestVideoOpt) {
          params.resolution = bestVideoOpt
        }
      }

      if (params.resolution === 'auto') {
        const defaultOpt = spec.default && spec.default !== 'auto' ? String(spec.default) : null
        const fallbackOpt = defaultOpt ?? spec.options.find((o) => o.value !== 'auto')?.value
        if (fallbackOpt) params.resolution = fallbackOpt
      }
    }
  }

  return params
}

export async function runJob(job: Job): Promise<void> {
  // queued-отмена финализируется route'ом синхронно — сюда такая задача
  // приходит уже со статусом error. Отменённую running-задачу НЕ пропускаем:
  // ниже она доберёт оплаченный результат по requestId или завершится
  // «отменено» (см. catch) — пропуск оставлял её running навсегда.
  if (job.cancelled && (job.status === 'done' || job.status === 'error')) {
    await deliverJobResult(job)
    jobs.expireLater(job.id)
    return
  }
  const legacyTargetSource = (job.target as unknown as { source?: unknown } | undefined)?.source
  const legacyRoute = (job as unknown as { generationRoute?: unknown }).generationRoute
  if (legacyTargetSource === 'cloud' || legacyRoute === 'account-cloud' || legacyRoute === 'legacy-cloud') {
    job.status = 'error'
    job.error = 'This local edition cannot resume a shared Cloud generation'
    job.progressText = undefined
    job.finishedAt = Date.now()
    await jobs.persistNow()
    jobs.expireLater(job.id)
    return
  }
  const executionLease = generationGate.tryEnter()
  if (!executionLease) return
  let executionLeaseReleased = false
  const releaseExecutionLease = () => {
    executionLeaseReleased = true
    executionLease.release()
  }
  let deferredForShutdown = false
  try {
    job.status = 'running'
    await jobs.persistNow()
    const prepared = job.target?.kind === 'prompt-chat'
      ? await preparePromptChatJob(promptChatRepository, job)
      : job.target?.kind === 'prompt-chat-compaction'
        ? await prepareCompactionJob(promptChatRepository, job)
        : {
            prompt: job.target?.kind === 'canvas-action'
              ? job.canvasActionPrompt ?? job.prompt
              : job.prompt,
            refs: job.refs,
            estimatedInputTokens: 0,
          }
    // Ролик или звук к модели, которая их не берёт, — отказ словами, а не
    // тихий переезд в другую семью с другой ценой (jobRefsGuard.ts).
    const refusal = newJobRefsRefusal(job, prepared.refs)
    if (refusal) throw new JobRefsRefusedError(refusal)
    // тип определяется РЕАЛЬНОЙ моделью (свой endpoint может сменить kind);
    // вариант семьи — тем же правилом, что у проверки перед запуском
    const model = job.modelSnapshot
      ? resolveCatalogPreset(job.modelSnapshot)
      : resolveForRefs(job.model, job.kind, prepared.refs)

    // Каталог командной доски принадлежит серверу. Неизвестный локально id
    // модели не должен добавлять в v3-запрос параметры локального пресета:
    // формат кадра, размер, формат файла и другие значения по умолчанию.
    {
      // Фактический endpoint важнее исходного id: ref-вариант должен получить
      // параметры своей edit-схемы, а не базового пресета.
      const preset = job.modelSnapshot ?? findEffectiveCatalogPreset(CATALOG, model.endpoint, job.model)
      const mergedParams = { ...model.defaults, ...(job.params ?? {}) }
      if (preset && usesImageParamAdapter(preset)) {
        job.params = prepareImageParams(preset, mergedParams, prepared.refs)
      } else if (preset) {
        job.params = resolveAutoParams(mergedParams, prepared.refs, preset)
      } else {
        job.params = mergedParams
      }
    }

    // ⚠️ Задача с сохранённым маршрутом идёт по нему: у отправленной на
    // сервер задачи повторный локальный запуск списал бы деньги дважды.
    const route = effectiveGenerationRoute(job)

    if (route === 'mock') {
      if (generationGate.shuttingDown) throw new JobDeferredForShutdownError()
      await runMock(job, model, prepared.prompt, prepared.refs)
    }  else if (route === 'local' && (config.falKey || job.falRequestId)) {
      await runReal(
        job,
        model,
        prepared.prompt,
        prepared.refs,
        releaseExecutionLease,
      )
    } else {
      throw new Error('fal.ai key is not configured')
    }
    if (job.target?.kind === 'canvas-action' && typeof job.result?.text === 'string') {
      job.result = { text: parseCanvasActionPreparationResponse(job.result.text).prompt }
    }
    // результат получен — он уже оплачен, доставляем его даже если пользователь
    // успел нажать «Стоп» (отмена «не успела» — терять оплаченное нельзя)
    job.status = 'done'
    job.error = undefined
    job.progressText = undefined
    job.finishedAt = Date.now()
  } catch (err) {
    if (err instanceof JobDeferredForShutdownError) {
      deferredForShutdown = true
      job.status = 'queued'
      job.error = undefined
      job.progressText = undefined
      job.finishedAt = undefined
    } else {
      job.status = 'error'
      job.progressText = undefined
      job.finishedAt = Date.now()
    }
    if (deferredForShutdown) {
      // Задача не дошла до платного submit и останется queued для следующего
      // production-процесса.
    } else if (job.cancelled || err instanceof JobCancelledError) {
      // fal успел снять запрос (или отмена пришла до старта) — честное «отменено»
      job.error = 'Cancelled'
    } else {
      // ⚠️ Ошибку сервера CanAI НЕ пропускаем через falErrorMessage: тот
      // перефразирует сетевые сбои в терминах fal и договаривает «результат уже
      // оплачен». Для задачи, которая до провайдера даже не дошла, это ложь —
      // и самая неприятная из возможных, потому что про деньги.
      job.error = err instanceof JobRefsRefusedError
        ? err.message
        : falErrorMessage(err)
      logError('job', `${job.kind} «${job.prompt.slice(0, 80)}»: ${job.error}`)
    }
  } finally {
    let finalStateDurable = false
    try {
      if (deferredForShutdown) {
        try {
          await jobs.persistNow()
          finalStateDurable = true
        } catch (err) {
          logError('jobs', `could not defer ${job.id}: ${falErrorMessage(err)}`)
        }
      } else {
        // задача финализирована — референсы больше не нужны ни на диске, ни в
        // памяти (data-URL скетча может весить мегабайты, а запись живёт неделю)
        job.refs = []
        try {
          await jobs.persistNow()
          finalStateDurable = true
        } catch (err) {
          logError('jobs', `could not save completion ${job.id}: ${falErrorMessage(err)}`)
        }
        await deliverJobResult(job)
        jobs.expireLater(job.id)
      }
    } finally {
      if (finalStateDurable) {
        releaseExecutionLease()
      } else if (!executionLeaseReleased) {
        // Не даём shutdown выйти с недолговечным requestId или running mock.
        // При восстановлении диска повтор сам отпустит barrier; при устойчивом
        // сбое launcher честно получит timeout, а старый процесс останется жив.
        void persistUntilDurableForShutdown(
          () => jobs.persistNow(),
          executionLease,
          (error) => logError(
            'jobs',
            `retry saving ${job.id} before shutdown: ${falErrorMessage(error)}`,
          ),
        )
      }
    }
  }
}

export async function enqueueCompactionJob(descriptor: CompactionJobDescriptor): Promise<void> {
  const job = jobs.create(
    'text',
    descriptor.prompt,
    [],
    descriptor.model,
    { max_tokens: 4096 },
    descriptor.target,
    true,
    descriptor.id,
  )
  await persistAndEnqueueJob(job)
}

export type CancelJobOutcome = 'not-found' | 'already-final' | 'cancelled'

/**
 * Отменить задачу.
 *
 * Одна точка на всех: маршрут /jobs/:id/cancel и прогон макроса. Отмена здесь
 * МЯГКАЯ — queued гасим сразу, а идущую доводим до конца: если fal откажет в
 * отмене, генерация уже оплачена, и результат должен доехать до доски, а не
 * пропасть.
 */
export async function cancelJobById(id: string): Promise<CancelJobOutcome> {
  const job = jobs.get(id)
  if (!job || job.internal) return 'not-found'
  if (job.status === 'done' || job.status === 'error') return 'already-final'
  job.cancelled = true
  if (job.status === 'queued') {
    job.status = 'error'
    job.error = 'Cancelled'
    job.progressText = undefined
    job.finishedAt = Date.now()
    job.refs = []
  } else {
    job.progressText = 'cancelling…'
  }
  if (job.falEndpoint && job.falRequestId) {
    cancelFalRequest(job.falEndpoint, job.falRequestId).catch(() => {})
  }
  await jobs.persistNow()
  if (job.status === 'error') {
    await deliverJobResult(job)
    jobs.expireLater(job.id)
  }
  return 'cancelled'
}

export async function deliverJobResult(job: Job): Promise<void> {
  if (!job.target || job.deliveredAt !== undefined) return
  try {
    if (isCanvasTarget(job.target)) {
      // Ошибка не является доставкой на холст: paidResult/requestId ещё нужны
      // restoreJobs для получения уже оплаченного результата.
      if (job.status !== 'done' || (!job.result?.url && !job.result?.text)) return
      await deliverCanvasJob(job, job.target)
    } else if (job.target.kind === 'canvas-action') {
      // Preparation is review-only. There is intentionally no board delivery,
      // pending-card mutation, or implicit follow-up media launch.
      // Keep a failed-but-paid/provider-owned action recoverable: restoreJobs
      // uses the request id, paid URL, or Cloud job id to resume the same
      // durable work. Terminal validation/cancel errors may be acknowledged.
      if (
        job.status !== 'done'
        && !job.cancelled
        && (job.paidResult || job.falRequestId)
      ) return
    } else if (job.target.kind === 'prompt-chat') {
      await finalizePromptChatJob(promptChatRepository, job)
    } else {
      await finalizeCompactionJob(promptChatRepository, job)
    }
    job.deliveredAt = Date.now()
    deliveryRetryAttempts.delete(job.id)
    job.deliveryFailures = undefined
    await jobs.persistNow()
  } catch (error) {
    job.deliveryFailures = (job.deliveryFailures ?? 0) + 1
    await jobs.persistNow().catch(() => {})
    const scope = isCanvasTarget(job.target) ? 'canvas-delivery' : 'prompt-chat'
    if (job.deliveryFailures >= MAX_DELIVERY_FAILURES) {
      logError(
        scope,
        `delivery ${job.id} stopped after ${job.deliveryFailures} attempts: ${falErrorMessage(error)}`,
      )
      return
    }
    logError(scope, `could not deliver ${job.id}: ${falErrorMessage(error)}`)
    // Ответ assistant'а УЖЕ оплачен — не оставляем сообщение «генерируется…»
    // до перезапуска сервера: повторяем доставку с нарастающей паузой
    // (последний шанс — рестарт или восстановление доски из корзины).
    scheduleDeliveryRetry(job.id)
    return
  }

  if (job.target?.kind === 'prompt-chat' && job.status === 'done') {
    try {
      const settings = await loadSettings()
      await schedulePromptChatCompaction(promptChatRepository, job, {
        confirmCostAboveUsd: settings.confirmCostAboveUsd,
        reserveId: randomUUID,
        createJob: enqueueCompactionJob,
      })
    } catch (error) {
      logError('prompt-chat', `could not schedule memory ${job.id}: ${falErrorMessage(error)}`)
    }
  }
}

// Повторы доставки оплаченного ответа чата. Ключи выживают между попытками,
// таймеры unref — сервер не держит их при выходе (restoreJobs подхватит).
const DELIVERY_RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000, 30 * 60_000]
/**
 * ⚠️ Повторы обязаны КОНЧАТЬСЯ. Счётчик попыток жил в памяти процесса, поэтому
 * каждый запуск приложения начинал лесенку заново: безнадёжная доставка
 * повторялась вечно и заливала журнал — одна и та же строка 62 раза за десять
 * дней (журнал тестировщика 20.09.2026). Потолок с запасом: четыре ступени
 * лесенки на три запуска. Явный повтор — восстановление доски из корзины —
 * счётчик обнуляет: там причина отказа временная по природе.
 */
const MAX_DELIVERY_FAILURES = 12
const deliveryRetryAttempts = new Map<string, number>()

function scheduleDeliveryRetry(jobId: string): void {
  const attempts = deliveryRetryAttempts.get(jobId) ?? 0
  if (attempts >= DELIVERY_RETRY_DELAYS_MS.length) return
  deliveryRetryAttempts.set(jobId, attempts + 1)
  const timer = setTimeout(() => {
    void (async () => {
      const fresh = jobs.get(jobId)
      if (fresh && fresh.deliveredAt === undefined) await deliverJobResult(fresh)
    })().catch(() => {})
  }, DELIVERY_RETRY_DELAYS_MS[attempts])
  timer.unref()
}

// Задача могла завершиться, пока её доска лежала в корзине. Держим результат
// durable и повторяем доставку сразу после восстановления этой доски, не дожидаясь
// перезапуска сервера.
export async function redeliverProjectJobs(projectId: string): Promise<void> {
  for (const job of jobs.all()) {
    if (
      job.target?.projectId === projectId
      && job.deliveredAt === undefined
      && (job.status === 'done' || job.status === 'error')
    ) {
      // Доска вернулась из корзины — это новая причина, лесенку начинаем заново.
      job.deliveryFailures = undefined
      await deliverJobResult(job)
    }
  }
}

const pendingJobs: Job[] = []
let runningJobs = 0

function pumpJobs(): void {
  if (generationGate.shuttingDown) return
  while (runningJobs < MAX_CONCURRENT_JOBS && pendingJobs.length > 0) {
    if (generationGate.shuttingDown) return
    const job = pendingJobs.shift()!
    // Отменённые пропускаем ТОЛЬКО если статус уже финальный (queued-отмену
    // route финализирует сам). Отменённая, но всё ещё running-задача обязана
    // дойти до runJob: там она либо доберёт уже оплаченный fal-результат по
    // requestId, либо честно завершится «отменено» — иначе зомби «running
    // навсегда» (слот liveCount занят, спиннер у клиента вечен).
    if (job.cancelled && (job.status === 'done' || job.status === 'error')) {
      jobs.expireLater(job.id)
      continue
    }
    runningJobs++
    void runJob(job).finally(() => {
      runningJobs--
      pumpJobs()
    })
  }
}

export function enqueueJob(job: Job): void {
  pendingJobs.push(job)
  pumpJobs()
}

export async function persistAndEnqueueJob(job: Job): Promise<void> {
  try {
    await withGenerationAdmission(generationGate, async () => {
      await jobs.persistNow()
      enqueueJob(job)
    })
  } catch (error) {
    jobs.remove(job.id)
    throw error
  }
}

/** Сколько запусков приложения подряд пробуем вернуть оплаченный результат. */
export const MAX_RECOVERY_ATTEMPTS = 5

export async function restoreJobs(): Promise<{ restored: number; failed: number }> {
  const active = await jobs.restore()
  let restored = 0
  let failed = 0
  let changed = false

  for (const job of jobs.all()) {
    if (
      job.target
      && job.deliveredAt === undefined
      && (job.status === 'done' || job.status === 'error')
    ) {
      await deliverJobResult(job)
    }
  }

  for (const job of active) {
    const route = effectiveGenerationRoute(job)
    const hasFalRequest = Boolean(job.falEndpoint && job.falRequestId)
    // Отменённая задача после рестарта: с requestId — восстанавливаем ожидание
    // (результат мог быть оплачен, runJob доведёт до done или «отменено»);
    // без requestId возобновлять нечего — честно финализируем «отменено».
    // Раньше стоял голый `continue`, и отменённая running-задача зависала
    // в jobs.json навсегда, занимая слот liveCount.
    if (job.cancelled && !(job.status === 'running' && hasFalRequest)) {
      if (job.status !== 'done' && job.status !== 'error') {
        job.status = 'error'
        job.error = 'Cancelled'
        job.progressText = undefined
        job.finishedAt = Date.now()
        job.refs = []
        changed = true
      }
      jobs.expireLater(job.id)
      continue
    }
    if (job.status === 'running' && route === 'local' && config.falKey && !hasFalRequest) {
      // Повторный submit небезопасен: запрос мог уйти в fal прямо перед падением процесса.
      job.status = 'error'
      job.error = 'Server restarted while saving requestId — retrying generation'
      job.progressText = undefined
      job.finishedAt = Date.now()
      jobs.expireLater(job.id)
      failed++
      changed = true
      continue
    }
    if (job.status === 'running' && !hasFalRequest && !(route === 'local' && config.falKey)) {
      job.status = 'queued'
      changed = true
    }
    enqueueJob(job)
    restored++
  }

  // Оплатили fal, но упали на ожидании/скачивании (сеть, CDN, таймаут
  // скачивания). Результат всё ещё доступен по requestId/платному URL —
  // воскрешаем задачу: повторного submit не будет, только ожидание той же
  // очереди и скачивание. Без этого рестарт навсегда хоронил оплаченное.
  for (const job of jobs.all()) {
    if (
      job.status !== 'error'
      || job.cancelled
      || job.result
      || (job.deliveredAt !== undefined && !isCanvasTarget(job.target))
    ) continue
    const route = effectiveGenerationRoute(job)
    if (!job.paidResult && !(job.falEndpoint && job.falRequestId)) continue
    // Воскрешение лечит сбой сети или CDN, и нескольких запусков ему хватает с
    // запасом. Дальше это уже не сбой: так 18 задач от 07.09 при каждом запуске
    // ходили в fal со сменившимся ключом — и слышали отказ снова (17–26.09).
    if ((job.recoveryAttempts ?? 0) >= MAX_RECOVERY_ATTEMPTS) continue
    job.recoveryAttempts = (job.recoveryAttempts ?? 0) + 1
    // Старые версии ставили deliveredAt даже при error без результата.
    // Такая canvas-запись не могла ничего доставить; разрешаем её восстановить.
    job.deliveredAt = undefined
    job.status = 'queued'
    job.error = undefined
    job.progressText = undefined
    job.finishedAt = undefined
    changed = true
    enqueueJob(job)
    restored++
  }

  if (changed) await jobs.persistNow()
  return { restored, failed }
}

import { api, ApiError, isLocalServiceUnavailable, LOCAL_SERVICE_UNAVAILABLE_MESSAGE } from '../../../api'
import { trackMediaImport } from '../mediaImportRegistry'
import type { MediaImportTask, MediaLinkPreview, MediaProvider } from '../mediaImportTypes'
import type { CanvasStore } from './canvasStore'
import type { CanvasLinkData } from './types'

/**
 * Превью ссылок запрашиваются не больше чем по два разом.
 *
 * ⚠️ Каждое превью — это yt-dlp на сервере и секунды ожидания, а браузер держит
 * к приложению всего шесть соединений. Семь ссылок, вставленных разом, занимали
 * все шесть: седьмая стояла в очереди браузера, её срок ожидания уже шёл, и
 * вместе с ней ждали сохранение доски и проверка связи. Жалоба 27.09.2026 со
 * снимком: при тридцати секундах на превью семь YouTube-ссылок упёрлись в
 * предел ожидания, и все семь карточек записали «CanAI временно недоступен».
 */
export const PREVIEW_PARALLEL = 2

/**
 * Что пишет карточка, когда CanAI не ответил вовремя. Прежде тут стояло
 * «CanAI временно недоступен» — неправда: приложение работало, а медленным
 * было одно превью. И карточка на общей доске говорила это всей команде.
 */
export const PREVIEW_NO_ANSWER = 'Preview did not arrive in time'

/**
 * Ошибка превью, которая ничего не говорит о самой ссылке: CanAI просто не
 * ответил вовремя (сервер перезапускался или был занят). Такая карточка
 * запрашивает превью снова сама при следующем открытии доски.
 *
 * ⚠️ Карточки, сохранённые до 27.09.2026, признака не несут — у них в ошибке
 * дословно «CanAI временно недоступен». Узнаём их по этой строке: её пишет
 * только наш же клиент, это не текст чужого сервера, который могут переписать.
 */
export function transientLinkError(link: CanvasLinkData): boolean {
  return link.state === 'error'
    && (link.transientError === true || link.error === LOCAL_SERVICE_UNAVAILABLE_MESSAGE)
}

interface MediaLinkControllerDeps {
  preview(url: string): Promise<MediaLinkPreview>
  start(url: string, entryIds?: string[]): Promise<{ task: MediaImportTask }>
  track(projectId: string, linkId: string, task: MediaImportTask): void
}

export type MediaLinkStore = Pick<CanvasStore,
  'placeLink' | 'applyLinkPreview' | 'failLinkPreview' | 'getItem' | 'reserveMediaImport' | 'reuseDownloadedLinkItems'
>

type RecoveringMediaLinkStore = MediaLinkStore & Pick<CanvasStore, 'getItems'>

export interface MediaLinkController {
  previewPastedLink(store: MediaLinkStore, url: string, at?: { x: number; y: number }): Promise<string>
  downloadLink(store: MediaLinkStore, projectId: string, linkId: string, entryIds?: string[]): Promise<MediaImportTask | null>
  retryFailedLinkEntries(store: MediaLinkStore, projectId: string, linkId: string, entryIds: string[]): Promise<MediaImportTask | null>
  refreshLinkPreview(store: MediaLinkStore, linkId: string, url: string): Promise<void>
}

/**
 * Отказ из-за входа на площадку опознаётся по КОДУ ответа, а не по тексту:
 * текст мы переписываем, а поведение карточки от него зависеть не должно.
 */
export function isLoginRequired(error: unknown): boolean {
  const code = error instanceof ApiError ? error.code : undefined
  return code === 'MEDIA_LINK_LOGIN_REQUIRED' || code === 'MEDIA_LINK_LOGIN_STALE'
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

const LOGIN_PROVIDERS: MediaProvider[] = ['vimeo', 'youtube', 'instagram', 'tiktok']

/**
 * Площадка из отказа. Превью при отказе не приходит вовсе, и карточка осталась
 * бы с заглушкой «Ссылка»: кнопка называлась бы «Войти на Ссылка», а на сервер
 * уходил бы provider «direct», которому входа не бывает.
 */
export function loginSource(error: unknown): { provider: MediaProvider; sourceLabel: string } | undefined {
  const details = error instanceof ApiError ? error.details : undefined
  if (!details || typeof details !== 'object') return undefined
  const { provider, sourceLabel } = details as { provider?: unknown; sourceLabel?: unknown }
  if (typeof provider !== 'string' || !LOGIN_PROVIDERS.includes(provider as MediaProvider)) return undefined
  return {
    provider: provider as MediaProvider,
    sourceLabel: typeof sourceLabel === 'string' && sourceLabel ? sourceLabel : provider,
  }
}

function previewFailed(store: MediaLinkStore, linkId: string, error: unknown): void {
  if (isLocalServiceUnavailable(error)) {
    store.failLinkPreview(linkId, PREVIEW_NO_ANSWER, { transient: true })
    return
  }
  store.failLinkPreview(linkId, failureMessage(error, 'Failed to load preview'), {
    needsLogin: isLoginRequired(error),
    source: loginSource(error),
  })
}

export function createMediaLinkController(deps: MediaLinkControllerDeps): MediaLinkController {
  const starting = new Set<string>()
  let active = 0
  const waiting: Array<() => void> = []

  // Освободившееся место передаётся ждущему НАПРЯМУЮ, минуя счётчик: иначе
  // между «место освободилось» и «ждущий проснулся» его успел бы занять
  // новый запрос, и разом шло бы на одно больше, чем положено.
  async function limitedPreview(url: string): Promise<MediaLinkPreview> {
    if (active < PREVIEW_PARALLEL) active += 1
    else await new Promise<void>((resume) => waiting.push(resume))
    try {
      return await deps.preview(url)
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active -= 1
    }
  }

  async function previewPastedLink(
    store: MediaLinkStore,
    url: string,
    at?: { x: number; y: number },
  ): Promise<string> {
    const linkId = store.placeLink(url, at)
    try {
      store.applyLinkPreview(linkId, await limitedPreview(url))
    } catch (error) {
      previewFailed(store, linkId, error)
    }
    return linkId
  }

  async function downloadLink(
    store: MediaLinkStore,
    projectId: string,
    linkId: string,
    requestedIds?: string[],
  ): Promise<MediaImportTask | null> {
    const item = store.getItem(linkId)
    if (item?.kind !== 'link' || !item.link || item.link.activeImportId || starting.has(linkId)) return null
    starting.add(linkId)
    try {
      const entryIds = item.link.entries.length === 0
        ? requestedIds
        : store.reuseDownloadedLinkItems(linkId, requestedIds).missingEntryIds
      if (entryIds && entryIds.length === 0) return null
      let task: MediaImportTask
      try {
        ({ task } = await deps.start(item.link.normalizedUrl || item.link.url, entryIds))
      } catch (error) {
        // Старая карточка могла хранить общий отказ превью. Если повторное
        // скачивание уже получило точный ответ «нужен вход», обновляем её
        // прямо на сетевой доске — кнопка станет «Войти», без перезагрузки.
        if (isLoginRequired(error)) {
          store.failLinkPreview(linkId, failureMessage(error, 'Sign-in required'), {
            needsLogin: true,
            source: loginSource(error),
          })
        }
        throw error
      }
      store.reserveMediaImport(linkId, task)
      deps.track(projectId, linkId, task)
      return task
    } finally {
      starting.delete(linkId)
    }
  }

  return {
    previewPastedLink,
    downloadLink,
    retryFailedLinkEntries: (store, projectId, linkId, entryIds) => (
      downloadLink(store, projectId, linkId, entryIds)
    ),
    async refreshLinkPreview(store, linkId, url) {
      try {
        store.applyLinkPreview(linkId, await limitedPreview(url))
      } catch (error) {
        previewFailed(store, linkId, error)
      }
    },
  }
}

export const mediaLinkController = createMediaLinkController({
  preview: (url) => api.previewMediaLink(url),
  start: (url, entryIds) => api.startMediaImport(url, entryIds),
  track: trackMediaImport,
})

/**
 * При открытии доски дозапросить превью, которые так и не пришли: оставшиеся
 * в «загрузке» и упавшие только потому, что CanAI не ответил вовремя
 * (`transientLinkError`). Настоящие отказы площадки не трогаем — ответ был бы
 * тем же, а yt-dlp гонялся бы на каждом открытии.
 */
export async function refreshUnsettledLinkPreviews(
  store: RecoveringMediaLinkStore,
  controller: Pick<MediaLinkController, 'refreshLinkPreview'> = mediaLinkController,
): Promise<void> {
  const unsettled = store.getItems().filter((item) => (
    item.kind === 'link' && item.link
    && (item.link.state === 'loading-preview' || transientLinkError(item.link))
  ))
  await Promise.all(unsettled.map((item) => (
    controller.refreshLinkPreview(store, item.id, item.link!.url)
  )))
}

type RetryHandler = (sourceLinkId: string, entryIds: string[]) => void
let retryHandler: RetryHandler | null = null

export function registerMediaLinkRetryHandler(handler: RetryHandler): () => void {
  retryHandler = handler
  return () => {
    if (retryHandler === handler) retryHandler = null
  }
}

export function retryFailedLinkEntries(sourceLinkId: string, entryIds: string[]): void {
  retryHandler?.(sourceLinkId, entryIds)
}

import { useEffect, useRef, useState } from 'react'

// LRU вместо безразмерных Map: раньше каждый когда-либо показанный медиа-элемент
// оставался в кэше НАВСЕГДА (кэш модульный, переживает смену досок) — за долгую
// сессию студии память росла до вылета вкладки. Вытеснение просто отпускает
// ссылку: браузерный GC заберёт элемент, когда его отпустит и компонент.
class LruCache<V> {
  private map = new Map<string, V>()
  constructor(private max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      // Map хранит порядок вставки — переставляем в конец как «свежий»
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  set(key: string, v: V): void {
    this.map.delete(key)
    this.map.set(key, v)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
}

const imageCache = new LruCache<HTMLImageElement>(300)

/**
 * Keep a small pool of decoded, paused video elements between culling mounts.
 * The pool is deliberately per source and only accepts videos that already
 * reached `HAVE_CURRENT_DATA`: an unfinished request is aborted on culling,
 * so panning over a row of clips cannot leave hidden downloads running.
 */
export const VIDEO_ELEMENT_POOL_LIMIT = 8
const pooledVideos = new Map<string, HTMLVideoElement>()

function discardVideoElement(video: HTMLVideoElement): void {
  video.pause()
  video.removeAttribute('src')
  video.load()
}

function takePooledVideo(src: string): HTMLVideoElement | undefined {
  const video = pooledVideos.get(src)
  if (!video) return undefined
  pooledVideos.delete(src)
  if (video.error || video.readyState < 2 || video.getAttribute('src') !== src) {
    discardVideoElement(video)
    return undefined
  }
  return video
}

function releaseVideo(src: string, video: HTMLVideoElement): void {
  // Playback ownership is scoped to the mounted item. `playback.release()`
  // only drops that registry entry, so the pool itself must stop the decoder
  // before retaining it off-screen.
  video.pause()
  // Do not retain a slow/failed request: only a decoder with a usable frame is
  // worth reattaching after the next camera move.
  if (video.error || video.readyState < 2) {
    discardVideoElement(video)
    return
  }
  const previous = pooledVideos.get(src)
  if (previous && previous !== video) discardVideoElement(previous)
  pooledVideos.delete(src)
  pooledVideos.set(src, video)
  while (pooledVideos.size > VIDEO_ELEMENT_POOL_LIMIT) {
    const oldest = pooledVideos.keys().next().value
    if (oldest === undefined) break
    const evicted = pooledVideos.get(oldest)
    pooledVideos.delete(oldest)
    if (evicted) discardVideoElement(evicted)
  }
}

/**
 * Cloud previews are served by the same origin as the board API.  Starting an
 * Image for every visible card at once can therefore consume the browser's
 * per-origin connections and leave status/catalog/WebSocket traffic waiting.
 * Keep this budget separate from local /media loads: local boards retain their
 * existing eager behavior and never wait behind a cloud board.
 */
export const CLOUD_IMAGE_LOAD_LIMIT = 4

type ImageLoadStart = (
  complete: () => void,
  registerCancel: (cancel: () => void) => void,
) => void

type ImageLoadTask = {
  start: ImageLoadStart
  started: boolean
  cancelled: boolean
  done: boolean
  complete?: () => void
  cancel?: () => void
  /** Меньше — раньше. Считается в момент выбора: камера за это время могла уехать. */
  priority?: () => number
}

/**
 * Очередь загрузок картинок сетевой доски: не больше `maxConcurrent` разом,
 * а следующей берётся та, что ближе к центру кадра (пункт 3.5, Ф-5).
 *
 * ⚠️ Раньше очередь шла в порядке появления объектов на доске: человек
 * смотрел в центр, а загружались края и то, что вообще за кадром. Задача без
 * приоритета (не холст) идёт первой — её ждут в интерфейсе.
 */
export class BoundedImageLoadScheduler {
  private readonly queue: ImageLoadTask[] = []
  private active = 0

  constructor(readonly maxConcurrent: number = CLOUD_IMAGE_LOAD_LIMIT) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer')
    }
  }

  get activeCount(): number {
    return this.active
  }

  get queuedCount(): number {
    return this.queue.length
  }

  schedule(start: ImageLoadStart, priority?: () => number): () => void {
    const task: ImageLoadTask = {
      start,
      started: false,
      cancelled: false,
      done: false,
      ...(priority ? { priority } : {}),
    }
    this.queue.push(task)
    this.pump()

    return () => {
      if (task.done) return
      task.cancelled = true
      if (!task.started) {
        task.done = true
        const index = this.queue.indexOf(task)
        if (index >= 0) this.queue.splice(index, 1)
        return
      }
      // Abort an active Image before releasing its slot. Its callbacks are
      // detached by the caller, so a late browser error cannot start a retry.
      task.cancel?.()
      task.complete?.()
    }
  }

  private takeNext(): ImageLoadTask {
    let bestIndex = 0
    let best = Number.POSITIVE_INFINITY
    for (let index = 0; index < this.queue.length; index += 1) {
      const task = this.queue[index]!
      let value = 0
      try {
        value = task.priority ? task.priority() : Number.NEGATIVE_INFINITY
      } catch {
        value = Number.POSITIVE_INFINITY
      }
      if (!Number.isNaN(value) && value < best) {
        best = value
        bestIndex = index
      }
    }
    return this.queue.splice(bestIndex, 1)[0]!
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const task = this.takeNext()
      if (task.done || task.cancelled) continue
      task.started = true
      this.active += 1
      let completed = false
      const complete = () => {
        if (completed) return
        completed = true
        task.done = true
        this.active = Math.max(0, this.active - 1)
        task.cancel = undefined
        task.complete = undefined
        this.pump()
      }
      task.complete = complete
      if (task.cancelled) {
        complete()
        continue
      }
      try {
        task.start(complete, (cancel) => {
          task.cancel = cancel
        })
      } catch {
        // A synchronous Image constructor failure must not clog the queue.
        complete()
      }
    }
  }
}

const cloudImageScheduler = new BoundedImageLoadScheduler()

/** Точка на доске, от которой считается «ближе к центру» (центр кадра). */
let loadFocus: (() => { x: number; y: number } | null) | null = null

/** Холст сообщает, где центр его кадра; `null` — холста нет. */
export function setImageLoadFocus(focus: (() => { x: number; y: number } | null) | null): void {
  loadFocus = focus
}

function focusDistance(point: () => { x: number; y: number } | undefined): number {
  const target = point()
  const focus = loadFocus?.()
  if (!target || !focus) return 0
  const dx = target.x - focus.x
  const dy = target.y - focus.y
  return dx * dx + dy * dy
}

function isCloudImageUrl(url: string): boolean {
  // API responses normally use relative URLs. Keep absolute same-origin URLs
  // covered as well for hosted/cloud-tablet deployments.
  return /^(?:https?:\/\/[^/]+)?\/api\/cloud-assets\//u.test(url)
}

function scheduleImageLoad(
  start: ImageLoadStart,
  url: string,
  point?: () => { x: number; y: number } | undefined,
): () => void {
  if (isCloudImageUrl(url)) {
    return cloudImageScheduler.schedule(start, point ? () => focusDistance(point) : undefined)
  }

  // Local /media (and user-provided URLs) intentionally remain eager. They are
  // not allowed to consume the cloud scheduler's slots or queue behind it.
  let done = false
  let cancel: (() => void) | undefined
  const complete = () => {
    if (done) return
    done = true
    cancel = undefined
  }
  try {
    start(complete, (value) => { cancel = value })
  } catch {
    complete()
  }
  return () => {
    if (done) return
    cancel?.()
    complete()
  }
}

/** После краткого обрыва свои медиа должны появиться без обновления доски. */
export function loadImageWithRetry(
  src: string,
  fallbackSrc: string | undefined,
  onLoad: (image: HTMLImageElement, url: string) => void,
  onFailure: () => void,
  /** Где объект на доске — для очереди «от центра кадра». */
  point?: () => { x: number; y: number } | undefined,
): () => void {
  let alive = true
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelAttempt: (() => void) | undefined
  const retryable = /^\/(?:api\/cloud-assets\/|media\/)/u.test(src)

  // A completed image is delivered synchronously from the LRU. This keeps
  // resolution-step changes from flashing a placeholder and avoids opening a
  // second request when another mounted item already loaded the same preview.
  const cached = imageCache.get(src)
  if (cached) {
    onLoad(cached, src)
    return () => { alive = false }
  }

  const load = (url: string, fallback?: string): void => {
    if (!alive) return
    cancelAttempt = scheduleImageLoad((complete, registerCancel) => {
      if (!alive) {
        complete()
        return
      }
      const image = new Image()
      image.crossOrigin = 'anonymous'
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        complete()
      }
      registerCancel(() => {
        image.onload = null
        image.onerror = null
        // Removing src aborts an in-flight browser request without issuing a
        // second request. Fake Images in tests need not implement the method.
        image.removeAttribute?.('src')
        finish()
      })
      image.onload = () => {
        finish()
        imageCache.set(url, image)
        if (alive) onLoad(image, url)
      }
      image.onerror = () => {
        finish()
        if (!alive) return
        if (fallback && fallback !== url) {
          load(fallback)
          return
        }
        onFailure()
        if (!retryable) return
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(failures++, 4))
        timer = setTimeout(() => {
          timer = undefined
          if (alive) load(src, fallbackSrc)
        }, delay)
      }
      image.src = url
    }, url, point)
  }

  load(src, fallbackSrc)
  return () => {
    alive = false
    if (timer !== undefined) clearTimeout(timer)
    cancelAttempt?.()
    cancelAttempt = undefined
  }
}

/**
 * Загружена ли эта картинка именно с этого адреса.
 *
 * ⚠️ `useImageEl` держит прежнюю картинку, пока грузится новая, поэтому
 * «просим оригинал» ещё не значит «показан оригинал». Фигура записывала в
 * объект натуральный размер, как только адрес сменился на оригинал, — то есть
 * размер уменьшенной копии, а следом, когда оригинал догружался, настоящий.
 * На сетевой доске это две правки на каждую картинку при каждом приближении
 * (журнал доски 01.10.2026: 1920×1085, тут же 3824×2160 — десятки раз), а на
 * размере держатся обрезка и экспорт.
 */
export function isImageLoadedFrom(image: HTMLImageElement | undefined, src: string | undefined): boolean {
  return Boolean(image && src && imageCache.get(src) === image)
}

/**
 * Загрузка HTMLImageElement для Konva.Image с общим кэшем.
 *
 * ⚠️ Прежняя картинка держится на экране, пока грузится новая. Адрес меняется
 * не только при подмене файла: у сетевой доски он несёт ступень экранного
 * превью (см. screenPreview), и на каждом шаге зума картинка иначе пропадала
 * бы в пустоту на время загрузки.
 */
export function useImageEl(
  src: string | undefined,
  /**
   * Запасной адрес, если основной не загрузился.
   *
   * ⚠️ Нужен ровно для превью: сервер мог ещё не уметь их отдавать (правки
   * доезжают только с перезапуском приложения), файл мог оказаться не
   * картинкой, пережим — не удаться. Дыра на месте картинки в таких случаях
   * хуже медленной загрузки, поэтому падаем на оригинал.
   */
  fallbackSrc?: string,
  /**
   * Центр объекта на доске: сетевая доска грузит картинки от центра кадра.
   * Держится в ref — новый объект-точка на каждой отрисовке не перезапускает
   * загрузку.
   */
  point?: { x: number; y: number },
): HTMLImageElement | undefined {
  const pointRef = useRef(point)
  pointRef.current = point
  const [img, setImg] = useState<HTMLImageElement | undefined>(() => {
    if (src && imageCache.has(src)) return imageCache.get(src)
    return undefined
  })

  useEffect(() => {
    if (!src) {
      setImg(undefined)
      return
    }
    if (imageCache.has(src)) {
      setImg(imageCache.get(src))
      return
    }

    return loadImageWithRetry(src, fallbackSrc, (el, url) => {
      imageCache.set(url, el)
      setImg(el)
    }, () => setImg(undefined), () => pointRef.current)
    // Намеренно НЕ сбрасываем текущее изображение перед загрузкой нового:
    // пустой кадр на месте картинки хуже, чем прежняя ступень превью.
  }, [src, fallbackSrc])

  return img
}

// HTMLVideoElement принадлежит конкретному item. Общий element по URL связывал
// play/pause и звук всех дубликатов, а скрытое culling-видео продолжало играть.
// После culling готовый paused decoder можно вернуть тому же item из небольшого
// пула; одновременно смонтированные дубликаты по-прежнему получают свои узлы.
export function useVideoEl(src: string | undefined): HTMLVideoElement | undefined {
  const [video, setVideo] = useState<HTMLVideoElement | undefined>()

  useEffect(() => {
    setVideo(undefined)
    if (!src) {
      return
    }
    const el = takePooledVideo(src) ?? document.createElement('video')
    el.crossOrigin = 'anonymous'
    el.muted = false
    el.playsInline = true
    // ⚠️ ТОЛЬКО metadata, не auto. С auto каждый ролик на холсте качает файл
    // сколько хочет и, упёршись в свой буфер, ДЕРЖИТ соединение открытым. А к
    // одному адресу браузер держит не больше шести соединений: семь крупных
    // роликов в кадре занимают все, и запись доски, проверка связи, загрузки
    // файлов и картинки встают в очередь навсегда. Со стороны — «Сохранение…»
    // висит, загрузка «0 КБ из 16 МБ», «ничего не грузит и не делает», а
    // несохранённые правки потом уезжают в конфликтную копию (жалоба
    // тестировщика 21.09.2026 со снимком). Замер в Chrome на 20 роликах по
    // 49 МБ: с auto 9 запросов висят и /api/status не отвечает 20 секунд, с
    // metadata висящих 0, ответ за 3 мс, кадры у всех двадцати на месте.
    // Для игры это ничего не меняет: play() догружает сам.
    el.preload = 'metadata'
    if (el.getAttribute('src') !== src) el.src = src
    let alive = true
    const pooled = el.readyState >= 2
    const onData = () => {
      if (!alive) return
      // сдвигаемся к первому осмысленному кадру (не чёрному)
      try {
        el.currentTime = Math.min(0.1, (el.duration || 1) / 2)
      } catch {
        /* noop */
      }
      setVideo(el)
    }
    if (pooled) setVideo(el)
    else el.addEventListener('loadeddata', onData)
    return () => {
      alive = false
      if (!pooled) el.removeEventListener('loadeddata', onData)
      if (el.error || el.readyState < 2) {
        // Keep this inline as the hard guarantee for an unfinished request:
        // culling must release its connection immediately instead of putting
        // a still-loading decoder into the pool.
        el.pause()
        el.removeAttribute('src')
        el.load()
        return
      }
      releaseVideo(src, el)
    }
  }, [src])

  return video
}

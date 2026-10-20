import { filmstripCaptureOrder, filmstripCellSize, filmstripCoverRect } from './filmstripMath'

// Съёмка фильмштриха: единственное место, где нужен браузер (отдельный <video>
// и canvas). Арифметика — filmstripMath.ts, привязка к React — useFilmstrip.ts.

const LOAD_TIMEOUT_MS = 20_000
/** Срок на одну ячейку: не успела — остаётся пустой, плёнка не падает. */
const CELL_TIMEOUT_MS = 4_000
const JPEG_QUALITY = 0.72

type SeekResult = 'ready' | 'late' | 'stopped'

/** Дождаться метаданных. Остановка — тихий выход, ошибка и таймаут — отказ. */
function metadataReady(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted || video.readyState >= 1) {
      resolve()
      return
    }
    const finish = (error?: Error) => {
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onLoaded = () => finish()
    const onAbort = () => finish()
    const onError = () => finish(new Error('Failed to read clip'))
    const timer = setTimeout(() => finish(new Error('Video did not load in time')), LOAD_TIMEOUT_MS)
    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('error', onError)
    signal.addEventListener('abort', onAbort)
  })
}

/** Перемотать и дождаться кадра. 'late' — не успел за срок ячейки. */
function seekTo(video: HTMLVideoElement, time: number, signal: AbortSignal): Promise<SeekResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve('stopped')
      return
    }
    if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= 2 && !video.seeking) {
      resolve('ready')
      return
    }
    const finish = (result: SeekResult | Error) => {
      clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const onSeeked = () => finish('ready')
    const onAbort = () => finish('stopped')
    const onError = () => finish(new Error('Failed to read clip frame'))
    const timer = setTimeout(() => finish('late'), CELL_TIMEOUT_MS)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    signal.addEventListener('abort', onAbort)
    video.currentTime = time
  })
}

export interface FilmstripJob {
  stop(): void
}

export interface FilmstripJobParams {
  src: string
  times: readonly number[]
  aspect: number
  onCell(index: number, url: string): void
  onFailed(): void
}

/**
 * Запустить сборку: отдельный <video>, ячейки по одной в порядке
 * `filmstripCaptureOrder`. `stop()` обрывает всё сразу — и ожидание метаданных,
 * и текущую перемотку, — а видео освобождается (иначе оно держало бы
 * соединение с сервером до сборки мусора).
 */
export function startFilmstripJob(params: FilmstripJobParams): FilmstripJob {
  const stopper = new AbortController()
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.crossOrigin = 'anonymous'
  // Как у роликов на холсте (см. useVideoEl): весь файл тут не нужен, перемотка
  // сама дозапросит ровно тот кусок, который покажет кадр.
  video.preload = 'metadata'
  video.src = params.src
  video.load()

  let released = false
  const release = () => {
    if (released) return
    released = true
    video.pause()
    video.removeAttribute('src')
    video.load()
  }

  const run = async () => {
    await metadataReady(video, stopper.signal)
    if (stopper.signal.aborted) return
    const { width, height } = filmstripCellSize(params.aspect)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No 2D context')

    for (const index of filmstripCaptureOrder(params.times.length)) {
      // Флаг проверяется перед КАЖДОЙ перемоткой: остановленная сборка не
      // должна сделать ни одной лишней.
      if (stopper.signal.aborted) return
      const result = await seekTo(video, params.times[index], stopper.signal)
      if (result !== 'ready' || stopper.signal.aborted) continue
      const rect = filmstripCoverRect(video.videoWidth, video.videoHeight, width, height)
      if (!rect) continue
      ctx.drawImage(video, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height)
      params.onCell(index, canvas.toDataURL('image/jpeg', JPEG_QUALITY))
    }
  }

  void run()
    .catch(() => { if (!stopper.signal.aborted) params.onFailed() })
    .finally(release)

  return {
    stop() {
      stopper.abort()
      release()
    },
  }
}

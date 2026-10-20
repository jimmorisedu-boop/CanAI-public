import { useEffect, useRef, useState } from 'react'

/**
 * Кадр ролика на паузе — готовой картинкой.
 *
 * ⚠️ Холст перерисовывается на каждом кадре движения камеры, и ролик, даже
 * стоящий на паузе, рисовался прямо из <video>: браузер каждый раз заново
 * достаёт из него кадр. В Firefox это заметно (замер 25.09.2026 на доске
 * пользователя, два ролика 1920×1080 среди сотни картинок): прокрутка
 * 50 кадров в секунду против 60 без них. Снимок кадра рисуется как обычная
 * картинка, а из самого <video> холст рисует, только пока ролик играет.
 */

/** Длинная сторона снимка: чётко при приближении, но без текстуры на 8 МБ. */
export const STILL_MAX_EDGE = 1280

/**
 * Posters outlive a culled VideoItem, but they must not become another
 * unbounded media cache. A poster is a paused canvas, not a decoder: keeping
 * these small snapshots lets a card return immediately without keeping a
 * hidden video element or its network request alive. The cache keeps a
 * thumbnail-sized copy; the currently mounted card still keeps its full-size
 * canvas locally for crisp zoomed viewing.
 */
export const VIDEO_STILL_CACHE_LIMIT = 128
export const VIDEO_STILL_CACHE_MAX_EDGE = 512
export const VIDEO_STILL_CACHE_MAX_BYTES = 96 * 1024 * 1024

type CachedStill = {
  canvas: HTMLCanvasElement
  bytes: number
  dataUrl?: string
}

const stillCache = new Map<string, CachedStill>()
let stillCacheBytes = 0

function touchStill(src: string, value: CachedStill): void {
  stillCache.delete(src)
  stillCache.set(src, value)
}

function deleteStill(src: string): void {
  const value = stillCache.get(src)
  if (!value) return
  stillCache.delete(src)
  stillCacheBytes = Math.max(0, stillCacheBytes - value.bytes)
}

function thumbnailForCache(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const size = stillFrameSize(canvas.width, canvas.height, VIDEO_STILL_CACHE_MAX_EDGE)
  if (!size || (size.w === canvas.width && size.h === canvas.height) || typeof document === 'undefined') return canvas
  try {
    const thumbnail = document.createElement('canvas')
    thumbnail.width = size.w
    thumbnail.height = size.h
    const context = thumbnail.getContext('2d')
    if (!context) return canvas
    context.drawImage(canvas, 0, 0, size.w, size.h)
    return thumbnail
  } catch {
    return canvas
  }
}

/** Return a paused poster from a previous mount, if one is available. */
export function getCachedVideoStill(src: string | undefined): HTMLCanvasElement | null {
  if (!src) return null
  const cached = stillCache.get(src)
  if (!cached) return null
  touchStill(src, cached)
  return cached.canvas
}

/** Store one poster and evict the least recently used snapshots. */
export function cacheVideoStill(src: string | undefined, canvas: HTMLCanvasElement): void {
  if (!src || canvas.width <= 0 || canvas.height <= 0) return
  const cachedCanvas = thumbnailForCache(canvas)
  const next: CachedStill = {
    canvas: cachedCanvas,
    bytes: Math.max(1, cachedCanvas.width * cachedCanvas.height * 4),
  }
  const previous = stillCache.get(src)
  if (previous) stillCacheBytes = Math.max(0, stillCacheBytes - previous.bytes)
  stillCacheBytes += next.bytes
  touchStill(src, next)
  while (stillCache.size > VIDEO_STILL_CACHE_LIMIT || stillCacheBytes > VIDEO_STILL_CACHE_MAX_BYTES) {
    const oldest = stillCache.keys().next().value
    if (oldest === undefined) break
    deleteStill(oldest)
  }
}

/**
 * A DOM video can use a cached poster directly. Convert lazily so ordinary
 * Konva cards never pay the data-URL cost; tablet remounts call this only when
 * they need a DOM `poster` attribute.
 */
export function cachedVideoStillDataUrl(src: string | undefined): string | undefined {
  if (!src) return undefined
  const cached = stillCache.get(src)
  if (!cached) return undefined
  touchStill(src, cached)
  if (cached.dataUrl) return cached.dataUrl
  try {
    const dataUrl = cached.canvas.toDataURL('image/jpeg', 0.82)
    if (dataUrl) cached.dataUrl = dataUrl
    return dataUrl || undefined
  } catch {
    return undefined
  }
}

export function stillFrameSize(
  videoWidth: number,
  videoHeight: number,
  maxEdge = STILL_MAX_EDGE,
): { w: number; h: number } | null {
  if (!(videoWidth > 0) || !(videoHeight > 0)) return null
  const k = Math.min(1, maxEdge / Math.max(videoWidth, videoHeight))
  return { w: Math.max(1, Math.round(videoWidth * k)), h: Math.max(1, Math.round(videoHeight * k)) }
}

/** HAVE_CURRENT_DATA: раньше кадра у ролика нет, и снимок вышел бы чёрным. */
const HAVE_CURRENT_DATA = 2

/** Снять текущий кадр в холст-снимок. false — кадра ещё нет или браузер отказал. */
export function captureStillFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): boolean {
  if (video.readyState < HAVE_CURRENT_DATA) return false
  const size = stillFrameSize(video.videoWidth, video.videoHeight)
  if (!size) return false
  if (canvas.width !== size.w) canvas.width = size.w
  if (canvas.height !== size.h) canvas.height = size.h
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  try {
    ctx.drawImage(video, 0, 0, size.w, size.h)
    return true
  } catch {
    return false
  }
}

/** Capture and remember a first/paused frame for a later culling remount. */
export function rememberVideoStill(src: string | undefined, video: HTMLVideoElement): HTMLCanvasElement | null {
  if (!src) return null
  const canvas = document.createElement('canvas')
  if (!captureStillFrame(video, canvas)) return null
  cacheVideoStill(src, canvas)
  return canvas
}

/**
 * Снимок кадра, пока ролик стоит; null — рисовать сам ролик.
 *
 * ⚠️ С началом игры снимок считается устаревшим: после паузы до нового снимка
 * рисуем живой ролик, а не прежний кадр — иначе на миг мелькнул бы кадр, с
 * которого ролик начинали.
 */
export function usePausedVideoStill(
  video: HTMLVideoElement | undefined,
  playing: boolean,
  redraw: () => void,
  src?: string,
): HTMLCanvasElement | null {
  const [still, setStill] = useState<HTMLCanvasElement | null>(() => getCachedVideoStill(src))
  const redrawRef = useRef(redraw)
  redrawRef.current = redraw

  useEffect(() => {
    setStill(getCachedVideoStill(src))
    if (!video) return
    const canvas = document.createElement('canvas')
    let alive = true
    const take = () => {
      if (!alive || !video.paused) return
      if (!captureStillFrame(video, canvas)) return
      cacheVideoStill(src, canvas)
      setStill(canvas)
      redrawRef.current()
    }
    take()
    const events = ['loadeddata', 'seeked', 'pause'] as const
    for (const name of events) video.addEventListener(name, take)
    return () => {
      alive = false
      for (const name of events) video.removeEventListener(name, take)
    }
  }, [video, src])

  useEffect(() => {
    if (playing) setStill(null)
  }, [playing])

  return playing ? null : still
}

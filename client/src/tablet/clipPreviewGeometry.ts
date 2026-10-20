import type { TimelineFacts } from '../spaces/canvas/timeline/useTimelineSession'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { clampMove, resizeFromCorner, type Rect } from '../spaces/canvas/konva/cropMath'

export const DEFAULT_CLIP_ASPECT_RATIO = 16 / 9
export const CLIP_PREVIEW_SAFE_MARGIN = 20

export interface ClipSize {
  width: number
  height: number
}

export interface ClipPreviewBox extends ClipSize {
  x: number
  y: number
  scale: number
}

export interface NormalizedPoint {
  x: number
  y: number
}

export type CropCorner = 'nw' | 'ne' | 'sw' | 'se'
export type CropGestureMode = 'move' | CropCorner

export interface CropGesture {
  pointerId: number
  mode: CropGestureMode
  from: NormalizedPoint
  start: Rect
}

export interface ClientRectLike {
  left: number
  top: number
  width: number
  height: number
}

interface VideoDimensionSource {
  videoWidth?: number
  videoHeight?: number
  width?: number
  height?: number
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Resolve the source aspect from durable probe facts first, then browser
 * metadata, then dimensions kept on older canvas items. Until any source is
 * known, use a predictable landscape frame so the preview has a stable box.
 */
export function clipSourceSize(
  facts: Pick<TimelineFacts, 'width' | 'height'> | null | undefined,
  video: VideoDimensionSource | null | undefined,
  item: Pick<CanvasItem, 'naturalWidth' | 'naturalHeight' | 'w' | 'h'>,
): ClipSize {
  if (positive(facts?.width) && positive(facts?.height)) return { width: facts.width, height: facts.height }
  const videoWidth = positive(video?.videoWidth) ? video.videoWidth : video?.width
  const videoHeight = positive(video?.videoHeight) ? video.videoHeight : video?.height
  if (positive(videoWidth) && positive(videoHeight)) {
    return { width: videoWidth, height: videoHeight }
  }
  if (positive(item.naturalWidth) && positive(item.naturalHeight)) {
    return { width: item.naturalWidth, height: item.naturalHeight }
  }
  if (positive(item.w) && positive(item.h)) return { width: item.w, height: item.h }
  return { width: DEFAULT_CLIP_ASPECT_RATIO, height: 1 }
}

/** Fit the source into the measured available area, leaving handle margin. */
export function fitClipPreview(
  source: ClipSize,
  available: ClipSize,
  safeMargin = CLIP_PREVIEW_SAFE_MARGIN,
): ClipPreviewBox {
  const margin = Number.isFinite(safeMargin) ? Math.max(0, safeMargin) : CLIP_PREVIEW_SAFE_MARGIN
  if (!positive(available.width) || !positive(available.height)) return { x: 0, y: 0, width: 0, height: 0, scale: 0 }
  const frameWidth = Math.max(0, available.width)
  const frameHeight = Math.max(0, available.height)
  if (!positive(source.width) || !positive(source.height) || frameWidth <= 0 || frameHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 }
  }
  const availableWidth = Math.max(0, frameWidth - margin * 2)
  const availableHeight = Math.max(0, frameHeight - margin * 2)
  if (availableWidth <= 0 || availableHeight <= 0) return { x: 0, y: 0, width: 0, height: 0, scale: 0 }
  const scale = Math.min(availableWidth / source.width, availableHeight / source.height)
  const width = source.width * scale
  const height = source.height * scale
  return {
    x: (frameWidth - width) / 2,
    y: (frameHeight - height) / 2,
    width,
    height,
    scale,
  }
}

/** Convert client coordinates against the actual fitted video rectangle. */
export function normalizedPoint(clientX: number, clientY: number, rect: ClientRectLike): NormalizedPoint {
  if (!(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0 }
  return {
    x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
  }
}

export function normalizedDelta(from: NormalizedPoint, to: NormalizedPoint): NormalizedPoint {
  return { x: to.x - from.x, y: to.y - from.y }
}

function cornerPoint(rect: Rect, corner: CropCorner): NormalizedPoint {
  return {
    x: corner === 'ne' || corner === 'se' ? rect.x + rect.w : rect.x,
    y: corner === 'sw' || corner === 'se' ? rect.y + rect.h : rect.y,
  }
}

/** Pure pointer gesture kernel shared by the React overlay and regression tests. */
export function applyCropGesture(
  gesture: CropGesture,
  pointerId: number,
  point: NormalizedPoint,
  source: ClipSize,
  ratio: number | null,
  locked = false,
): Rect | null {
  if (locked || gesture.pointerId !== pointerId || !positive(source.width) || !positive(source.height)) return null
  if (gesture.mode === 'move') {
    return clampMove({
      ...gesture.start,
      x: gesture.start.x + point.x - gesture.from.x,
      y: gesture.start.y + point.y - gesture.from.y,
    }, { w: 1, h: 1 })
  }
  const pixels: Rect = {
    x: gesture.start.x * source.width,
    y: gesture.start.y * source.height,
    w: gesture.start.w * source.width,
    h: gesture.start.h * source.height,
  }
  const grabbed = cornerPoint(gesture.start, gesture.mode)
  const pointer = {
    x: (point.x + grabbed.x - gesture.from.x) * source.width,
    y: (point.y + grabbed.y - gesture.from.y) * source.height,
  }
  const safeRatio = ratio && Number.isFinite(ratio) && ratio > 0 ? ratio : null
  const next = resizeFromCorner(
    pixels,
    gesture.mode,
    pointer,
    { w: source.width, h: source.height },
    safeRatio,
  )
  return {
    x: next.x / source.width,
    y: next.y / source.height,
    w: next.w / source.width,
    h: next.h / source.height,
  }
}

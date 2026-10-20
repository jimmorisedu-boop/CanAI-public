import { MIN_SCALE } from './cameraOps'
import type { CanvasCamera } from './types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface SeriesEntry {
  id: string
  bounds: Rect
}

export type CueDirection = 'left' | 'right' | 'up' | 'down' | 'mixed'

export interface SeriesAssessment {
  bounds: Rect
  meaningfulVisibleIds: string[]
  hiddenIds: string[]
  direction: CueDirection
}

export interface SeriesCuePlacement {
  launchId: string
  direction: CueDirection
  hiddenCount: number
  totalCount: number
  x: number
  y: number
}

const MEANINGFUL_FRACTION = 0.25
const EDGE_INSET = 16
const CUE_HEIGHT = 44
const CUE_GAP = 8
const MIN_CUE_WIDTH = 116

function isFiniteRect(rect: Rect): boolean {
  return [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)
    && rect.w > 0
    && rect.h > 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y
}

export function visibleFraction(bounds: Rect, camera: CanvasCamera, viewport: Rect): number {
  if (!isFiniteRect(bounds)
    || !isFiniteRect(viewport)
    || ![camera.x, camera.y, camera.scale].every(Number.isFinite)
    || camera.scale <= 0) {
    return 0
  }

  const screen = {
    x: bounds.x * camera.scale + camera.x,
    y: bounds.y * camera.scale + camera.y,
    w: bounds.w * camera.scale,
    h: bounds.h * camera.scale,
  }
  const w = Math.max(0, Math.min(screen.x + screen.w, viewport.x + viewport.w) - Math.max(screen.x, viewport.x))
  const h = Math.max(0, Math.min(screen.y + screen.h, viewport.y + viewport.h) - Math.max(screen.y, viewport.y))
  return (w * h) / (screen.w * screen.h)
}

function dominantSide(bounds: Rect, camera: CanvasCamera, viewport: Rect): CueDirection {
  const centerX = (bounds.x + bounds.w / 2) * camera.scale + camera.x
  const centerY = (bounds.y + bounds.h / 2) * camera.scale + camera.y
  const viewportCenterX = viewport.x + viewport.w / 2
  const viewportCenterY = viewport.y + viewport.h / 2
  const dx = centerX - viewportCenterX
  const dy = centerY - viewportCenterY

  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'up' : 'down'
}

export function assessSeries(
  entries: SeriesEntry[],
  camera: CanvasCamera,
  viewport: Rect,
): SeriesAssessment | null {
  if (!Array.isArray(entries)
    || !isFiniteRect(viewport)
    || ![camera.x, camera.y, camera.scale].every(Number.isFinite)
    || camera.scale <= 0) {
    return null
  }

  const validEntries = entries.filter((entry) => typeof entry.id === 'string' && isFiniteRect(entry.bounds))
  if (validEntries.length === 0) return null

  const minX = Math.min(...validEntries.map((entry) => entry.bounds.x))
  const minY = Math.min(...validEntries.map((entry) => entry.bounds.y))
  const maxX = Math.max(...validEntries.map((entry) => entry.bounds.x + entry.bounds.w))
  const maxY = Math.max(...validEntries.map((entry) => entry.bounds.y + entry.bounds.h))
  const meaningfulVisibleIds: string[] = []
  const hidden = validEntries.filter((entry) => {
    const visible = visibleFraction(entry.bounds, camera, viewport)
    if (visible >= MEANINGFUL_FRACTION) {
      meaningfulVisibleIds.push(entry.id)
      return false
    }
    return true
  })

  const directions = new Set(hidden.map((entry) => dominantSide(entry.bounds, camera, viewport)))
  return {
    bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    meaningfulVisibleIds,
    hiddenIds: hidden.map((entry) => entry.id),
    direction: directions.size === 1 ? [...directions][0]! : 'mixed',
  }
}

export function fitSeriesCamera(
  current: CanvasCamera,
  bounds: Rect,
  viewport: Rect,
  padding = 48,
): CanvasCamera | null {
  if (!isFiniteRect(bounds)
    || !isFiniteRect(viewport)
    || ![current.x, current.y, current.scale, padding].every(Number.isFinite)
    || current.scale < MIN_SCALE) {
    return null
  }

  const safePadding = Math.max(0, padding)
  const availableW = Math.max(1, viewport.w - safePadding * 2)
  const availableH = Math.max(1, viewport.h - safePadding * 2)
  const scale = Math.max(MIN_SCALE, Math.min(current.scale, availableW / bounds.w, availableH / bounds.h))
  return {
    scale,
    x: viewport.x + viewport.w / 2 - (bounds.x + bounds.w / 2) * scale,
    y: viewport.y + viewport.h / 2 - (bounds.y + bounds.h / 2) * scale,
  }
}

function cueWidth(cue: Omit<SeriesCuePlacement, 'x' | 'y'>): number {
  const label = `${cue.hiddenCount}of ${cue.totalCount}`
  return Math.max(MIN_CUE_WIDTH, label.length * 8 + 32)
}

function initialCueRect(
  cue: Omit<SeriesCuePlacement, 'x' | 'y'>,
  viewport: Rect,
): Rect {
  const w = cueWidth(cue)
  const minX = viewport.x + EDGE_INSET
  const maxX = viewport.x + viewport.w - EDGE_INSET - w
  const minY = viewport.y + EDGE_INSET
  const maxY = viewport.y + viewport.h - EDGE_INSET - CUE_HEIGHT
  const centeredX = viewport.x + (viewport.w - w) / 2
  const centeredY = viewport.y + (viewport.h - CUE_HEIGHT) / 2

  switch (cue.direction) {
    case 'left':
      return { x: minX, y: clamp(centeredY, minY, maxY), w, h: CUE_HEIGHT }
    case 'right':
      return { x: clamp(maxX, minX, maxX), y: clamp(centeredY, minY, maxY), w, h: CUE_HEIGHT }
    case 'up':
      return { x: clamp(centeredX, minX, maxX), y: minY, w, h: CUE_HEIGHT }
    case 'down':
      return { x: clamp(centeredX, minX, maxX), y: clamp(maxY, minY, maxY), w, h: CUE_HEIGHT }
    case 'mixed':
      return { x: clamp(maxX, minX, maxX), y: clamp(maxY, minY, maxY), w, h: CUE_HEIGHT }
  }
}

function moveAlongSecondaryAxis(rect: Rect, direction: CueDirection): Rect {
  if (direction === 'up' || direction === 'down') return { ...rect, x: rect.x + rect.w + CUE_GAP }
  return { ...rect, y: rect.y + CUE_HEIGHT + CUE_GAP }
}

function moveAgainstSecondaryAxis(rect: Rect, direction: CueDirection): Rect {
  if (direction === 'up' || direction === 'down') return { ...rect, x: rect.x - rect.w - CUE_GAP }
  return { ...rect, y: rect.y - CUE_HEIGHT - CUE_GAP }
}

function clampCueRect(rect: Rect, viewport: Rect): Rect {
  return {
    ...rect,
    x: clamp(rect.x, viewport.x + EDGE_INSET, viewport.x + viewport.w - EDGE_INSET - rect.w),
    y: clamp(rect.y, viewport.y + EDGE_INSET, viewport.y + viewport.h - EDGE_INSET - rect.h),
  }
}

export function placeSeriesCues(
  cues: Array<Omit<SeriesCuePlacement, 'x' | 'y'>>,
  viewport: Rect,
  obstacles: Rect[],
): SeriesCuePlacement[] {
  if (!isFiniteRect(viewport) || !Array.isArray(cues)) return []

  const occupied = obstacles.filter(isFiniteRect)
  const placements: SeriesCuePlacement[] = []
  for (const cue of cues) {
    if (!cue || !Number.isFinite(cue.hiddenCount) || !Number.isFinite(cue.totalCount)) continue
    const initialRect = initialCueRect(cue, viewport)
    let rect = initialRect
    const maxMoves = Math.ceil(Math.max(viewport.w, viewport.h) / (CUE_HEIGHT + CUE_GAP)) + 1
    for (let move = 0; move < maxMoves && occupied.some((other) => rectsIntersect(rect, other)); move++) {
      const next = clampCueRect(moveAlongSecondaryAxis(rect, cue.direction), viewport)
      if (next.x === rect.x && next.y === rect.y) break
      rect = next
    }
    if (occupied.some((other) => rectsIntersect(rect, other))) {
      let fallback = initialRect
      for (let move = 0; move < maxMoves && occupied.some((other) => rectsIntersect(fallback, other)); move++) {
        const next = clampCueRect(moveAgainstSecondaryAxis(fallback, cue.direction), viewport)
        if (next.x === fallback.x && next.y === fallback.y) break
        fallback = next
      }
      if (!occupied.some((other) => rectsIntersect(fallback, other))) rect = fallback
    }
    occupied.push(rect)
    placements.push({ ...cue, x: rect.x, y: rect.y })
  }
  return placements
}

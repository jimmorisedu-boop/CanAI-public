import type { Camera } from './boardGestures'

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se'

export const MIN_RESIZE_PX = 24
export const MAX_RESIZE_PX = 10000

export interface ResizeItemShape {
  x: number
  y: number
  w: number
  h: number
  rotation?: number
}

export interface ResizeRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CameraLike {
  x: number
  y: number
  scale: number
}

const HANDLE_SIGN: Record<ResizeHandle, { sx: 1 | -1; sy: 1 | -1 }> = {
  se: { sx: 1, sy: 1 },
  ne: { sx: 1, sy: -1 },
  sw: { sx: -1, sy: 1 },
  nw: { sx: -1, sy: -1 },
}

function rotationRad(item: Pick<ResizeItemShape, 'rotation'>): number {
  return ((item.rotation ?? 0) * Math.PI) / 180
}

/** Локальный угол в исходном прямоугольнике, который держим на месте. */
export function cornerAnchor(handle: ResizeHandle, w: number, h: number): { x: number; y: number } {
  switch (handle) {
    case 'ne': return { x: 0, y: h } // SW
    case 'sw': return { x: w, y: 0 } // NE
    case 'nw': return { x: w, y: h } // SE
    default: return { x: 0, y: 0 }  // NW
  }
}

/** Локальная точка прямоугольника в мировых координатах с его поворотом. */
export function localPointToWorld(
  item: Pick<ResizeItemShape, 'x' | 'y' | 'w' | 'h' | 'rotation'>,
  local: { x: number; y: number },
): { x: number; y: number } {
  const rad = rotationRad(item)
  const cx = item.x + item.w / 2
  const cy = item.y + item.h / 2
  const dx = local.x - item.w / 2
  const dy = local.y - item.h / 2
  return {
    x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
  }
}

export function worldPointToFrameLocal(
  item: Pick<ResizeItemShape, 'x' | 'y' | 'w' | 'h' | 'rotation'>,
  world: { x: number; y: number },
): { x: number; y: number } {
  const rad = rotationRad(item)
  const cx = item.x + item.w / 2
  const cy = item.y + item.h / 2
  const dx = world.x - cx
  const dy = world.y - cy
  const cos = Math.cos(-rad)
  const sin = Math.sin(-rad)
  return {
    x: (dx * cos - dy * sin) + item.w / 2,
    y: (dx * sin + dy * cos) + item.h / 2,
  }
}

/**
 * Новый прямоугольник после перетаскивания угла.
 *
 * Использует ЗНАКОВУЮ проекцию на ось угла: если палец переехал стационарный
 * угол, кандидат становится отрицательным и схлопывается в MIN — frame не
 * разворачивается обратно. Один общий scale для обеих сторон сохраняет
 * пропорции; стационарный угол в мировых координатах не двигается.
 */
export function resizeFromCorner(
  start: ResizeItemShape,
  handle: ResizeHandle,
  pointerLocal: { x: number; y: number },
): ResizeRect {
  const anchor = cornerAnchor(handle, start.w, start.h)
  const { sx, sy } = HANDLE_SIGN[handle]
  const candW = sx * (pointerLocal.x - anchor.x)
  const candH = sy * (pointerLocal.y - anchor.y)

  const ratioScale = Math.max(
    start.w > 0 ? Math.max(0, candW / start.w) : 0,
    start.h > 0 ? Math.max(0, candH / start.h) : 0,
  )
  const minScale = Math.max(MIN_RESIZE_PX / start.w, MIN_RESIZE_PX / start.h)
  const maxScale = Math.min(MAX_RESIZE_PX / start.w, MAX_RESIZE_PX / start.h)
  const scale = Math.min(maxScale, Math.max(minScale, ratioScale))

  const w = start.w * scale
  const h = start.h * scale
  const newAnchor = cornerAnchor(handle, w, h)
  const fixedWorld = localPointToWorld(start, anchor)

  const rad = rotationRad(start)
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const ox = newAnchor.x - w / 2
  const oy = newAnchor.y - h / 2
  const centerX = fixedWorld.x - (ox * cos - oy * sin)
  const centerY = fixedWorld.y - (ox * sin + oy * cos)

  return { x: centerX - w / 2, y: centerY - h / 2, w, h }
}

export function screenPointToWorld(
  host: { left: number; top: number },
  camera: Camera,
  screen: { x: number; y: number },
): { x: number; y: number } {
  if (camera.scale <= 0) return { x: screen.x, y: screen.y }
  return {
    x: (screen.x - host.left - camera.x) / camera.scale,
    y: (screen.y - host.top - camera.y) / camera.scale,
  }
}


import type { Bounds } from './geometry'
import type { CanvasCamera } from './types'

export interface BoardNavigatorLayout {
  scale: number
  offsetX: number
  offsetY: number
  viewport: Bounds
}

export function boardNavigatorLayout(
  objects: readonly Bounds[],
  camera: CanvasCamera,
  viewport: { w: number; h: number },
  map: { w: number; h: number },
): BoardNavigatorLayout | null {
  if (![camera.x, camera.y, camera.scale, viewport.w, viewport.h, map.w, map.h].every(Number.isFinite)
    || camera.scale <= 0 || viewport.w <= 0 || viewport.h <= 0 || map.w <= 0 || map.h <= 0) return null

  const visible = {
    x: -camera.x / camera.scale,
    y: -camera.y / camera.scale,
    w: viewport.w / camera.scale,
    h: viewport.h / camera.scale,
  }
  let minX = visible.x
  let minY = visible.y
  let maxX = visible.x + visible.w
  let maxY = visible.y + visible.h
  for (const rect of objects) {
    if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w < 0 || rect.h < 0) continue
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.w)
    maxY = Math.max(maxY, rect.y + rect.h)
  }
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  const paddedWidth = width * 1.12
  const paddedHeight = height * 1.12
  const scale = Math.min(map.w / paddedWidth, map.h / paddedHeight)
  const offsetX = (map.w - width * scale) / 2 - minX * scale
  const offsetY = (map.h - height * scale) / 2 - minY * scale
  return { scale, offsetX, offsetY, viewport: visible }
}

export function boardNavigatorWorldPoint(
  mapPoint: { x: number; y: number },
  layout: BoardNavigatorLayout,
): { x: number; y: number } {
  return {
    x: (mapPoint.x - layout.offsetX) / layout.scale,
    y: (mapPoint.y - layout.offsetY) / layout.scale,
  }
}

export function boardNavigatorCameraAt(
  worldPoint: { x: number; y: number },
  camera: CanvasCamera,
  viewport: { w: number; h: number },
): CanvasCamera {
  return {
    scale: camera.scale,
    x: viewport.w / 2 - worldPoint.x * camera.scale,
    y: viewport.h / 2 - worldPoint.y * camera.scale,
  }
}

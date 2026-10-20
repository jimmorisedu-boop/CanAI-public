import type { CanvasStore } from './canvasStore'
import { itemAabb } from './geometry'

// Операции камеры (зум-бар, хоткеи). Экранная точка = world * scale + cam.
export const MIN_SCALE = 0.05
export const MAX_SCALE = 8

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

// зум вокруг экранной точки (обычно центр вьюпорта или указатель)
export function zoomAt(store: CanvasStore, screen: { x: number; y: number }, nextScale: number): void {
  store.noteManualCameraInteraction()
  const c = store.getCamera()
  const s = clampScale(nextScale)
  const wx = (screen.x - c.x) / c.scale
  const wy = (screen.y - c.y) / c.scale
  store.setCamera({ scale: s, x: screen.x - wx * s, y: screen.y - wy * s })
}

export function zoomStep(store: CanvasStore, viewport: { w: number; h: number }, dir: 1 | -1): void {
  const c = store.getCamera()
  const factor = 1.25
  zoomAt(store, { x: viewport.w / 2, y: viewport.h / 2 }, dir > 0 ? c.scale * factor : c.scale / factor)
}

export function zoomTo100(store: CanvasStore, viewport: { w: number; h: number }): void {
  zoomAt(store, { x: viewport.w / 2, y: viewport.h / 2 }, 1)
}

export function zoomToBounds(
  current: { x: number; y: number; scale: number },
  bounds: { x: number; y: number; w: number; h: number } | null,
  viewport: { w: number; h: number },
  padding = 80,
): { x: number; y: number; scale: number } {
  if (!bounds || bounds.w <= 0 || bounds.h <= 0 || viewport.w <= 0 || viewport.h <= 0) {
    return current
  }
  const availableW = Math.max(1, viewport.w - padding * 2)
  const availableH = Math.max(1, viewport.h - padding * 2)
  const scale = clampScale(Math.min(availableW / bounds.w, availableH / bounds.h))
  return {
    scale,
    x: viewport.w / 2 - (bounds.x + bounds.w / 2) * scale,
    y: viewport.h / 2 - (bounds.y + bounds.h / 2) * scale,
  }
}

// вписать весь контент в видимую область (Figma: Shift+1)
export function zoomToFit(store: CanvasStore, viewport: { w: number; h: number }): void {
  store.noteManualCameraInteraction()
  const items = store.getItems()
  if (items.length === 0 || viewport.w === 0) return
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const i of items) {
    const bounds = itemAabb(i)
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.w)
    maxY = Math.max(maxY, bounds.y + bounds.h)
  }
  const PAD = 80
  const bw = maxX - minX
  const bh = maxY - minY
  const scale = clampScale(Math.min((viewport.w - PAD * 2) / bw, (viewport.h - PAD * 2) / bh, 1.5))
  store.setCamera({
    scale,
    x: viewport.w / 2 - (minX + bw / 2) * scale,
    y: viewport.h / 2 - (minY + bh / 2) * scale,
  })
}

import type { CanvasItem } from './types'

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

// AABB-пересечение (поворот не учитываем — как рамка в Figma / culling)
export function rectIntersects(a: Bounds, b: Bounds): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

// Konva вращает item вокруг его x/y. Мировой AABB нужен culling, marquee
// и «Показать всё», чтобы они не теряли видимые углы повёрнутых объектов.
export function itemAabb(item: CanvasItem): Bounds {
  const angle = ((item.rotation ?? 0) * Math.PI) / 180
  if (angle === 0) return { x: item.x, y: item.y, w: item.w, h: item.h }
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const points = [
    [0, 0],
    [item.w, 0],
    [item.w, item.h],
    [0, item.h],
  ].map(([dx, dy]) => ({ x: item.x + dx * cos - dy * sin, y: item.y + dx * sin + dy * cos }))
  const minX = Math.min(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxX = Math.max(...points.map((point) => point.x))
  const maxY = Math.max(...points.map((point) => point.y))
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

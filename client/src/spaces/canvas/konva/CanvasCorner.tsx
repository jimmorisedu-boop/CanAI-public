import type { CSSProperties } from 'react'
import type { CanvasStore } from './canvasStore'
import { BoardNavigator } from './BoardNavigator'

// Левый край холста оставлен мини-карте. Список участников открывается
// из верхней панели и больше не занимает место в этой колонке.
//
// Карта всегда прижата к нижнему краю колонки. На узком холсте только
// пересечение с реальным prompt-dock поднимает эту границу (см. KonvaCanvas).
// Центрирование между верхом холста и доком уводило карту к середине окна.
export const CORNER_NARROW_BELOW = 1280
export const CORNER_TIGHT_TOGGLE_SIZE = 42

export function canvasCornerIsTight(viewportHeight: number, dockBottomReserve: number): boolean {
  return Number.isFinite(viewportHeight)
    && Number.isFinite(dockBottomReserve)
    && dockBottomReserve > 0
    && viewportHeight - 14 - Math.max(14, dockBottomReserve) < CORNER_TIGHT_TOGGLE_SIZE
}

export function CanvasCorner({
  store,
  viewport,
  showNavigator,
  dockBottomReserve = 0,
}: {
  store: CanvasStore
  viewport: { w: number; h: number }
  showNavigator: boolean
  /** Measured viewport space occupied below the narrow corner by the dock. */
  dockBottomReserve?: number
}) {
  const narrow = viewport.w < CORNER_NARROW_BELOW
  const tight = narrow && canvasCornerIsTight(viewport.h, dockBottomReserve)
  const style = narrow && dockBottomReserve > 0
    ? { '--canvas-corner-dock-reserve': `${Math.ceil(dockBottomReserve)}px` } as CSSProperties
    : undefined
  return (
    <div className={`canvas-corner${narrow ? ' is-narrow' : ''}${tight ? ' is-tight' : ''}`} style={style}>
      {showNavigator && <BoardNavigator store={store} viewport={viewport} />}
    </div>
  )
}

export interface ScreenRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface SafeRect extends ScreenRect {}

const GAP = 12

export function placeContextBar(
  selection: ScreenRect,
  bar: { width: number; height: number },
  safe: SafeRect,
  obstacle?: ScreenRect,
): { left: number; top: number; side: 'above' | 'below' | 'sheet' } {
  const idealLeft = (selection.left + selection.right - bar.width) / 2
  const left = Math.min(Math.max(safe.left, idealLeft), Math.max(safe.left, safe.right - bar.width))
  const below = selection.bottom + GAP
  const overlapsObstacle = (top: number): boolean => {
    if (!obstacle) return false
    const right = left + bar.width
    const bottom = top + bar.height
    return left < obstacle.right
      && right > obstacle.left
      && top < obstacle.bottom
      && bottom > obstacle.top
  }
  if (below + bar.height <= safe.bottom && !overlapsObstacle(below)) {
    return { left, top: below, side: 'below' }
  }
  const above = selection.top - bar.height - GAP
  if (above >= safe.top && !overlapsObstacle(above)) return { left, top: above, side: 'above' }

  // Когда док плавает посередине, обычный «нижний лист» может сам попасть под
  // него. Выбираем ближайшее свободное место внутри viewport, сохраняя старое
  // направление к низу, если оно доступно.
  const sheetTop = safe.bottom - bar.height
  if (obstacle && left < obstacle.right && left + bar.width > obstacle.left) {
    const candidates = [
      sheetTop,
      obstacle.top - GAP - bar.height,
      obstacle.bottom + GAP,
      safe.top,
    ]
    const free = candidates.find((top) => (
      top >= safe.top
      && top + bar.height <= safe.bottom
      && !overlapsObstacle(top)
    ))
    if (free !== undefined) return { left, top: free, side: 'sheet' }
  }
  return {
    left,
    top: Math.max(safe.top, sheetTop),
    side: 'sheet',
  }
}

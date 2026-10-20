interface Rect { left: number; right: number; top: number; bottom: number }
interface Size { width: number; height: number }

/** Coordinates are relative to the visible browser viewport, including zoom/keyboard offsets. */
export function positionProjectMenu(anchor: Rect, menu: Size, viewport: Size & { left: number; top: number }) {
  const margin = 8
  const gap = 4
  const maxWidth = Math.max(0, viewport.width - margin * 2)
  const width = Math.min(menu.width, maxWidth)
  const below = Math.max(0, viewport.top + viewport.height - margin - anchor.bottom - gap)
  const above = Math.max(0, anchor.top - gap - viewport.top - margin)
  const opensUp = menu.height > below && above > below
  const maxHeight = Math.min(Math.max(0, viewport.height - margin * 2), opensUp ? above : below)
  const height = Math.min(menu.height, maxHeight)
  const desiredTop = opensUp ? anchor.top - gap - height : anchor.bottom + gap
  return {
    left: Math.max(viewport.left + margin, Math.min(anchor.right - width, viewport.left + viewport.width - margin - width)),
    top: Math.max(viewport.top + margin, Math.min(desiredTop, viewport.top + viewport.height - margin - height)),
    maxWidth,
    maxHeight,
    opensUp,
  }
}

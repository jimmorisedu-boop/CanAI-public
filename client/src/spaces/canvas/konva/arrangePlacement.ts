export interface ArrangeRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface ArrangePlacement {
  left: number
  top: number
  side: 'above' | 'below' | 'left' | 'right' | 'inside'
}

interface PanelSize {
  width: number
  height: number
}

interface PlacementViewport {
  left: number
  top: number
  right: number
  bottom: number
}

const GAP = 12
const MARGIN = 12

function intersects(rect: ArrangeRect, candidate: ArrangeRect): boolean {
  return candidate.left < rect.right
    && candidate.right > rect.left
    && candidate.top < rect.bottom
    && candidate.bottom > rect.top
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(low, value), Math.max(low, high))
}

/** Place the Arrange panel outside the selected content before clamping. */
export function placeArrangePanel(
  selection: ArrangeRect,
  panel: PanelSize,
  viewport: PlacementViewport,
  bottomReserve = 0,
  current?: { left: number; top: number; side?: ArrangePlacement['side'] } | null,
): ArrangePlacement {
  const fullSafe = {
    left: viewport.left + MARGIN,
    top: viewport.top + MARGIN,
    right: viewport.right - MARGIN,
    bottom: viewport.bottom - MARGIN,
  }
  const safe = {
    ...fullSafe,
    bottom: Math.max(viewport.top + MARGIN, viewport.bottom - Math.max(0, bottomReserve) - MARGIN),
  }
  const centerX = (selection.left + selection.right - panel.width) / 2
  const centerY = (selection.top + selection.bottom - panel.height) / 2

  const currentRect: ArrangeRect | null = current
    ? {
      left: current.left,
      top: current.top,
      right: current.left + panel.width,
      bottom: current.top + panel.height,
    }
    : null
  const fits = (rect: ArrangeRect | null, bounds: typeof fullSafe) => Boolean(
    rect
      && rect.left >= bounds.left
      && rect.right <= bounds.right
      && rect.top >= bounds.top
      && rect.bottom <= bounds.bottom
      && !intersects(selection, rect),
  )
  if (current) {
    if (fits(currentRect, safe) || (bottomReserve > 0 && fits(currentRect, fullSafe))) {
      return { ...current, side: current.side ?? 'below' }
    }
  }
  const raw = [
    { side: 'above' as const, left: centerX, top: selection.top - panel.height - GAP },
    { side: 'below' as const, left: centerX, top: selection.bottom + GAP },
    { side: 'right' as const, left: selection.right + GAP, top: centerY },
    { side: 'left' as const, left: selection.left - panel.width - GAP, top: centerY },
  ]
  const normalize = (candidate: { left: number; top: number }, bounds: typeof fullSafe) => ({
    left: clamp(candidate.left, bounds.left, bounds.right - panel.width),
    top: clamp(candidate.top, bounds.top, bounds.bottom - panel.height),
  })
  const findFit = (bounds: typeof fullSafe) => raw.reduce<{
    candidate: (typeof raw)[number]
    normalized: { left: number; top: number }
  } | null>((result, candidate) => {
    if (result) return result
    const normalized = normalize(candidate, bounds)
    const candidateRect = {
      left: normalized.left,
      top: normalized.top,
      right: normalized.left + panel.width,
      bottom: normalized.top + panel.height,
    }
    return fits(candidateRect, bounds) ? { candidate, normalized } : null
  }, null)
  const fit = findFit(safe)
    ?? (bottomReserve > 0 ? findFit(fullSafe) : null)
  const candidate = fit?.candidate ?? raw[0]!
  const normalized = fit?.normalized ?? normalize(candidate, safe)
  const left = normalized.left
  const top = normalized.top
  const visible = { left, top, right: left + panel.width, bottom: top + panel.height }
  const side = intersects(selection, visible) ? 'inside' as const : candidate.side
  return { left, top, side }
}

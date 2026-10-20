export interface CanvasViewportSize {
  w: number
  h: number
}

function usable(size: CanvasViewportSize): boolean {
  return Number.isFinite(size.w) && Number.isFinite(size.h) && size.w > 0 && size.h > 0
}

export function chooseCanvasViewportSize(
  measured: CanvasViewportSize,
  fallback: CanvasViewportSize,
  previous: CanvasViewportSize | null,
): CanvasViewportSize | null {
  if (usable(measured)) return measured
  if (previous && usable(previous)) return previous
  if (usable(fallback)) return fallback
  return null
}

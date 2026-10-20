export interface CanvasRectEntry {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasViewRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasCameraView {
  x: number
  y: number
  scale: number
}

export interface CanvasViewportSize {
  w: number
  h: number
}

const LOW_ZOOM_CULL_PADDING = 0.125
const LOW_ZOOM_SCALE = 0.35
const FULL_CULL_PADDING_SCALE = 1
const FULL_CULL_PADDING = 0.5

/**
 * Pick the amount of off-screen content to keep mounted for the current zoom.
 *
 * At 100% the old half-screen guard is useful while panning, but at a fit-to-
 * board scale that same guard expands the world view so much that it mounts
 * most of a large board.  Keep a modest one-eighth-screen prefetch at low zoom
 * and widen it smoothly as the user zooms in.  The screen-space guard means a
 * wheel/pan gesture still has a small runway before React needs to re-cull.
 */
export function canvasCullPadding(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return FULL_CULL_PADDING
  if (scale <= LOW_ZOOM_SCALE) return LOW_ZOOM_CULL_PADDING
  if (scale >= FULL_CULL_PADDING_SCALE) return FULL_CULL_PADDING

  const progress = (scale - LOW_ZOOM_SCALE)
    / (FULL_CULL_PADDING_SCALE - LOW_ZOOM_SCALE)
  return LOW_ZOOM_CULL_PADDING
    + (FULL_CULL_PADDING - LOW_ZOOM_CULL_PADDING) * progress
}

/**
 * React may render because a remote cursor or lease changed while Konva is
 * moving the camera imperatively. In that interval the store is deliberately
 * throttled, so feeding its older camera back into Stage would snap the board.
 */
export function canvasRenderCamera<T extends CanvasCameraView>(
  stored: T,
  live: T,
  imperativeGestureActive: boolean,
): T {
  return imperativeGestureActive ? live : stored
}

export function canvasPixelRatio(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio)) return 1
  return Math.min(1.5, Math.max(1, devicePixelRatio))
}

export function visibleCanvasEntries<T extends CanvasRectEntry>(
  entries: T[],
  view: CanvasViewRect,
  selected: ReadonlySet<string>,
  boundsOf: (entry: T) => CanvasViewRect = (entry) => entry,
): T[] {
  const right = view.x + view.w
  const bottom = view.y + view.h
  return entries.filter((entry) => {
    if (selected.has(entry.id)) return true
    const bounds = boundsOf(entry)
    return bounds.x < right
      && bounds.x + bounds.w > view.x
      && bounds.y < bottom
      && bounds.y + bounds.h > view.y
  })
}

export function canvasViewForCamera(
  camera: CanvasCameraView,
  viewport: CanvasViewportSize,
  padding = 0,
): CanvasViewRect {
  return {
    x: (-camera.x - viewport.w * padding) / camera.scale,
    y: (-camera.y - viewport.h * padding) / camera.scale,
    w: (viewport.w * (1 + 2 * padding)) / camera.scale,
    h: (viewport.h * (1 + 2 * padding)) / camera.scale,
  }
}

export function viewContains(outer: CanvasViewRect, inner: CanvasViewRect): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w
    && inner.y + inner.h <= outer.y + outer.h
}

// During a wheel gesture React keeps rendering the last committed camera while
// Konva moves imperatively. Re-render only after the real viewport leaves the
// padded area for which the current set of canvas nodes was prepared.
export function shouldRebaseCanvasView(
  renderedCamera: CanvasCameraView,
  previewCamera: CanvasCameraView,
  viewport: CanvasViewportSize,
  renderPadding: number,
): boolean {
  if (viewport.w <= 0 || viewport.h <= 0) return false
  return !viewContains(
    canvasViewForCamera(renderedCamera, viewport, renderPadding),
    canvasViewForCamera(previewCamera, viewport),
  )
}

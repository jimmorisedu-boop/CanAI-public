/**
 * Pick a local preview for a canvas image while it is on screen. The original
 * media path remains the source of truth for downloads, crop, sketch and
 * generation; this helper only changes the URL used by the renderer.
 */

const LOCAL_MEDIA = /^\/media\/([^/?#]+)$/u

export const PREVIEW_STEPS = [256, 512, 1024, 1920] as const

export function previewStep(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return PREVIEW_STEPS[0]
  for (const step of PREVIEW_STEPS) {
    if (widthPx <= step) return step
  }
  return PREVIEW_STEPS[PREVIEW_STEPS.length - 1]!
}

export function stickyPreviewStep(previous: number | undefined, requested: number): number {
  if (previous === undefined || !(requested < previous)) return requested
  return previewLevel(previous) <= 2 * previewLevel(requested) ? previous : requested
}

function previewLevel(widthPx: number): number {
  return widthPx > PREVIEW_STEPS[PREVIEW_STEPS.length - 1]!
    ? Number.POSITIVE_INFINITY
    : previewStep(widthPx)
}

export function screenPreviewSrc(src: string | undefined, screenWidth: number): string | undefined {
  if (!src) return src
  const [path, query] = src.split('?')
  if (screenWidth > PREVIEW_STEPS[PREVIEW_STEPS.length - 1]!) return src
  const local = LOCAL_MEDIA.exec(path ?? '')
  if (!local) return src
  const step = previewStep(screenWidth)
  return `/media/preview/${local[1]}?w=${step}${query ? `&${query}` : ''}`
}

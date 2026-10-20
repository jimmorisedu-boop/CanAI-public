import type { Rect } from '../spaces/canvas/konva/cropMath'

export function cropFieldBounds(rect: Rect, field: keyof Rect, bounds: { w: number; h: number }, minimum = 24) {
  const max = field === 'x' ? bounds.w - rect.w : field === 'y' ? bounds.h - rect.h
    : field === 'w' ? bounds.w - rect.x : bounds.h - rect.y
  return { min: field === 'x' || field === 'y' ? 0 : Math.min(minimum, max), max }
}

export function editCropField(rect: Rect, field: keyof Rect, value: number, bounds: { w: number; h: number }, minimum = 24, ratio: number | null = null): Rect {
  if (!Number.isFinite(value)) return rect
  const limits = cropFieldBounds(rect, field, bounds, minimum)
  const next = { ...rect, [field]: Math.max(limits.min, Math.min(limits.max, value)) }
  if ((field === 'w' || field === 'h') && ratio && ratio > 0) {
    const maxWidth = Math.min(bounds.w - rect.x, (bounds.h - rect.y) * ratio)
    const minWidth = Math.min(maxWidth, Math.max(minimum, minimum * ratio))
    next.w = Math.max(minWidth, Math.min(maxWidth, field === 'w' ? value : value * ratio))
    next.h = next.w / ratio
  }
  return next
}

// Геометрия кропа. Всё в ЛОКАЛЬНЫХ координатах картинки (0..w, 0..h в
// экранных единицах item), поворот учитывается снаружи (Group).

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const CROP_MIN = 24

// На очень маленькой картинке обычный минимум физически не помещается.
// В таком случае границы важнее: эффективный минимум сжимается до доступного.
function clampCropSize(raw: number, max: number): number {
  const available = Math.max(0, max)
  const min = Math.min(CROP_MIN, available)
  return Math.max(min, Math.min(available, raw))
}

export interface RatioPreset {
  label: string
  value: number | null // w/h; null = свободно
}

export const RATIO_PRESETS: RatioPreset[] = [
  { label: 'Freeform', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
]

// максимальный центрированный прямоугольник данного соотношения внутри границ
export function centeredRect(bounds: { w: number; h: number }, ratio: number | null): Rect {
  if (!ratio) return { x: 0, y: 0, w: bounds.w, h: bounds.h }
  let w = bounds.w
  let h = w / ratio
  if (h > bounds.h) {
    h = bounds.h
    w = h * ratio
  }
  return { x: (bounds.w - w) / 2, y: (bounds.h - h) / 2, w, h }
}

// переместить окно, не выходя за границы
export function clampMove(rect: Rect, bounds: { w: number; h: number }): Rect {
  return {
    ...rect,
    x: Math.min(Math.max(0, rect.x), bounds.w - rect.w),
    y: Math.min(Math.max(0, rect.y), bounds.h - rect.h),
  }
}

// пересчёт окна при перетаскивании углового хендла.
// corner: 'nw'|'ne'|'sw'|'se'; anchor — противоположный угол (неподвижен).
export function resizeFromCorner(
  rect: Rect,
  corner: 'nw' | 'ne' | 'sw' | 'se',
  pointer: { x: number; y: number },
  bounds: { w: number; h: number },
  ratio: number | null,
): Rect {
  const anchor = {
    x: corner === 'nw' || corner === 'sw' ? rect.x + rect.w : rect.x,
    y: corner === 'nw' || corner === 'ne' ? rect.y + rect.h : rect.y,
  }
  const signX = corner === 'ne' || corner === 'se' ? 1 : -1
  const signY = corner === 'sw' || corner === 'se' ? 1 : -1

  // доступное пространство от якоря в сторону перетаскивания
  const availW = signX > 0 ? bounds.w - anchor.x : anchor.x
  const availH = signY > 0 ? bounds.h - anchor.y : anchor.y

  let w = clampCropSize((pointer.x - anchor.x) * signX, availW)
  let h = clampCropSize((pointer.y - anchor.y) * signY, availH)

  if (ratio) {
    // Для фиксированного ratio работаем через ширину. Минимум 24 px по обеим
    // осям сохраняется, когда помещается; иначе берём крупнейший допустимый
    // прямоугольник и никогда не выходим за bounds.
    const maxW = Math.max(0, Math.min(availW, availH * ratio))
    const minW = Math.min(maxW, Math.max(CROP_MIN, CROP_MIN * ratio))
    w = Math.max(minW, Math.min(maxW, w))
    h = w / ratio
  }

  return {
    x: signX > 0 ? anchor.x : anchor.x - w,
    y: signY > 0 ? anchor.y : anchor.y - h,
    w,
    h,
  }
}

// пересчёт окна при перетаскивании кромки (только свободный режим)
export function resizeFromEdge(
  rect: Rect,
  edge: 'n' | 's' | 'w' | 'e',
  pointer: { x: number; y: number },
  bounds: { w: number; h: number },
): Rect {
  const r = { ...rect }
  if (edge === 'n') {
    const available = rect.y + rect.h
    const maxY = available - Math.min(CROP_MIN, available)
    const y = Math.min(Math.max(0, pointer.y), maxY)
    r.h = rect.y + rect.h - y
    r.y = y
  } else if (edge === 's') {
    r.h = clampCropSize(pointer.y - rect.y, bounds.h - rect.y)
  } else if (edge === 'w') {
    const available = rect.x + rect.w
    const maxX = available - Math.min(CROP_MIN, available)
    const x = Math.min(Math.max(0, pointer.x), maxX)
    r.w = rect.x + rect.w - x
    r.x = x
  } else {
    r.w = clampCropSize(pointer.x - rect.x, bounds.w - rect.x)
  }
  return r
}

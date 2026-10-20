// Выделение объекта на холсте — скруглённое кольцо с зазором.
//
// Решение пользователя 30.09.2026 из трёх вариантов со снимками («квадратное
// выделение выглядит странно»): квадрат Konva не повторял скругление объекта,
// а контур прямо по краю ложился на пиксели картинки. Кольцо — та же форма,
// что у выделения на планшете (outline с отступом у `.tablet-item-inner`), то
// есть одна на всех устройствах; различается только толщина линии — у
// пальца она крупнее.
//
// ⚠️ Кольцо концентрично объекту: его радиус — скругление объекта ПЛЮС
// зазор. Зазор и толщина — в ЭКРАННЫХ пикселях при любом масштабе.

export const SELECTION_GAP_PX = 3
export const SELECTION_RING_PX = 1.5
export const SELECTION_COLOR = '#d33f21'
/** Общая рамка вокруг нескольких выделенных — тоньше и тише их колец. */
export const SELECTION_GROUP_COLOR = 'rgba(211, 63, 33, 0.45)'

/**
 * Что объект сообщает о себе выделению — атрибут `selectionFrame` его группы:
 * размер в своих единицах и скругление того, что он рисует.
 */
export interface SelectionFrame {
  x?: number
  y?: number
  w: number
  h: number
  radius: number
}

export interface SelectionRingGeometry {
  x: number
  y: number
  w: number
  h: number
  radius: number
}

/** Кольцо в единицах объекта; `screenScale` — во сколько раз он увеличен на экране. */
export function selectionRing(frame: SelectionFrame, screenScale: number): SelectionRingGeometry | null {
  if (!(screenScale > 0) || !Number.isFinite(screenScale)) return null
  if (!(frame.w > 0) || !(frame.h > 0)) return null
  const gap = SELECTION_GAP_PX / screenScale
  return {
    x: (frame.x ?? 0) - gap,
    y: (frame.y ?? 0) - gap,
    w: frame.w + 2 * gap,
    h: frame.h + 2 * gap,
    radius: Math.max(0, frame.radius) + gap,
  }
}

/**
 * Отступ ручек от края объекта, в экранных пикселях. У одного объекта ручки
 * стоят на углах его кольца; у группы общая рамка обходит кольца снаружи.
 */
export function selectionPadding(count: number): number {
  return count > 1 ? SELECTION_GAP_PX * 2 : SELECTION_GAP_PX
}

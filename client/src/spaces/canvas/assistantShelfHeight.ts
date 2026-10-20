// Заголовок с моделью и ручкой остаётся доступен и в свёрнутом виде.
export const SHELF_MIN_HEIGHT = 72
export const SHELF_DEFAULT_HEIGHT = 280
// топ-бар (52) + отступ дока снизу (18) + запас на ряды промпт-бара под лентой
const CHROME_RESERVE = 250

// Окно помощника растёт ВВЕРХ внутри промпт-дока, а док лежит в контейнере с
// overflow:hidden — значит «лишняя» высота срезается СВЕРХУ вместе с шапкой
// («Новый диалог») и грифом. Поэтому потолок считаем от РЕАЛЬНО доступного
// места, а не от всего окна: 70% от 720px казались бы допустимыми, но вместе
// с самим баром уже не влезают.
export function clampShelfHeight(
  height: number,
  viewportHeight: number,
  reserve = CHROME_RESERVE,
): number {
  const available = viewportHeight - reserve
  const max = Math.max(SHELF_MIN_HEIGHT, Math.min(Math.round(viewportHeight * 0.7), available))
  if (!Number.isFinite(height)) return Math.min(SHELF_DEFAULT_HEIGHT, max)
  return Math.min(max, Math.max(SHELF_MIN_HEIGHT, Math.round(height)))
}

// Тянем за верхнюю кромку: курсор вверх (dy < 0) — окно выше.
export function resizeShelfHeight(
  startHeight: number,
  startY: number,
  currentY: number,
  viewportHeight: number,
): number {
  return clampShelfHeight(startHeight + (startY - currentY), viewportHeight)
}

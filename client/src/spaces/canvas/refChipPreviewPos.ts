// Где показать превью референса. Карточка рисуется в портале на <body>
// с position: fixed — иначе её срезает overflow ленты помощника, — значит
// координаты считаем сами, от прямоугольника чипа.

export const PREVIEW_WIDTH = 200
const GAP = 8 // зазор между чипом и карточкой
const EDGE = 8 // не липнуть к краям окна
const CARD_CHROME = 10 // паддинг 4×2 + рамка 1×2 самой карточки
const MEDIA_MAX = 200 // потолок картинки внутри карточки
const MEDIA_MIN = 60 // ниже этого превью бессмысленно

export type Rect = { top: number; bottom: number; left: number; right: number }

export type RefChipPreviewPlacement = {
  left: number
  placement: 'top' | 'bottom'
  // для 'top' — отступ карточки от НИЗА окна (CSS bottom), для 'bottom' — от верха (CSS top).
  // Так не нужно знать высоту карточки заранее: она растёт от кромки чипа.
  offset: number
  maxMediaHeight: number
}

export function refChipPreviewPosition(
  chip: Rect,
  viewport: { width: number; height: number },
): RefChipPreviewPlacement {
  const center = (chip.left + chip.right) / 2
  const rightLimit = Math.max(EDGE, viewport.width - PREVIEW_WIDTH - EDGE)
  const left = Math.min(Math.max(center - PREVIEW_WIDTH / 2, EDGE), rightLimit)

  const roomAbove = chip.top - GAP - EDGE
  const roomBelow = viewport.height - chip.bottom - GAP - EDGE
  const needed = MEDIA_MAX + CARD_CHROME
  // по умолчанию сверху (как было), вниз уходим только когда сверху реально теснее
  const above = roomAbove >= needed || roomAbove >= roomBelow
  const room = above ? roomAbove : roomBelow

  return {
    left,
    placement: above ? 'top' : 'bottom',
    offset: above ? viewport.height - chip.top + GAP : chip.bottom + GAP,
    maxMediaHeight: Math.max(MEDIA_MIN, Math.min(MEDIA_MAX, room - CARD_CHROME)),
  }
}

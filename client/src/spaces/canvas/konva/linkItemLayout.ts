export interface LinkItemRect {
  x: number
  y: number
  width: number
  height: number
}

export interface LinkItemLayout {
  preview: LinkItemRect
  badge: LinkItemRect
  title: LinkItemRect
  url: LinkItemRect
  openButton: LinkItemRect
  downloadButton: LinkItemRect
}

/** Карточка растёт ЦЕЛИКОМ, а не только коробками.
 *
 *  Жалоба 19.08.2026: «при растягивании кнопки становятся больше, а текст
 *  меньше». Так и было: ширина кнопок тянулась за карточкой, а высоты и кегли
 *  стояли числами — на большой карточке подпись выглядела мелкой.
 *
 *  Множитель берём от МЕНЬШЕЙ стороны — тем же приёмом, что у заглушек
 *  генерации: на широкой и низкой карточке шрифт не должен раздуваться. */
const BASE_SIDE = 280

export function linkItemScale(width: number, height: number): number {
  const side = Math.min(width, height)
  return Math.max(0.75, Math.min(2, side / BASE_SIDE))
}

export function linkItemLayout(width: number, height: number): LinkItemLayout {
  const scale = linkItemScale(width, height)
  const pad = Math.max(12 * scale, Math.min(20 * scale, width * 0.05))
  const buttonHeight = 34 * scale
  const buttonGap = 8 * scale
  const actionY = Math.max(0, height - pad - buttonHeight)
  const buttonWidth = Math.max(0, (width - pad * 2 - buttonGap) / 2)
  const previewHeight = Math.max(64, Math.min(width * 9 / 16, actionY - 116 * scale))
  const badgeY = previewHeight + 10 * scale
  const badgeHeight = Math.max(0, Math.min(22 * scale, actionY - badgeY))
  const titleY = badgeY + badgeHeight + 8 * scale
  const urlHeight = actionY - titleY >= 24 * scale ? 14 * scale : 0
  const urlY = actionY - 10 * scale - urlHeight
  const titleHeight = Math.max(0, urlY - 4 * scale - titleY)

  return {
    preview: { x: 0, y: 0, width, height: previewHeight },
    badge: { x: pad, y: badgeY, width: Math.max(0, width - pad * 2), height: badgeHeight },
    title: { x: pad, y: titleY, width: Math.max(0, width - pad * 2), height: titleHeight },
    url: { x: pad, y: urlY, width: Math.max(0, width - pad * 2), height: urlHeight },
    openButton: { x: pad, y: actionY, width: buttonWidth, height: buttonHeight },
    downloadButton: {
      x: pad + buttonWidth + buttonGap,
      y: actionY,
      width: buttonWidth,
      height: buttonHeight,
    },
  }
}

export interface LinkActionButtonStyle {
  fill: string
  stroke: string
}

/** Радиус кнопок карточки — как у всех кнопок приложения (--r-sm: 8px).
 *  Таблетка (cornerRadius = height/2) была тут единственной на весь холст
 *  и сразу выдавала себя чужой. */
export const LINK_ACTION_RADIUS = 8

/** Акцент приходит из палитры темы, а не зашит здесь: карточка ссылки жила
 *  на старом оранжевом #ff6038, когда весь интерфейс уже перешёл на
 *  вермилион, и выглядела деталью из другого приложения. */
export function linkActionButtonStyle(
  primary: boolean,
  hovered: boolean,
  accent: { base: string; hover: string } = { base: '#d33f21', hover: '#bd3518' },
): LinkActionButtonStyle {
  if (primary) {
    return hovered
      ? { fill: accent.hover, stroke: accent.hover }
      : { fill: accent.base, stroke: accent.base }
  }
  return hovered
    ? { fill: 'rgba(127,127,127,0.24)', stroke: 'rgba(255,255,255,0.34)' }
    : { fill: 'rgba(127,127,127,0.14)', stroke: 'rgba(127,127,127,0.28)' }
}

export function setLinkActionButtonCursor(
  container: Pick<HTMLElement, 'style'> | undefined,
  hovered: boolean,
): void {
  if (container) container.style.cursor = hovered ? 'pointer' : ''
}

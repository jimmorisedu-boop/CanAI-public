import type { CSSProperties } from 'react'

/**
 * Где стоит панель кнопок видео на планшете.
 *
 * Сама панель держит ЭКРАННЫЙ размер при любом масштабе доски (scale(1/масштаб)),
 * а отступ от края клипа стоял в единицах доски — 8 — и при отдалении таял: на
 * масштабе 0.5 панель стояла в 4 пикселях от края. Отступ теперь тоже экранный
 * и чуть больше (просьба 21.09.2026 «отступы от края чуть дальше»).
 */
export const TABLET_VIDEO_ACTIONS_EDGE = 12
const MIN_SCALE = 0.15

export function tabletVideoActionsStyle(scale: number): CSSProperties {
  const s = Math.max(Number.isFinite(scale) && scale > 0 ? scale : 1, MIN_SCALE)
  return {
    top: TABLET_VIDEO_ACTIONS_EDGE / s,
    left: TABLET_VIDEO_ACTIONS_EDGE / s,
    transform: `scale(${1 / s})`,
  }
}

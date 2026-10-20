import { CANVAS_MONO_FONT } from './fonts'
import { formatMediaTime } from './mediaTime'

/** Fixed world-space metrics shared by the video chrome and the info badge. */
export const MEDIA_TIME_BADGE_FONT = `10px ${CANVAS_MONO_FONT}`
export const MEDIA_TIME_BADGE_H = 18
export const MEDIA_TIME_BADGE_EDGE = 8
export const MEDIA_TIME_BADGE_PAD_X = 6
/** Keep the filename/details badge visibly separate from the time badge. */
export const MEDIA_BADGE_GAP = 8

export function mediaTimeBadgeText(currentTime: number, duration: number): string {
  return `${formatMediaTime(currentTime)} / ${formatMediaTime(duration)}`
}

export function mediaTimeBadgeWidth(textWidth: number): number {
  return Math.max(0, Number.isFinite(textWidth) ? textWidth : 0) + MEDIA_TIME_BADGE_PAD_X * 2
}

/** A timer is only useful when its complete text can fit inside the card. */
export function mediaTimeBadgeFits(itemW: number, textWidth: number): boolean {
  const width = mediaTimeBadgeWidth(textWidth)
  return Number.isFinite(itemW) && itemW >= width + MEDIA_TIME_BADGE_EDGE * 2
}

export function mediaTimeBadgeRightReservation(textWidth: number, itemW?: number): number {
  if (itemW !== undefined && !mediaTimeBadgeFits(itemW, textWidth)) return 0
  return mediaTimeBadgeWidth(textWidth) + MEDIA_BADGE_GAP
}

export interface MediaTimeBadgeLayout {
  x: number
  y: number
  w: number
  h: number
}

export function mediaTimeBadgeLayout(
  itemW: number,
  itemH: number,
  bottomOffset: number,
  textWidth: number,
): MediaTimeBadgeLayout | null {
  const w = mediaTimeBadgeWidth(textWidth)
  // A negative x put the whole timer outside very small cards and still let
  // its text overlap the filename badge. Hide the timer until it has room for
  // its complete text; tiny cards remain clean and selectable at any zoom.
  if (!mediaTimeBadgeFits(itemW, textWidth)) return null
  return {
    x: itemW - w - MEDIA_TIME_BADGE_EDGE,
    y: itemH - MEDIA_TIME_BADGE_H - MEDIA_TIME_BADGE_EDGE - bottomOffset,
    w,
    h: MEDIA_TIME_BADGE_H,
  }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEDIA_BADGE_GAP,
  MEDIA_TIME_BADGE_EDGE,
  mediaTimeBadgeLayout,
  mediaTimeBadgeRightReservation,
  mediaTimeBadgeText,
  mediaTimeBadgeWidth,
} from './mediaBadgeLayout'

test('time badge geometry exposes a stable right reservation', () => {
  const textWidth = 66
  const badge = mediaTimeBadgeLayout(240, 160, 12, textWidth)
  assert.ok(badge)
  assert.equal(badge.w, mediaTimeBadgeWidth(textWidth))
  assert.equal(badge.x, 240 - badge.w - MEDIA_TIME_BADGE_EDGE)
  assert.equal(mediaTimeBadgeRightReservation(textWidth), badge.w + MEDIA_BADGE_GAP)
})

test('time text stays finite for unfinished videos', () => {
  assert.equal(mediaTimeBadgeText(0, 0), '0:00.00 / 0:00.00')
  assert.equal(mediaTimeBadgeText(Number.NaN, Number.POSITIVE_INFINITY), '0:00.00 / 0:00.00')
})

test('right reservation leaves a visible gap for the left info badge', () => {
  const itemW = 180
  const textWidth = 66
  const time = mediaTimeBadgeLayout(itemW, 120, 12, textWidth)
  assert.ok(time)
  // ItemInfoBadge's right edge is itemW - EDGE - reservation (EDGE = 8).
  const infoRight = itemW - MEDIA_TIME_BADGE_EDGE - mediaTimeBadgeRightReservation(textWidth)
  assert.equal(time.x - infoRight, MEDIA_BADGE_GAP)
})

test('tiny cards hide the timer instead of drawing it outside the card', () => {
  const textWidth = 66
  assert.equal(mediaTimeBadgeLayout(80, 80, 0, textWidth), null)
  assert.equal(mediaTimeBadgeRightReservation(textWidth, 80), 0)
})

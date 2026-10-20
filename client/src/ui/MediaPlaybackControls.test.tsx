import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RefObject } from 'react'
import { createNativeMediaErrorGuard, MediaPlaybackControls, formatMediaTime } from './MediaPlaybackControls'

const emptyMediaRef: RefObject<HTMLMediaElement | null> = { current: null }
const emptyFullscreenRef: RefObject<HTMLElement | null> = { current: null }

test('media time formatting keeps finite, hour, live, and unloaded values readable', () => {
  assert.equal(formatMediaTime(0), '0:00')
  assert.equal(formatMediaTime(65.4), '1:05')
  assert.equal(formatMediaTime(3661), '1:01:01')
  assert.equal(formatMediaTime(Infinity), 'Live')
  assert.equal(formatMediaTime(Number.NaN), '0:00')
})

test('custom media controls expose English labels without native browser controls', () => {
  const html = renderToStaticMarkup(<MediaPlaybackControls mediaRef={emptyMediaRef} />)
  assert.match(html, /role="group" aria-label="Media playback controls"/)
  assert.match(html, /aria-label="Play"/)
  assert.match(html, /aria-label="Seek"/)
  assert.match(html, /aria-label="Mute"/)
  assert.match(html, /aria-label="Volume"/)
  assert.match(html, /disabled=""/)
  assert.doesNotMatch(html, /<(?:video|audio)\b[^>]*\bcontrols(?:=|\s|>)/u)
})

test('fullscreen control is opt-in and remains labelled in English', () => {
  const html = renderToStaticMarkup(
    <MediaPlaybackControls mediaRef={emptyMediaRef} fullscreenRef={emptyFullscreenRef} />,
  )
  assert.match(html, /aria-label="Full screen"/)
  assert.match(html, /title="Full screen"/)
})

test('editor transport can leave seeking and timecode to its dedicated timeline', () => {
  const html = renderToStaticMarkup(<MediaPlaybackControls mediaRef={emptyMediaRef} showSeek={false} />)
  assert.doesNotMatch(html, /aria-label="Seek"/)
  assert.doesNotMatch(html, /aria-label="Playback time"/)
  assert.match(html, /aria-label="Play"/)
  assert.match(html, /aria-label="Mute"/)
})

test('an error already present before controls mount still shows an English alert', () => {
  const failedMediaRef: RefObject<HTMLMediaElement | null> = {
    current: { error: { code: 4 }, readyState: 0, paused: true, volume: 1 } as HTMLMediaElement,
  }
  const html = renderToStaticMarkup(<MediaPlaybackControls mediaRef={failedMediaRef} />)
  assert.match(html, /role="alert">Media could not be loaded\./)
  assert.match(html, /disabled=""/)
})

test('native media error guard hides browser fallback and restores original attributes', () => {
  const attributes = new Map<string, string>()
  const media = {
    style: { visibility: 'visible' },
    getAttribute(name: string) {
      return attributes.get(name) ?? null
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value)
    },
    removeAttribute(name: string) {
      attributes.delete(name)
    },
  } as unknown as HTMLMediaElement

  const guard = createNativeMediaErrorGuard(media)
  guard.hide()
  assert.equal(media.style.visibility, 'hidden')
  assert.equal(media.getAttribute('aria-hidden'), 'true')
  guard.restore()
  assert.equal(media.style.visibility, 'visible')
  assert.equal(media.getAttribute('aria-hidden'), null)

  media.style.visibility = ''
  media.setAttribute('aria-hidden', 'false')
  const secondGuard = createNativeMediaErrorGuard(media)
  secondGuard.hide()
  secondGuard.restore()
  assert.equal(media.style.visibility, '')
  assert.equal(media.getAttribute('aria-hidden'), 'false')
})

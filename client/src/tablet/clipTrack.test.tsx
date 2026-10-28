import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClipTrack } from './ClipTrack'
import type { TimelineSession } from '../spaces/canvas/timeline/useTimelineSession'

function session(patch: Partial<TimelineSession> = {}): TimelineSession {
  return {
    item: { id: 'clip', kind: 'video', src: '/media/clip.mp4', x: 0, y: 0, w: 320, h: 180 },
    facts: { duration: 12, width: 1920, height: 1080, fps: 24, hasAudio: false },
    loading: false,
    error: null,
    inPoint: 0,
    outPoint: 12,
    head: 3,
    cuts: [],
    busy: false,
    setHead() {},
    moveIn() {},
    moveOut() {},
    addCut() {},
    moveCut: (_from, to) => to,
    removeCut() {},
    segments: [{ start: 0, end: 12 }],
    dropped: [],
    toggleDropAtHead() {},
    toggleDropAt() {},
    trimLeftAtHead() {},
    trimRightAtHead() {},
    shots: [],
    autoOn: false,
    autoBusy: false,
    threshold: 10,
    setThreshold() {},
    toggleAuto() {},
    crop: null,
    cropRatio: null,
    setCrop() {},
    setCropRatio() {},
    toggleCrop() {},
    pieces: 1,
    summary: '1 piece',
    apply: async () => 'no-op',
    close() {},
    ...patch,
  }
}

test('ClipTrack uses a neutral ruler when no real peaks are present', () => {
  const html = renderToStaticMarkup(<ClipTrack session={session()} onSeek={() => {}} />)
  assert.match(html, /class="tablet-track-ruler"/)
  assert.doesNotMatch(html, /class="tablet-track-body"/)
  assert.match(html, /aria-label="Playback time"/)
  assert.match(html, /aria-label="Keyboard shortcuts"/)
  assert.doesNotMatch(html, /Arrow keys move one frame/u)
})

test('ClipTrack renders supplied peaks as data and keeps keyboard help discoverable', () => {
  const html = renderToStaticMarkup(<ClipTrack session={session({
    facts: { duration: 12, width: 1920, height: 1080, fps: 24, hasAudio: true },
    item: { id: 'clip', kind: 'video', src: '/media/clip.mp4', x: 0, y: 0, w: 320, h: 180, peaks: [12, 80] },
  })} onSeek={() => {}} />)
  assert.match(html, /class="tablet-track-body"/)
  assert.doesNotMatch(html, /class="tablet-track-ruler"/)
})

test('ClipTrack ignores persisted peaks when probe confirms no audio', () => {
  const html = renderToStaticMarkup(<ClipTrack session={session({
    item: { id: 'clip', kind: 'video', src: '/media/clip.mp4', x: 0, y: 0, w: 320, h: 180, peaks: [12, 80] },
  })} onSeek={() => {}} />)
  assert.match(html, /class="tablet-track-ruler"/)
  assert.doesNotMatch(html, /class="tablet-track-body"/)
})

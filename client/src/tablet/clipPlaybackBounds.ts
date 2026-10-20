/**
 * Keep the editor's media element inside its editable range. The timeline
 * session already clamps its own head state, but browser media events can keep
 * arriving after React has rendered the same head value, so this guard lives
 * on the element's play/timeupdate events as well.
 */

const CLIP_TIME_EPSILON = 0.02

export interface ClipPlaybackSession {
  inPoint: number
  outPoint: number
  head: number
  setHead(time: number): void
}

export interface ClipMediaEventTarget {
  currentTime: number
  readonly paused: boolean
  pause(): void
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

export type ClipMediaSyncMode = 'head' | 'timeupdate' | 'play'

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

export function clampClipPlaybackTime(time: number, session: Pick<ClipPlaybackSession, 'inPoint' | 'outPoint'>): number {
  const low = Math.max(0, finite(session.inPoint, 0))
  const high = Math.max(low, finite(session.outPoint, low))
  return Math.min(high, Math.max(low, finite(time, low)))
}

/**
 * Synchronize one media event. `play` at the trim end deliberately restarts at
 * the in-point; a timeupdate at the end pauses and leaves the playhead there.
 * The head mode is used by React when a trim handle or keyboard command moves
 * the session without a corresponding media event.
 */
export function syncClipMedia(
  media: Pick<ClipMediaEventTarget, 'currentTime' | 'paused' | 'pause'>,
  session: ClipPlaybackSession,
  mode: ClipMediaSyncMode,
): number {
  const low = Math.max(0, finite(session.inPoint, 0))
  const high = Math.max(low, finite(session.outPoint, low))
  const current = finite(media.currentTime, low)

  if (mode === 'play' && high > low && current >= high - CLIP_TIME_EPSILON) {
    media.currentTime = low
    session.setHead(low)
    return low
  }

  const next = mode === 'head'
    ? clampClipPlaybackTime(session.head, session)
    : clampClipPlaybackTime(current, session)
  if (Math.abs(current - next) > CLIP_TIME_EPSILON) media.currentTime = next

  if (mode === 'timeupdate' || mode === 'head') {
    if (current >= high - CLIP_TIME_EPSILON && !media.paused) media.pause()
  }
  if (mode === 'timeupdate') {
    if (Math.abs(session.head - next) > CLIP_TIME_EPSILON) session.setHead(next)
  } else if (mode === 'play' && Math.abs(session.head - next) > CLIP_TIME_EPSILON) {
    session.setHead(next)
  }
  return next
}

/** Bind the guard once per media source; the getter keeps trim/head values fresh. */
export function bindClipMediaGuards(
  media: ClipMediaEventTarget,
  getSession: () => ClipPlaybackSession | null,
): () => void {
  const sync = (mode: ClipMediaSyncMode): void => {
    const session = getSession()
    if (session) syncClipMedia(media, session, mode)
  }
  const onLoadedMetadata: EventListener = () => sync('head')
  const onDurationChange: EventListener = () => sync('head')
  const onTimeUpdate: EventListener = () => sync('timeupdate')
  const onPlay: EventListener = () => sync('play')
  media.addEventListener('loadedmetadata', onLoadedMetadata)
  media.addEventListener('durationchange', onDurationChange)
  media.addEventListener('timeupdate', onTimeUpdate)
  media.addEventListener('play', onPlay)
  sync('head')
  return () => {
    media.removeEventListener('loadedmetadata', onLoadedMetadata)
    media.removeEventListener('durationchange', onDurationChange)
    media.removeEventListener('timeupdate', onTimeUpdate)
    media.removeEventListener('play', onPlay)
  }
}

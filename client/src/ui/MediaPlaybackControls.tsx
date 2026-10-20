import { useEffect, useState, type RefObject, type SyntheticEvent } from 'react'

export interface MediaPlaybackControlsProps {
  /** The media element whose native controls are replaced. */
  mediaRef: RefObject<HTMLMediaElement | null>
  /** Optional shell to enter/leave full screen for players that already support it. */
  fullscreenRef?: RefObject<HTMLElement | null>
  /** Hide seek and time controls when a dedicated editor timeline owns seeking. */
  showSeek?: boolean
  className?: string
}

interface MediaSnapshot {
  currentTime: number
  duration: number
  paused: boolean
  muted: boolean
  volume: number
  ready: boolean
  error: boolean
  fullscreen: boolean
}

export interface NativeMediaErrorGuard {
  hide(): void
  restore(): void
}

const EMPTY_SNAPSHOT: MediaSnapshot = {
  currentTime: 0,
  duration: 0,
  paused: true,
  muted: false,
  volume: 1,
  ready: false,
  error: false,
  fullscreen: false,
}

/**
 * Chromium may expose a localized error panel inside a media element when its
 * source fails. Keep the element in the layout and keep its real error/event
 * state, but hide only that browser-owned fallback from pixels and AT while
 * our English status is visible beside it.
 */
export function createNativeMediaErrorGuard(media: HTMLMediaElement): NativeMediaErrorGuard {
  const originalVisibility = media.style.visibility
  const originalAriaHidden = media.getAttribute('aria-hidden')
  let hidden = false
  return {
    hide() {
      if (hidden) return
      hidden = true
      media.style.visibility = 'hidden'
      media.setAttribute('aria-hidden', 'true')
    },
    restore() {
      if (!hidden) return
      hidden = false
      media.style.visibility = originalVisibility
      if (originalAriaHidden === null) media.removeAttribute('aria-hidden')
      else media.setAttribute('aria-hidden', originalAriaHidden)
    },
  }
}

/** Format a media time without exposing NaN/Infinity in the interface. */
export function formatMediaTime(seconds: number): string {
  if (seconds === Infinity) return 'Live'
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  const remaining = whole % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
  }
  return `${minutes}:${String(remaining).padStart(2, '0')}`
}

function snapshotFor(media: HTMLMediaElement | null, fullscreenRef?: RefObject<HTMLElement | null>): MediaSnapshot {
  if (!media) return { ...EMPTY_SNAPSHOT, fullscreen: Boolean(fullscreenRef?.current && typeof document !== 'undefined' && document.fullscreenElement === fullscreenRef.current) }
  const rawDuration = media.duration
  const duration = Number.isFinite(rawDuration)
    ? Math.max(0, rawDuration)
    : rawDuration === Infinity
      ? Infinity
      : 0
  const currentTime = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0
  return {
    currentTime,
    duration,
    paused: media.paused,
    muted: media.muted,
    volume: Number.isFinite(media.volume) ? Math.min(1, Math.max(0, media.volume)) : 1,
    ready: media.readyState >= 1 && !media.error,
    error: Boolean(media.error),
    fullscreen: Boolean(fullscreenRef?.current && typeof document !== 'undefined' && document.fullscreenElement === fullscreenRef.current),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function MediaPlaybackControls({ mediaRef, fullscreenRef, showSeek = true, className = '' }: MediaPlaybackControlsProps) {
  const [snapshot, setSnapshot] = useState<MediaSnapshot>(() => snapshotFor(mediaRef.current, fullscreenRef))
  const [interactionError, setInteractionError] = useState<string | null>(null)

  useEffect(() => {
    const media = mediaRef.current
    if (!media) {
      setSnapshot(snapshotFor(null, fullscreenRef))
      return
    }

    const nativeErrorGuard = createNativeMediaErrorGuard(media)
    const sync = () => setSnapshot(snapshotFor(media, fullscreenRef))
    const syncWithNativeErrorGuard = () => {
      const next = snapshotFor(media, fullscreenRef)
      if (next.error) nativeErrorGuard.hide()
      else nativeErrorGuard.restore()
      setSnapshot(next)
    }
    const resetForLoad = () => {
      nativeErrorGuard.restore()
      setInteractionError(null)
      sync()
    }
    const clearInteractionError = () => {
      setInteractionError(null)
      syncWithNativeErrorGuard()
    }
    const reportMediaError = () => {
      // Keep the browser's real media error and event propagation intact. This
      // copy only gives the custom controls an English, actionable status.
      setInteractionError('Media could not be loaded.')
      syncWithNativeErrorGuard()
    }
    const events: Array<[string, EventListener]> = [
      ['loadstart', resetForLoad],
      ['emptied', syncWithNativeErrorGuard],
      ['loadedmetadata', clearInteractionError],
      ['durationchange', syncWithNativeErrorGuard],
      ['progress', syncWithNativeErrorGuard],
      ['timeupdate', syncWithNativeErrorGuard],
      ['play', clearInteractionError],
      ['playing', clearInteractionError],
      ['pause', syncWithNativeErrorGuard],
      ['volumechange', syncWithNativeErrorGuard],
      ['ended', syncWithNativeErrorGuard],
      ['error', reportMediaError],
    ]
    for (const [event, listener] of events) media.addEventListener(event, listener)
    syncWithNativeErrorGuard()

    const onFullscreenChange = () => sync()
    if (typeof document !== 'undefined' && fullscreenRef) document.addEventListener('fullscreenchange', onFullscreenChange)

    return () => {
      for (const [event, listener] of events) media.removeEventListener(event, listener)
      if (typeof document !== 'undefined' && fullscreenRef) document.removeEventListener('fullscreenchange', onFullscreenChange)
      nativeErrorGuard.restore()
    }
  }, [mediaRef, fullscreenRef])

  const media = mediaRef.current
  const usable = snapshot.ready && !snapshot.error
  const seekable = usable && Number.isFinite(snapshot.duration) && snapshot.duration > 0
  const current = seekable ? clamp(snapshot.currentTime, 0, snapshot.duration) : 0
  const timeLabel = snapshot.duration === Infinity
    ? `${formatMediaTime(snapshot.currentTime)} / Live`
    : snapshot.duration > 0
      ? `${formatMediaTime(current)} / ${formatMediaTime(snapshot.duration)}`
      : '—'
  const classes = ['media-playback-controls', className].filter(Boolean).join(' ')
  const errorMessage = interactionError ?? (snapshot.error ? 'Media could not be loaded.' : null)
  const stopPropagation = (event: SyntheticEvent): void => {
    event.stopPropagation()
  }

  function togglePlayback(): void {
    if (!media || !usable) return
    if (media.paused) {
      const result = media.play()
      void result.catch(() => {
        // The media element keeps its native error state/events; this only
        // prevents an unhandled promise while explaining the failed action.
        setInteractionError('Could not play this media.')
        setSnapshot(snapshotFor(media, fullscreenRef))
      })
    } else {
      media.pause()
    }
  }

  function seek(value: string): void {
    if (!media || !seekable) return
    const next = Number(value)
    if (!Number.isFinite(next)) return
    try {
      media.currentTime = clamp(next, 0, snapshot.duration)
      setSnapshot(snapshotFor(media, fullscreenRef))
    } catch {
      setInteractionError('Could not seek this media.')
    }
  }

  function toggleMute(): void {
    if (!media || !usable) return
    media.muted = !media.muted
    setSnapshot(snapshotFor(media, fullscreenRef))
  }

  function changeVolume(value: string): void {
    if (!media || !usable) return
    const next = Number(value)
    if (!Number.isFinite(next)) return
    media.volume = clamp(next, 0, 1)
    if (media.volume > 0) media.muted = false
    setSnapshot(snapshotFor(media, fullscreenRef))
  }

  function toggleFullscreen(): void {
    const element = fullscreenRef?.current
    if (!element) return
    if (typeof document !== 'undefined' && document.fullscreenElement === element) {
      if (typeof document.exitFullscreen !== 'function') return
      try {
        void document.exitFullscreen().catch(() => setInteractionError('Could not exit full screen.'))
      } catch {
        setInteractionError('Could not exit full screen.')
      }
      return
    }
    if (typeof element.requestFullscreen === 'function') {
      try {
        void element.requestFullscreen().catch(() => setInteractionError('Could not enter full screen.'))
      } catch {
        setInteractionError('Could not enter full screen.')
      }
    }
  }

  return (
    <div
      className={`${classes} nodrag nopan nowheel`}
      role="group"
      aria-label="Media playback controls"
      data-ready={usable ? 'true' : 'false'}
      onPointerDown={stopPropagation}
      onClick={stopPropagation}
      onDoubleClick={stopPropagation}
      onKeyDown={stopPropagation}
      onKeyUp={stopPropagation}
    >
      <button
        type="button"
        className="media-playback-button"
        onClick={togglePlayback}
        disabled={!usable}
        aria-label={snapshot.paused ? 'Play' : 'Pause'}
        title={snapshot.paused ? 'Play' : 'Pause'}
      >
        {snapshot.paused ? 'Play' : 'Pause'}
      </button>
      {showSeek && <>
        <input
          className="media-playback-seek"
          type="range"
          min={0}
          max={seekable ? snapshot.duration : 0}
          step={0.01}
          value={current}
          onChange={(event) => seek(event.target.value)}
          disabled={!seekable}
          aria-label={snapshot.duration === Infinity ? 'Seek live media' : 'Seek'}
          aria-valuetext={timeLabel}
        />
        <output className="media-playback-time" aria-label="Playback time">{timeLabel}</output>
      </>}
      <button
        type="button"
        className="media-playback-button"
        onClick={toggleMute}
        disabled={!usable}
        aria-label={snapshot.muted ? 'Unmute' : 'Mute'}
        title={snapshot.muted ? 'Unmute' : 'Mute'}
      >
        {snapshot.muted ? 'Unmute' : 'Mute'}
      </button>
      <input
        className="media-playback-volume"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={snapshot.volume}
        onChange={(event) => changeVolume(event.target.value)}
        disabled={!usable}
        aria-label="Volume"
      />
      {fullscreenRef && (
        <button
          type="button"
          className="media-playback-button"
          onClick={toggleFullscreen}
          disabled={!usable}
          aria-label={snapshot.fullscreen ? 'Exit full screen' : 'Full screen'}
          title={snapshot.fullscreen ? 'Exit full screen' : 'Full screen'}
        >
          {snapshot.fullscreen ? 'Exit full screen' : 'Full screen'}
        </button>
      )}
      {errorMessage && <span className="media-playback-error" role="alert">{errorMessage}</span>}
    </div>
  )
}

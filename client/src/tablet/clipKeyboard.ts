import type { TimelineSession } from '../spaces/canvas/timeline/useTimelineSession'
import { MIN_PIECE_S, seamBounds } from '../spaces/canvas/timeline/timelineModel'

export type TrackHandle = 'in' | 'out' | 'head' | 'cut'
export type TrackKeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'preventDefault' | 'stopPropagation'>
export function trackBounds(session: TimelineSession, kind: TrackHandle, at: number) {
  const duration = session.facts?.duration ?? 0
  if (kind === 'in') return { low: 0, high: Math.max(0, session.outPoint - MIN_PIECE_S) }
  if (kind === 'out') return { low: Math.min(duration, session.inPoint + MIN_PIECE_S), high: duration }
  if (kind === 'cut') return seamBounds(at, session.cuts.map(cut => cut.time), session.inPoint, session.outPoint)
  return { low: session.inPoint, high: session.outPoint }
}

export const trackTimeText = (time: number) => `${time.toFixed(2)} s`

export function handleTrackKey(event: TrackKeyEvent, session: TimelineSession, kind: TrackHandle, at: number, seek: (time: number) => void): void {
  if (event.ctrlKey || event.altKey || event.metaKey || session.busy || session.loading) return
  if (kind === 'cut' && (event.key === 'Delete' || event.key === 'Backspace')) {
    event.preventDefault()
    event.stopPropagation()
    session.removeCut(at)
    return
  }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  if (!(session.facts && session.facts.duration > 0)) return
  const fps = session.facts.fps && session.facts.fps > 0 && Number.isFinite(session.facts.fps) ? session.facts.fps : 25
  const step = (event.shiftKey ? 10 : 1) / fps
  const bounds = trackBounds(session, kind, at)
  const raw = event.key === 'Home' ? bounds.low : event.key === 'End' ? bounds.high
    : at + (event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step : step)
  const next = Math.max(bounds.low, Math.min(bounds.high, raw))
  event.preventDefault()
  event.stopPropagation()
  if (kind === 'in') session.moveIn(next)
  else if (kind === 'out') session.moveOut(next)
  else if (kind === 'cut') session.moveCut(at, next)
  else seek(next)
}

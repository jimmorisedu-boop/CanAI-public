import { clamp } from './timelineModel'

// Чистая математика масштабирования таймлайна по времени (Alt + колесо),
// панорамирования видимого окна, магнитного прилипания и адаптивной линейки.

export interface TimeWindow {
  start: number
  end: number
}

export interface RulerTick {
  time: number
  major: boolean
  label?: string
}

export const MIN_WINDOW_SPAN_S = 1
export const MAX_TIME_ZOOM = 16
export const SNAP_THRESHOLD_PX = 6

function safeDuration(duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? duration : 1
}

export function maxTimeZoom(duration: number): number {
  const safe = safeDuration(duration)
  if (safe <= MIN_WINDOW_SPAN_S) return 1
  return Math.min(MAX_TIME_ZOOM, safe / MIN_WINDOW_SPAN_S)
}

export function fullTimeWindow(duration: number): TimeWindow {
  return { start: 0, end: safeDuration(duration) }
}

export function timeZoomFactor(window: TimeWindow, duration: number): number {
  const safe = safeDuration(duration)
  const span = Math.max(1e-6, window.end - window.start)
  return Math.max(1, safe / span)
}

export function isWindowZoomed(window: TimeWindow, duration: number): boolean {
  return timeZoomFactor(window, duration) > 1.01
}

/** Приближение (`factor > 1`) или отдаление (`factor < 1`) вокруг `anchorTime`. */
export function zoomTimeWindow(
  window: TimeWindow,
  duration: number,
  factor: number,
  anchorTime: number,
): TimeWindow {
  const safe = safeDuration(duration)
  const minSpan = safe / maxTimeZoom(safe)
  const currentSpan = clamp(window.end - window.start, minSpan, safe)
  if (!Number.isFinite(factor) || factor <= 0) return { start: 0, end: safe }

  const anchor = clamp(anchorTime, 0, safe)
  const ratio = currentSpan > 0 ? clamp((anchor - window.start) / currentSpan, 0, 1) : 0.5
  const nextSpan = clamp(currentSpan / factor, minSpan, safe)

  if (nextSpan >= safe - 1e-6) {
    return { start: 0, end: safe }
  }
  const start = clamp(anchor - ratio * nextSpan, 0, safe - nextSpan)
  return { start, end: start + nextSpan }
}

export function panTimeWindow(window: TimeWindow, duration: number, deltaSeconds: number): TimeWindow {
  const safe = safeDuration(duration)
  const span = clamp(window.end - window.start, 1e-6, safe)
  if (span >= safe - 1e-6) return { start: 0, end: safe }
  const start = clamp(window.start + deltaSeconds, 0, safe - span)
  return { start, end: start + span }
}

/** Перелистывает окно (page-follow), только когда голова выходит за видимые края. */
export function followHeadInWindow(window: TimeWindow, duration: number, head: number): TimeWindow {
  const safe = safeDuration(duration)
  const span = clamp(window.end - window.start, 1e-6, safe)
  if (span >= safe - 1e-6) return { start: 0, end: safe }
  const target = clamp(head, 0, safe)
  if (target >= window.start && target <= window.end) return window

  const start = target > window.end
    ? clamp(target - span * 0.15, 0, safe - span)
    : clamp(target - span * 0.85, 0, safe - span)
  return { start, end: start + span }
}

export function timeToWindowPercent(time: number, window: TimeWindow): number {
  const span = Math.max(1e-6, window.end - window.start)
  return ((time - window.start) / span) * 100
}

export function windowRatioToTime(ratio: number, window: TimeWindow, duration: number): number {
  const safe = safeDuration(duration)
  const r = clamp(ratio, 0, 1)
  return clamp(window.start + r * (window.end - window.start), 0, safe)
}

export function snapTimelineTime(
  rawTime: number,
  targets: readonly number[],
  window: TimeWindow,
  trackWidthPx: number,
  bypass: boolean,
  snapPx: number = SNAP_THRESHOLD_PX,
): { time: number; snapped: boolean } {
  if (bypass || trackWidthPx <= 0 || targets.length === 0) {
    return { time: rawTime, snapped: false }
  }
  const span = Math.max(1e-6, window.end - window.start)
  const threshold = (snapPx / trackWidthPx) * span
  let bestTime = rawTime
  let bestDist = threshold + 1
  for (const target of targets) {
    const dist = Math.abs(target - rawTime)
    if (dist <= threshold && dist < bestDist) {
      bestDist = dist
      bestTime = target
    }
  }
  return bestDist <= threshold
    ? { time: bestTime, snapped: true }
    : { time: rawTime, snapped: false }
}

function formatTickLabel(seconds: number, subSecond: boolean): string {
  const total = Math.max(0, seconds)
  const mins = Math.floor(total / 60)
  const rem = total - mins * 60
  if (subSecond) {
    const fixed = rem.toFixed(1).padStart(4, '0')
    return `${mins}:${fixed}`
  }
  const whole = Math.round(rem).toString().padStart(2, '0')
  return `${mins}:${whole}`
}

const MAJOR_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]

export function rulerTicksForWindow(window: TimeWindow, trackWidthPx: number): RulerTick[] {
  const span = Math.max(0.05, window.end - window.start)
  const width = trackWidthPx > 0 ? trackWidthPx : 800
  const majorStep = MAJOR_STEPS.find((step) => (step / span) * width >= 72) ?? MAJOR_STEPS[MAJOR_STEPS.length - 1]
  const subdivisions = majorStep === 0.2 || majorStep === 2 || majorStep === 30 ? 2 : 5
  const minorStep = majorStep / subdivisions
  const subSecond = majorStep < 1

  const firstIndex = Math.ceil((window.start - 1e-6) / minorStep)
  const lastIndex = Math.floor((window.end + 1e-6) / minorStep)
  const ticks: RulerTick[] = []
  for (let idx = firstIndex; idx <= lastIndex; idx++) {
    const time = Number((idx * minorStep).toFixed(4))
    if (time < window.start - 1e-5 || time > window.end + 1e-5) continue
    const major = idx % subdivisions === 0
    ticks.push({
      time,
      major,
      label: major ? formatTickLabel(time, subSecond) : undefined,
    })
  }
  return ticks
}

export function slicePeaksForWindow(
  peaks: readonly number[],
  window: TimeWindow,
  duration: number,
  barCount: number,
): number[] {
  if (peaks.length === 0 || barCount < 1) return []
  const safe = safeDuration(duration)
  const count = Math.floor(barCount)
  const span = Math.max(1e-6, window.end - window.start)
  const out: number[] = []

  for (let i = 0; i < count; i++) {
    const t0 = clamp(window.start + (i / count) * span, 0, safe)
    const t1 = clamp(window.start + ((i + 1) / count) * span, 0, safe)
    const idx0 = Math.floor((t0 / safe) * peaks.length)
    const idx1 = Math.max(idx0 + 1, Math.ceil((t1 / safe) * peaks.length))
    let maxPeak = 0
    for (let j = Math.max(0, idx0); j < Math.min(peaks.length, idx1); j++) {
      if (peaks[j] > maxPeak) maxPeak = peaks[j]
    }
    out.push(clamp(maxPeak, 0, 100))
  }
  return out
}

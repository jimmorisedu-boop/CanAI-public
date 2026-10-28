import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  followHeadInWindow,
  fullTimeWindow,
  isWindowZoomed,
  panTimeWindow,
  timeZoomFactor,
  windowRatioToTime,
  zoomTimeWindow,
  type TimeWindow,
} from './timelineTimeZoom'

export interface TimelineTimeZoomController {
  window: TimeWindow
  zoomFactor: number
  zoomed: boolean
  resetZoom(): void
  setWindowRange(next: TimeWindow): void
}

/**
 * Масштабирование таймлайна по времени (`Alt + колесо`) и панорамирование
 * увеличенного окна обычным колесом над дорожкой.
 */
export function useTimelineTimeZoom(
  overlayRef: RefObject<HTMLElement | null>,
  trackRef: RefObject<HTMLElement | null>,
  duration: number,
  head: number,
): TimelineTimeZoomController {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 1
  const [window, setWindow] = useState<TimeWindow>(() => fullTimeWindow(safeDuration))
  const windowRef = useRef<TimeWindow>(window)
  const latestRef = useRef({ duration: safeDuration, head })
  latestRef.current = { duration: safeDuration, head }

  const applyWindow = useCallback((next: TimeWindow) => {
    windowRef.current = next
    setWindow(next)
  }, [])

  // Смена клипа или чтение настоящей длительности сбрасывает окно на весь ролик.
  useEffect(() => {
    applyWindow(fullTimeWindow(safeDuration))
  }, [safeDuration, applyWindow])

  // Когда курсор уходит за край увеличенного окна (при Play или стрелках) — перелистываем окно.
  useEffect(() => {
    const current = windowRef.current
    const next = followHeadInWindow(current, safeDuration, head)
    if (next.start !== current.start || next.end !== current.end) {
      applyWindow(next)
    }
  }, [head, safeDuration, applyWindow])

  const resetZoom = useCallback(() => {
    applyWindow(fullTimeWindow(latestRef.current.duration))
  }, [applyWindow])

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return

    const onWheel = (event: WheelEvent) => {
      const { duration: dur, head: currentHead } = latestRef.current
      const current = windowRef.current
      const track = trackRef.current
      const rect = track?.getBoundingClientRect()
      const overTrack = Boolean(
        track && event.target instanceof Node && track.contains(event.target),
      )

      if (event.altKey) {
        event.preventDefault()
        let delta = event.deltaY !== 0 ? event.deltaY : event.deltaX
        if (event.deltaMode === 1) delta *= 16
        else if (event.deltaMode === 2) delta *= 60
        if (delta === 0) return

        const factor = delta < 0 ? 1.22 : 1 / 1.22
        const pointerOverTrackX = Boolean(
          rect && rect.width > 2 && event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top - 24 && event.clientY <= rect.bottom + 24,
        )
        const anchor = pointerOverTrackX && rect
          ? windowRatioToTime((event.clientX - rect.left) / rect.width, current, dur)
          : currentHead
        applyWindow(zoomTimeWindow(current, dur, factor, anchor))
        return
      }

      if (overTrack && isWindowZoomed(current, dur)) {
        event.preventDefault()
        let delta = event.deltaX !== 0 ? event.deltaX : event.deltaY
        if (event.deltaMode === 1) delta *= 16
        else if (event.deltaMode === 2) delta *= 60
        if (delta === 0) return
        const width = rect && rect.width > 2 ? rect.width : 800
        const span = current.end - current.start
        const deltaSeconds = (delta / width) * span * 0.65
        applyWindow(panTimeWindow(current, dur, deltaSeconds))
      }
    }

    overlay.addEventListener('wheel', onWheel, { passive: false })
    return () => overlay.removeEventListener('wheel', onWheel)
  }, [overlayRef, trackRef, applyWindow])

  return {
    window,
    zoomFactor: timeZoomFactor(window, safeDuration),
    zoomed: isWindowZoomed(window, safeDuration),
    resetZoom,
    setWindowRange: applyWindow,
  }
}

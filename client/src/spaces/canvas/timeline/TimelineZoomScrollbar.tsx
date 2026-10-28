import { useRef } from 'react'
import { beginPointerDrag } from './timelineDrag'
import { clamp } from './timelineModel'
import type { TimelineTimeZoomController } from './useTimelineTimeZoom'
import { useT } from '../../../i18n/context.js'

// Мини-полоса обзора всего ролика под увеличенной дорожкой: показывает, какая
// часть клипа сейчас на экране, и позволяет перетаскивать окно времени.

export function TimelineZoomScrollbar({
  duration,
  head,
  cuts,
  timeZoom,
}: {
  duration: number
  head: number
  cuts: readonly number[]
  timeZoom: TimelineTimeZoomController
}) {
  const t = useT()
  const barRef = useRef<HTMLDivElement>(null)
  const safe = duration > 0 ? duration : 1
  const { window: win } = timeZoom
  const span = Math.max(1e-6, win.end - win.start)
  const leftPct = clamp((win.start / safe) * 100, 0, 100)
  const widthPct = clamp((span / safe) * 100, 2, 100)
  const headPct = clamp((head / safe) * 100, 0, 100)

  function onPointerDown(event: React.PointerEvent): void {
    const bar = barRef.current
    if (!bar) return
    const moveTo = (clientX: number) => {
      const rect = bar.getBoundingClientRect()
      if (rect.width <= 2) return
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
      const center = ratio * safe
      const currentSpan = Math.max(1e-6, timeZoom.window.end - timeZoom.window.start)
      const start = clamp(center - currentSpan / 2, 0, Math.max(0, safe - currentSpan))
      timeZoom.setWindowRange({ start, end: start + currentSpan })
    }
    beginPointerDrag(event, (moveEvent) => moveTo(moveEvent.clientX), () => undefined)
    moveTo(event.clientX)
  }

  return (
    <div
      className="tl-zoom-bar"
      ref={barRef}
      role="group"
      aria-label={t('Visible timeline range')}
      onPointerDown={onPointerDown}
    >
      {cuts.map((cut) => (
        <span
          key={`zb-cut-${cut}`}
          className="tl-zoom-bar-cut"
          style={{ left: `${clamp((cut / safe) * 100, 0, 100)}%` }}
        />
      ))}
      <span className="tl-zoom-bar-head" style={{ left: `${headPct}%` }} />
      <div
        className="tl-zoom-bar-thumb"
        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      />
    </div>
  )
}

import { useMemo, useRef, useState, type RefObject } from 'react'
import { Tooltip } from '../../../ui/Tooltip'
import type { FrameCaptureRecord } from './frameCaptureQueue'
import { beginPointerDrag } from './timelineDrag'
import { clamp, segmentAt } from './timelineModel'
import { frameStatusText, isBusyPhase } from './timelineStatus'
import { timecode } from './timelineTimecode'
import {
  rulerTicksForWindow,
  slicePeaksForWindow,
  snapTimelineTime,
  timeToWindowPercent,
  windowRatioToTime,
} from './timelineTimeZoom'
import { TimelineZoomScrollbar } from './TimelineZoomScrollbar'
import type { TimelineSession } from './useTimelineSession'
import type { TimelineTimeZoomController } from './useTimelineTimeZoom'
import { filmstripCellCount, useFilmstrip } from './useFilmstrip'
import { useTrackSize } from './useTrackSize'
import { useT } from '../../../i18n/context.js'

// Двухэтажная дорожка по закону руления (Steering Law) и закону Фиттса:
// 1) верхний чистый рельс линейки (28px) — для свободной протяжки курсора без
//    риска случайно схватить рез или скобу края;
// 2) высокая плёнка кадров (62px) с реальной аудиоволной речи, ухватистыми
//    скобами [ In / Out ], карточками кусков и перетаскиваемыми склейками.

const REMOVE_DROP_PX = 20

export function TimelineTrack({
  session,
  trackRef,
  timeZoom,
  peaks,
  frames,
  selectedFrameId,
  playing,
  onPause,
  onPreview,
  onSelectFrame,
}: {
  session: TimelineSession
  trackRef: RefObject<HTMLDivElement>
  timeZoom: TimelineTimeZoomController
  peaks: readonly number[]
  frames: readonly FrameCaptureRecord[]
  selectedFrameId: string | null
  playing: boolean
  onPause(): void
  onPreview(time: number | null): void
  onSelectFrame(record: FrameCaptureRecord): void
}) {
  const t = useT()
  const sessionRef = useRef(session)
  sessionRef.current = session
  const zoomRef = useRef(timeZoom)
  zoomRef.current = timeZoom

  const [dragCut, setDragCut] = useState<{ at: number; removing: boolean } | null>(null)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [snapped, setSnapped] = useState(false)

  const { facts, inPoint, outPoint, head, cuts } = session
  const duration = facts?.duration || 1
  const win = timeZoom.window

  const size = useTrackSize(trackRef)
  const aspect = facts?.width && facts?.height ? facts.width / facts.height : undefined
  const cellCount = filmstripCellCount(size.width, size.height, aspect ?? 16 / 9)
  const filmstrip = useFilmstrip(session.item.src, facts?.duration ?? 0, cellCount, aspect, win)

  const cutTimes = useMemo(() => cuts.map((cut) => cut.time), [cuts])
  const snapTargets = useMemo(
    () => [inPoint, outPoint, ...cutTimes, ...frames.map((f) => f.requestedTime)],
    [inPoint, outPoint, cutTimes, frames],
  )
  const ticks = useMemo(() => rulerTicksForWindow(win, size.width), [win, size.width])
  const barCount = Math.max(48, Math.min(160, Math.round((size.width || 800) / 6)))
  const waveBars = useMemo(
    () => slicePeaksForWindow(peaks, win, duration, barCount),
    [peaks, win, duration, barCount],
  )

  function rawTimeAt(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return 0
    return windowRatioToTime((clientX - rect.left) / rect.width, zoomRef.current.window, duration)
  }

  function snappedTimeAt(clientX: number, altKey: boolean): number {
    const raw = rawTimeAt(clientX)
    const width = trackRef.current?.getBoundingClientRect().width ?? 0
    const res = snapTimelineTime(raw, snapTargets, zoomRef.current.window, width, altKey)
    setSnapped(res.snapped)
    return res.time
  }

  function pct(time: number): number {
    return timeToWindowPercent(time, win)
  }

  function clampedPct(time: number): string {
    return `${clamp(pct(time), 0, 100)}%`
  }

  function scrub(event: React.PointerEvent): void {
    onPause()
    setHoverTime(null)
    beginPointerDrag(
      event,
      (moveEvent) => sessionRef.current.setHead(snappedTimeAt(moveEvent.clientX, moveEvent.altKey)),
      () => setSnapped(false),
    )
    sessionRef.current.setHead(snappedTimeAt(event.clientX, event.altKey))
  }

  function dragEdge(event: React.PointerEvent, edge: 'in' | 'out'): void {
    event.stopPropagation()
    const apply = (moveEvent: PointerEvent) => {
      const time = rawTimeAt(moveEvent.clientX)
      if (edge === 'in') sessionRef.current.moveIn(time)
      else sessionRef.current.moveOut(time)
      onPreview(time)
    }
    beginPointerDrag(event, apply, () => onPreview(null))
    apply(event.nativeEvent)
  }

  function dragSeam(event: React.PointerEvent, cut: number): void {
    event.stopPropagation()
    const rect = trackRef.current?.getBoundingClientRect()
    let current = cut
    let removing = false
    setDragCut({ at: cut, removing: false })

    beginPointerDrag(
      event,
      (moveEvent) => {
        removing = Boolean(rect) && moveEvent.clientY > rect!.bottom + REMOVE_DROP_PX
        if (!removing) {
          current = sessionRef.current.moveCut(current, rawTimeAt(moveEvent.clientX))
        }
        setDragCut({ at: current, removing })
        onPreview(removing ? null : current)
      },
      () => {
        if (removing) sessionRef.current.removeCut(current)
        setDragCut(null)
        onPreview(null)
      },
    )
  }

  const seams = dragCut?.removing ? cutTimes.filter((time) => time !== dragCut.at) : cutTimes
  const activeSeg = segmentAt(session.segments, head)
  const activeSegIndex = activeSeg ? session.segments.findIndex((s) => s.start === activeSeg.start) : -1
  const activeDropped = Boolean(activeSeg && session.dropped.includes(activeSeg.start))
  const inVisible = inPoint >= win.start - 1e-4 && inPoint <= win.end + 1e-4
  const outVisible = outPoint >= win.start - 1e-4 && outPoint <= win.end + 1e-4
  const headVisible = head >= win.start - 1e-4 && head <= win.end + 1e-4
  const leftCurtainW = clamp(pct(inPoint), 0, 100)
  const rightCurtainLeft = clamp(pct(outPoint), 0, 100)

  return (
    <section className="tl-track-block" aria-label={t('Clip timeline')}>
      <div className="tl-track-head">
        <div className="tl-track-meta">
          {activeSeg && (
            <span className={`tl-seg-status${activeDropped ? ' is-dropped' : ''}`}>
              {t('Segment #{0} of {1} · {2} s', {
                0: activeSegIndex + 1,
                1: session.segments.length,
                2: (activeSeg.end - activeSeg.start).toFixed(1),
              })}
              {activeDropped ? ` · ${t('removed (X — restore)')}` : ''}
            </span>
          )}
          <span className="tl-track-hint">{t('↑↓ cuts · Shift+←→ 10 frames · Alt+scroll zoom')}</span>
        </div>

        <div className="tl-track-zoom">
          {timeZoom.zoomed ? (
            <button
              type="button"
              className="tl-zoom-pill is-active"
              onClick={timeZoom.resetZoom}
              title={t('Reset timeline zoom to full clip')}
            >
              {`${timeZoom.zoomFactor.toFixed(1)}× · ${t('Fit clip')}`}
            </button>
          ) : (
            <span className="tl-zoom-pill">{`1.0× · ${t('Alt+scroll')}`}</span>
          )}
        </div>
      </div>

      <div className={`tl-track-stage${playing ? ' is-playing' : ''}${snapped ? ' is-snapped' : ''}`}>
        {/* 1 этаж: чистый рельс перемотки со шкалой времени и флажками кадров */}
        <div
          className="tl-ruler"
          onPointerDown={scrub}
          onPointerMove={(e) => { if (e.buttons === 0) setHoverTime(rawTimeAt(e.clientX)) }}
          onPointerLeave={() => setHoverTime(null)}
        >
          {ticks.map((tick) => (
            <span
              key={`t-${tick.time}`}
              className={`tl-tick${tick.major ? ' major' : ''}`}
              style={{ left: `${pct(tick.time)}%` }}
            >
              {tick.label && <span className="tl-tick-label">{tick.label}</span>}
            </span>
          ))}

          {hoverTime !== null && hoverTime >= win.start && hoverTime <= win.end && (
            <div className="tl-hover-ghost" style={{ left: `${pct(hoverTime)}%` }} aria-hidden="true">
              <span className="tl-hover-pill">{timecode(hoverTime)}</span>
            </div>
          )}

          <div className="tl-marks">
            {frames
              .filter((record) => record.requestedTime >= win.start - 1e-4 && record.requestedTime <= win.end + 1e-4)
              .map((record) => (
                <Tooltip
                  key={record.id}
                  title={t('Frame {0}', { 0: timecode(record.requestedTime) })}
                  hint={frameStatusText(record)}
                  placement="top"
                  hostClassName="tl-mark-host"
                  hostStyle={{ left: `${pct(record.requestedTime)}%` }}
                >
                  <button
                    type="button"
                    className={`tl-mark${record.id === selectedFrameId ? ' is-selected' : ''}`}
                    data-phase={isBusyPhase(record.phase) ? 'busy' : record.phase}
                    aria-label={t('Frame {0} — {1}', { 0: timecode(record.requestedTime), 1: frameStatusText(record) })}
                    aria-current={record.id === selectedFrameId ? 'true' : undefined}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onSelectFrame(record)}
                  />
                </Tooltip>
              ))}
          </div>
        </div>

        {/* 2 этаж: высокая плёнка кадров + аудиоволна речи + куски и скобы [ ] */}
        <div
          className="tl-track"
          ref={trackRef}
          role="slider"
          aria-label={t('Position in clip')}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration * 1000) / 1000}
          aria-valuenow={Math.round(head * 1000) / 1000}
          aria-valuetext={timecode(head)}
          tabIndex={0}
          onPointerDown={scrub}
        >
          <div className="tl-film">
            <div className="tl-film-cells" aria-hidden="true">
              {filmstrip.cells.map((url, index) => (
                <span key={index} className="tl-film-cell">
                  {url && <img src={url} alt="" draggable={false} />}
                </span>
              ))}
            </div>

            {waveBars.length > 0 && (
              <div className="tl-waveform" aria-hidden="true">
                {waveBars.map((peak, idx) => (
                  <span
                    key={idx}
                    className="tl-wave-bar"
                    style={{ height: `${Math.max(10, peak)}%` }}
                  />
                ))}
              </div>
            )}

            {leftCurtainW > 0 && <div className="tl-dim" style={{ left: 0, width: `${leftCurtainW}%` }} aria-hidden="true" />}
            {rightCurtainLeft < 100 && <div className="tl-dim" style={{ left: `${rightCurtainLeft}%`, right: 0 }} aria-hidden="true" />}

            {session.segments.map((segment, index) => {
              const visStart = Math.max(win.start, segment.start)
              const visEnd = Math.min(win.end, segment.end)
              if (visEnd <= visStart) return null
              const leftP = clamp(pct(visStart), 0, 100)
              const widthP = clamp(pct(visEnd) - leftP, 0, 100 - leftP)
              const widthPx = ((widthP / 100) * (size.width || 800))
              const isDropped = session.dropped.includes(segment.start)
              const isCurrent = activeSeg?.start === segment.start
              return (
                <div
                  key={`seg-${segment.start}`}
                  className={`tl-seg-card${isCurrent ? ' is-current' : ''}${isDropped ? ' is-dropped' : ''}`}
                  style={{ left: `${leftP}%`, width: `${widthP}%` }}
                >
                  {isDropped && <div className="tl-gone" aria-hidden="true" />}
                  {widthPx >= 64 && (
                    <span className="tl-segno" aria-hidden="true">
                      {`#${index + 1} · ${(segment.end - segment.start).toFixed(1)}s`}
                    </span>
                  )}
                  {session.segments.length > 1 && widthPx >= 88 && (
                    <button
                      type="button"
                      className="tl-seg-toggle"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation()
                        session.toggleDropAt(segment.start)
                      }}
                    >
                      {isDropped ? t('Restore') : t('Remove')}
                    </button>
                  )}
                </div>
              )
            })}

            {seams
              .filter((cut) => cut >= win.start && cut <= win.end)
              .map((cut) => (
                <div key={`seam-${cut}`} className="tl-seam" style={{ left: `${pct(cut)}%` }} aria-hidden="true" />
              ))}
          </div>

          {inVisible && (
            <div
              className="tl-grip in"
              style={{ left: clampedPct(inPoint) }}
              role="button"
              aria-label={t('Trim start (I)')}
              onPointerDown={(event) => dragEdge(event, 'in')}
            />
          )}
          {outVisible && (
            <div
              className="tl-grip out"
              style={{ left: clampedPct(outPoint) }}
              role="button"
              aria-label={t('Trim end (O)')}
              onPointerDown={(event) => dragEdge(event, 'out')}
            />
          )}

          {cuts
            .filter((cut) => cut.time >= win.start - 1e-4 && cut.time <= win.end + 1e-4)
            .map((cut) => (
              <Tooltip
                key={`cut-${cut.time}`}
                title={cut.auto ? t('Cut found automatically') : t('Edit cut')}
                hint={t('Drag sideways to move, down to remove · double-click removes')}
                placement="top"
                hostClassName={`tl-cut-host${dragCut?.at === cut.time ? ' is-dragging' : ''}`}
                hostStyle={{ left: `${pct(cut.time)}%` }}
              >
                <div
                  className={`tl-cut${cut.auto ? ' auto' : ''}${dragCut?.removing && dragCut.at === cut.time ? ' removing' : ''}`}
                  role="button"
                  aria-label={t('{0} at {1}', { 0: 'Cut', 1: timecode(cut.time) })}
                  onPointerDown={(event) => dragSeam(event, cut.time)}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    session.removeCut(cut.time)
                  }}
                />
              </Tooltip>
            ))}
        </div>

        {/* Сквозная головка воспроизведения с ухватистым колпачком на рельсе */}
        {headVisible && (
          <div className="tl-head" style={{ left: clampedPct(head) }}>
            <div className="tl-head-cap" onPointerDown={scrub} />
          </div>
        )}
      </div>

      {timeZoom.zoomed && (
        <TimelineZoomScrollbar
          duration={duration}
          head={head}
          cuts={cutTimes}
          timeZoom={timeZoom}
        />
      )}
    </section>
  )
}

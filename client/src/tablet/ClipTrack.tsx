import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { TimelineSession } from '../spaces/canvas/timeline/useTimelineSession'
import { handleTrackKey, trackBounds, trackTimeText, type TrackHandle } from './clipKeyboard'
import { useFilmstrip } from '../spaces/canvas/timeline/useFilmstrip'

// Дорожка клипа под палец.
//
// Рез нарисован СТЫКОМ, а не чертой: дорожка в этом месте расходится щелью, и
// один жест отвечает на оба вопроса — вбок двигаешь границу, вниз сводишь
// куски обратно. Приём взят с компьютера целиком, здесь только размеры под
// палец: щель шире, ручки входа и выхода — настоящие ручки, а не полоски.
//
// ⚠️ Обработчики перетаскивания читают СВЕЖИЙ сеанс через ref: `session` —
// новый объект на каждый рендер, и замыкание держало бы снимок момента
// нажатия (на компьютере это уже стоило дёргающегося стыка).

const DROP_TO_MERGE_PX = 56
const FILMSTRIP_CELL_COUNT = 8

export function ClipTrack({
  session,
  onSeek,
  transport,
}: {
  session: TimelineSession
  onSeek(time: number): void
  /** Compact playback controls share the timeline headline so there is one
   * transport row and one editor timecode. */
  transport?: ReactNode
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef(session)
  sessionRef.current = session
  const drag = useRef<{ kind: 'in' | 'out' | 'head' | 'cut'; at: number; merged: boolean } | null>(null)
  const [showHelp, setShowHelp] = useState(false)

  const duration = session.facts?.duration ?? 0
  const aspect = session.facts?.width && session.facts.height
    ? session.facts.width / session.facts.height
    : 16 / 9
  // The shared filmstrip job uses one off-DOM video and a bounded number of
  // low-resolution data URLs. It cancels and releases that video whenever the
  // source, duration, or editor leaves the screen; none of these URLs enter a
  // board snapshot.
  const filmstrip = useFilmstrip(session.item.src, duration, FILMSTRIP_CELL_COUNT, aspect)
  const toTime = (event: ReactPointerEvent): number => {
    const rect = hostRef.current?.getBoundingClientRect()
    if (!rect || rect.width < 2 || duration <= 0) return 0
    return Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration))
  }
  const percent = (time: number) => (duration > 0 ? (time / duration) * 100 : 0)
  const slider = (kind: TrackHandle, at: number) => {
    const bounds = trackBounds(session, kind, at)
    return {
      role: 'slider',
      tabIndex: 0,
      'aria-valuenow': at,
      'aria-valuemin': bounds.low,
      'aria-valuemax': bounds.high,
      'aria-valuetext': trackTimeText(at),
      'aria-disabled': session.busy || session.loading,
      onKeyDown: (event: React.KeyboardEvent) => handleTrackKey(event, sessionRef.current, kind, at, onSeek),
    }
  }

  const startDrag = (kind: 'in' | 'out' | 'head' | 'cut', at: number) => (event: ReactPointerEvent) => {
    event.stopPropagation()
    if (sessionRef.current.busy) return
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    } catch {
      // Захват необязателен: жест «утащить вниз» уводит палец далеко от метки,
      // и слушатели всё равно висят на самом элементе.
    }
    drag.current = { kind, at, merged: false }
  }

  const onMove = (event: ReactPointerEvent) => {
    const current = drag.current
    if (!current) return
    const live = sessionRef.current
    if (live.busy) return
    const time = toTime(event)
    if (current.kind === 'in') {
      live.moveIn(time)
      return
    }
    if (current.kind === 'out') {
      live.moveOut(time)
      return
    }
    if (current.kind === 'head') {
      onSeek(time)
      return
    }
    const rect = hostRef.current?.getBoundingClientRect()
    const pulledDown = rect ? event.clientY - rect.bottom > DROP_TO_MERGE_PX : false
    if (pulledDown) {
      // Утащили вниз — куски сводятся обратно. Отдельной команды «склеить» из-за
      // этого не нужно.
      live.removeCut(current.at)
      drag.current = null
      return
    }
    // moveCut возвращает время, куда рез РЕАЛЬНО встал: спрашиваем сеанс, а не
    // повторяем его арифметику здесь.
    current.at = live.moveCut(current.at, time)
  }

  const endDrag = () => {
    drag.current = null
  }

  const peaks = session.facts?.hasAudio && Array.isArray(session.item.peaks) && session.item.peaks.length > 0
    ? session.item.peaks
    : null
  const filmstripReady = filmstrip.cells.some(Boolean)
  const durationLabel = duration > 0 ? trackTimeText(duration) : '—'

  return (
    <div className="tablet-clip-panel">
      <div className="tablet-track-headline">
        <span className="tablet-track-label">Timeline</span>
        <output className="tablet-track-timecode" aria-label="Playback time">
          {trackTimeText(session.head)} / {durationLabel}
        </output>
        {transport}
        <button
          type="button"
          className={`tablet-track-help${showHelp ? ' on' : ''}`}
          aria-label="Keyboard shortcuts"
          aria-expanded={showHelp}
          title="Keyboard shortcuts"
          onClick={() => setShowHelp((value) => !value)}
        >?
        </button>
      </div>
      <div
        className="tablet-track"
        ref={hostRef}
        onPointerDown={(event) => { if (!session.busy) onSeek(toTime(event)) }}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {peaks ? <div className="tablet-track-body" aria-label="Audio peaks">
          {peaks.map((value, index) => (
            <i key={index} style={{ height: `${Math.max(6, value)}%` }} />
          ))}
        </div> : filmstripReady ? <div className="tablet-track-filmstrip" aria-label="Video thumbnails">
          {filmstrip.cells.map((url, index) => (
            <span
              key={index}
              aria-hidden="true"
              className={url ? 'ready' : undefined}
              style={url ? { backgroundImage: `url("${url}")` } : undefined}
            />
          ))}
          <div className="tablet-track-filmstrip-ticks" aria-hidden="true">
            {Array.from({ length: FILMSTRIP_CELL_COUNT + 1 }, (_, index) => (
              <i key={index} style={{ left: `${(index / FILMSTRIP_CELL_COUNT) * 100}%` }}>
                <span>{index === 0 || index === FILMSTRIP_CELL_COUNT ? `${Math.round((duration * index) / FILMSTRIP_CELL_COUNT)}s` : ''}</span>
              </i>
            ))}
          </div>
        </div> : <div className="tablet-track-ruler" aria-label="Timeline ruler">
          {Array.from({ length: 11 }, (_, index) => <i key={index} style={{ left: `${index * 10}%` }}><span>{index === 0 || index === 10 ? `${Math.round((duration * index) / 10)}s` : ''}</span></i>)}
        </div>}

        <span className="tablet-track-cut in" style={{ left: `${percent(session.inPoint)}%` }} onPointerDown={startDrag('in', session.inPoint)} aria-label="Start" {...slider('in', session.inPoint)} />
        <span className="tablet-track-cut out" style={{ left: `${percent(session.outPoint)}%` }} onPointerDown={startDrag('out', session.outPoint)} aria-label="End" {...slider('out', session.outPoint)} />

        <span className="tablet-track-dim left" style={{ width: `${percent(session.inPoint)}%` }} />
        <span className="tablet-track-dim right" style={{ left: `${percent(session.outPoint)}%`, right: 0 }} />

        {/* Удалённый кусок не исчезает с дорожки: он перечёркнут, иначе не
            видно, что именно убрано, и нечем вернуть. Как на компьютере. */}
        {session.segments.filter((segment) => session.dropped.includes(segment.start)).map((segment) => (
          <span
            key={`gone-${segment.start}`}
            className="tablet-track-gone"
            style={{ left: `${percent(segment.start)}%`, width: `${percent(segment.end - segment.start)}%` }}
          />
        ))}

        {session.cuts.map((cut, index) => (
          <span
            key={index}
            className={`tablet-track-seam ${cut.auto ? 'auto' : ''}`}
            style={{ left: `${percent(cut.time)}%` }}
            onPointerDown={startDrag('cut', cut.time)}
            onDoubleClick={() => session.removeCut(cut.time)}
            aria-label={`Cut ${index + 1}`}
            {...slider('cut', cut.time)}
          />
        ))}

        <span className="tablet-track-head" style={{ left: `${percent(session.head)}%` }} onPointerDown={startDrag('head', session.head)} aria-label="Playback position" {...slider('head', session.head)} />
      </div>
      {showHelp && <div className="tablet-track-help-popover" role="note">
        Arrow keys move one frame. Shift moves 10 frames. Home and End jump to the edges. Delete removes the selected cut.
      </div>}
    </div>
  )
}

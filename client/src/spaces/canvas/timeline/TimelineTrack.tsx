import { useRef, useState } from 'react'
import { Tooltip } from '../../../ui/Tooltip'
import type { FrameCaptureRecord } from './frameCaptureQueue'
import { beginPointerDrag } from './timelineDrag'
import { frameStatusText, isBusyPhase } from './timelineStatus'
import { timecode } from './timelineTimecode'
import type { TimelineSession } from './useTimelineSession'
import { filmstripCellCount, useFilmstrip } from './useFilmstrip'
import { useTrackSize } from './useTrackSize'

// Плёнка клипа: одна полоса с кадрами по времени, а поверх неё — головка,
// монтажные резы, ручки входа/выхода и метки сохранённых кадров. Рез нарисован
// СТЫКОМ, а не чертой: дорожка в этом месте расходится щелью, и тот же жест
// отвечает на оба вопроса — вбок двигаешь границу, вниз за дорожку сводишь
// куски обратно.
//
// ⚠️ Обрезает по скруглению (`overflow: hidden`) только слой кадров. Головка,
// резы и метки выступают за полосу — клип на них не должен резать.

/** Насколько ниже дорожки надо увести указатель, чтобы рез считался убранным. */
const REMOVE_DROP_PX = 20

export function TimelineTrack({
  session,
  frames,
  selectedFrameId,
  playing,
  onPause,
  onPreview,
  onSelectFrame,
}: {
  session: TimelineSession
  frames: readonly FrameCaptureRecord[]
  selectedFrameId: string | null
  playing: boolean
  /** Взять управление у видео: протяжка и клик ведут курсор, а не плеер. */
  onPause(): void
  /** Что показывает превью, пока тянут ручку или стык (null — вернуться к голове). */
  onPreview(time: number | null): void
  onSelectFrame(record: FrameCaptureRecord): void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  // Обработчики перетаскивания живут дольше одного рендера, а session — новый
  // объект на каждый. Замыкание держало сеанс, снятый в момент pointerdown:
  // после первого же движения moveCut считал границы по УСТАРЕВШЕМУ списку
  // резов, и стык дёргался вместо того, чтобы плавно ехать за курсором.
  const sessionRef = useRef(session)
  sessionRef.current = session
  // Только ТЕКУЩЕЕ положение стыка: сравнивать с тем, за что схватились,
  // нельзя — к моменту тяги вниз стык уже уехал, и предпросмотр («щель
  // схлопнулась», «метка побледнела») переставал совпадать с меткой.
  const [dragCut, setDragCut] = useState<{ at: number; removing: boolean } | null>(null)

  const { facts, inPoint, outPoint, head, cuts } = session
  const duration = facts?.duration || 1

  // Плёнка: сколько кадров лежит по ширине — решает размер самой дорожки.
  const size = useTrackSize(trackRef)
  const aspect = facts?.width && facts?.height ? facts.width / facts.height : undefined
  const cellCount = filmstripCellCount(size.width, size.height, aspect ?? 16 / 9)
  const filmstrip = useFilmstrip(session.item.src, facts?.duration ?? 0, cellCount, aspect)

  function timeAt(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration))
  }

  function percent(time: number): string {
    return `${(time / duration) * 100}%`
  }

  /** Курсор не только ставится кликом, но и ТАЩИТСЯ: просмотр по кадрам — это
   *  протяжка, а не серия одиночных попаданий. */
  function scrub(event: React.PointerEvent): void {
    onPause()
    beginPointerDrag(event, (moveEvent) => sessionRef.current.setHead(timeAt(moveEvent.clientX)), () => undefined)
    sessionRef.current.setHead(timeAt(event.clientX))
  }

  /** Вход/выход: ручка встаёт ровно туда, куда её привели. Идёт через свежий
   *  сеанс на каждое движение: границы куска и метки удалённых кусков берутся
   *  из текущего состояния, а не из того, что было при нажатии. */
  function dragEdge(event: React.PointerEvent, edge: 'in' | 'out'): void {
    const apply = (moveEvent: PointerEvent) => {
      const time = timeAt(moveEvent.clientX)
      if (edge === 'in') sessionRef.current.moveIn(time)
      else sessionRef.current.moveOut(time)
      onPreview(time)
    }
    beginPointerDrag(event, apply, () => onPreview(null))
    apply(event.nativeEvent)
  }

  function dragSeam(event: React.PointerEvent, cut: number): void {
    const rect = trackRef.current?.getBoundingClientRect()
    // Стык двигается, поэтому «какой именно рез убрать» надо помнить по
    // последнему положению, а не по тому, за что схватились изначально.
    let current = cut
    let removing = false
    setDragCut({ at: cut, removing: false })

    beginPointerDrag(
      event,
      (moveEvent) => {
        removing = Boolean(rect) && moveEvent.clientY > rect!.bottom + REMOVE_DROP_PX
        if (!removing) {
          // Куда рез реально встал, знает сам сеанс: он же его и клампит по
          // соседям. Повторять эту арифметику здесь значило бы разъехаться с
          // ней при первой же правке.
          current = sessionRef.current.moveCut(current, timeAt(moveEvent.clientX))
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

  const cutTimes = cuts.map((cut) => cut.time)
  const seams = dragCut?.removing ? cutTimes.filter((time) => time !== dragCut.at) : cutTimes
  const edges = [inPoint, ...seams]
  // Кусок под курсором удалённым не пропадает с дорожки — он перечёркнут, иначе
  // человек не увидит, что именно убрал, и не найдёт, чем вернуть.
  const goneSegments = session.segments.filter((segment) => session.dropped.includes(segment.start))
  const trimmed = inPoint > 0.001 || outPoint < duration - 0.001

  return (
    <section className="tl-track-block" aria-label="Clip timeline">
      <div className={`tl-track-stage${playing ? ' is-playing' : ''}`}>
        <div
          className="tl-track"
          ref={trackRef}
          role="slider"
          aria-label="Position in clip"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration * 1000) / 1000}
          aria-valuenow={Math.round(head * 1000) / 1000}
          aria-valuetext={timecode(head)}
          tabIndex={0}
          onPointerDown={scrub}
        >
          {/* Слой кадров — единственное, что обрезается по скруглению. */}
          <div className="tl-film" aria-hidden="true">
            <div className="tl-film-cells">
              {filmstrip.cells.map((url, index) => (
                <span key={index} className="tl-film-cell">
                  {url && <img src={url} alt="" draggable={false} />}
                </span>
              ))}
            </div>
            <div className="tl-dim" style={{ left: 0, width: percent(inPoint) }} />
            <div className="tl-dim" style={{ left: percent(outPoint), right: 0 }} />
            {trimmed && <div className="tl-sel" style={{ left: percent(inPoint), width: percent(outPoint - inPoint) }} />}
            {goneSegments.map((segment) => (
              <div
                key={`gone-${segment.start}`}
                className="tl-gone"
                style={{ left: percent(segment.start), width: percent(segment.end - segment.start) }}
              />
            ))}
            {seams.map((cut) => (
              <div key={`seam-${cut}`} className="tl-seam" style={{ left: percent(cut) }} />
            ))}
            {seams.length > 0 && edges.map((edge, index) => (
              <div key={`no-${edge}`} className="tl-segno" style={{ left: percent(edge) }}>{index + 1}</div>
            ))}
          </div>

          <div className="tl-head" style={{ left: percent(head) }} aria-hidden="true" />
          <div className="tl-grip" style={{ left: percent(inPoint) }} onPointerDown={(event) => dragEdge(event, 'in')} />
          <div className="tl-grip" style={{ left: percent(outPoint) }} onPointerDown={(event) => dragEdge(event, 'out')} />
          {cuts.map((cut) => (
            <Tooltip
              key={`cut-${cut.time}`}
              title={cut.auto ? 'Cut found automatically' : 'Edit cut'}
              hint="Drag sideways to move, down to remove · double-click removes"
              placement="top"
              hostClassName={`tl-cut-host${dragCut?.at === cut.time ? ' is-dragging' : ''}`}
              hostStyle={{ left: percent(cut.time) }}
            >
              <div
                className={`tl-cut${cut.auto ? ' auto' : ''}${dragCut?.removing && dragCut.at === cut.time ? ' removing' : ''}`}
                role="button"
                aria-label={`${cut.auto ? 'Cut' : 'Cut'} at ${timecode(cut.time)}`}
                onPointerDown={(event) => dragSeam(event, cut.time)}
                onDoubleClick={(event) => {
                  // Двойной клик — короткий путь к тому же, что и тяга вниз.
                  // Тяга нагляднее (видно, как куски сходятся), но когда резов
                  // много, целиться в неё каждый раз утомительно.
                  event.stopPropagation()
                  session.removeCut(cut.time)
                }}
              />
            </Tooltip>
          ))}
        </div>

        {/* Метки сохранённых кадров — отдельный слой РЯДОМ с дорожкой, а не в
            ней. Внутри дорожки нажатие на метку сначала доходило до протяжки,
            та захватывала указатель, и клик по метке не срабатывал никогда. */}
        <div className="tl-marks">
          {frames.map((record) => (
            <Tooltip
              key={record.id}
              title={`Frame ${timecode(record.requestedTime)}`}
              hint={frameStatusText(record)}
              placement="top"
              hostClassName="tl-mark-host"
              hostStyle={{ left: percent(record.requestedTime) }}
            >
              <button
                type="button"
                className={`tl-mark${record.id === selectedFrameId ? ' is-selected' : ''}`}
                data-phase={isBusyPhase(record.phase) ? 'busy' : record.phase}
                aria-label={`Frame ${timecode(record.requestedTime)} — ${frameStatusText(record)}`}
                aria-current={record.id === selectedFrameId ? 'true' : undefined}
                onClick={() => onSelectFrame(record)}
              />
            </Tooltip>
          ))}
        </div>
      </div>
    </section>
  )
}

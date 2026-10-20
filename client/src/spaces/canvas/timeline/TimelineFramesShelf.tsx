import { useEffect, useRef, type Ref } from 'react'
import { IconCaretDown, IconClose, IconDownload, IconNext, IconOpenExternal, IconRefresh, IconTrash } from '../../../ui/icons'
import type { FrameCaptureRecord } from './frameCaptureQueue'
import { TimelineButton } from './TimelineButton'
import { Tooltip } from '../../../ui/Tooltip'
import { frameStatusText, frameStatusTone, framesByTime, isBusyPhase, NO_FRAMES_MESSAGE } from './timelineStatus'
import { timecode } from './timelineTimecode'
import { plural } from '../../../ui/plural'

// Полка сохранённых кадров — ОВЕРЛЕЙ внутри превью: видео при её открытии не
// сжимается и не прыгает. Закрыта: в правом нижнем углу кластер «шеврон + число
// + подпись». Открыта: панель с лентой карточек. Один и тот же шеврон служит
// и открывалкой, и закрывалкой — после закрытия фокус остаётся на нём сам, без
// ручного возврата.
//
// Список тот же, что у планшета (SavedFramesDrawer), но вид другой: компьютеру
// нужна лента карточек поверх кадра, а планшету — сетка в своём полноэкранном
// окне.

export function TimelineFramesShelf({
  records,
  selectedId,
  open,
  toggleRef,
  onToggle,
  onSelect,
  onRetry,
  onCancel,
  onRemove,
  onShow,
  onDownload,
}: {
  records: readonly FrameCaptureRecord[]
  selectedId: string | null
  open: boolean
  toggleRef: Ref<HTMLButtonElement>
  onToggle(): void
  onSelect(record: FrameCaptureRecord): void
  onRetry(id: string): void
  onCancel(id: string): void
  onRemove(id: string): void
  onShow(id: string): void
  onDownload(id: string): void
}) {
  const ordered = framesByTime(records)
  const gridRef = useRef<HTMLDivElement>(null)

  // Выбранная карточка остаётся на виду: снятый кадр или метка на дорожке
  // выбирают карточку, которая может лежать за краем ленты.
  useEffect(() => {
    const grid = gridRef.current
    if (!open || !selectedId || !grid) return
    const card = grid.querySelector<HTMLElement>(`[data-frame-id="${CSS.escape(selectedId)}"]`)
    if (!card) return
    const left = card.offsetLeft - grid.offsetLeft
    const right = left + card.offsetWidth
    if (left < grid.scrollLeft) grid.scrollLeft = left
    else if (right > grid.scrollLeft + grid.clientWidth) grid.scrollLeft = right - grid.clientWidth
  }, [open, selectedId, records.length])

  return (
    <section className="tl-shelf" data-open={open} aria-label="Saved frames">
      <div className="tl-shelf-head">
        <TimelineButton
          buttonRef={toggleRef}
          label={open ? 'Hide saved frames' : 'Show saved frames'}
          keys="B"
          shortcut="B"
          placement="top"
          expanded={open}
          className="tl-shelf-toggle"
          onClick={onToggle}
        >
          {open ? <IconCaretDown size={16} /> : <IconNext size={16} />}
        </TimelineButton>
        <span className="tl-count" aria-live="polite">
          {records.length}
          <span className="tl-sr"> {plural(records.length, ['saved frame', 'saved frames', 'saved frames'])}</span>
        </span>
        <span className="tl-shelf-context">Saved frames</span>
      </div>

      {open && (ordered.length === 0 ? (
        <p className="tl-lane-empty">{NO_FRAMES_MESSAGE}</p>
      ) : (
        <div className="tl-lane" ref={gridRef} role="list" aria-label="Saved frames">
          {ordered.map((record) => {
            const at = timecode(record.requestedTime)
            const tone = frameStatusTone(record)
            const busy = isBusyPhase(record.phase)
            const status = frameStatusText(record)
            const retryable = record.phase === 'error' || record.phase === 'cancelled'
            return (
              <article
                key={record.id}
                className={`tl-frame${record.id === selectedId ? ' is-current' : ''}`}
                data-frame-id={record.id}
                role="listitem"
                aria-label={`Frame ${at} — ${status}`}
              >
                <button
                  type="button"
                  className="tl-frame-thumb"
                  aria-label={`Return to moment ${at}`}
                  aria-current={record.id === selectedId ? 'true' : undefined}
                  onClick={() => onSelect(record)}
                >
                  {record.resultUrl
                    ? <img src={record.resultUrl} alt="" draggable={false} />
                    : <span className="tl-spinner" aria-hidden="true" />}
                  <span className="tl-frame-time">{at}</span>
                </button>
                <div className="tl-frame-info">
                  <span className="tl-frame-name">Frame {at}</span>
                  {/* Длинную причину ошибки строка обрежет многоточием — полный
                      текст в подсказке. Короткие подписи в ней не нуждаются. */}
                  {tone === 'error' ? (
                    <Tooltip title={status} placement="top">
                      <span className="tl-frame-status" data-tone={tone}>{status}</span>
                    </Tooltip>
                  ) : (
                    <span className="tl-frame-status" data-tone={tone}>{status}</span>
                  )}
                </div>
                <div className="tl-frame-actions">
                  {record.phase === 'saved' && (
                    <>
                      <TimelineButton
                        label={`Show frame ${at} on canvas`}
                        keys="G"
                        shortcut="G"
                        disabled={!record.resultItemId}
                        onClick={() => onShow(record.id)}
                      >
                        <IconOpenExternal size={16} />
                      </TimelineButton>
                      <TimelineButton
                        label={`Download frame PNG ${at}`}
                        keys="D"
                        shortcut="D"
                        disabled={!record.resultUrl}
                        onClick={() => onDownload(record.id)}
                      >
                        <IconDownload size={16} />
                      </TimelineButton>
                    </>
                  )}
                  {retryable && (
                    <TimelineButton label="Retry frame capture" onClick={() => onRetry(record.id)}>
                      <IconRefresh size={16} />
                    </TimelineButton>
                  )}
                  {busy && (
                    <TimelineButton label="Cancel frame capture" onClick={() => onCancel(record.id)}>
                      <IconClose size={16} />
                    </TimelineButton>
                  )}
                  {!busy && (
                    <TimelineButton
                      label={record.resultItemId ? 'Delete frame from canvas' : 'Remove from shelf'}
                      onClick={() => onRemove(record.id)}
                    >
                      <IconTrash size={16} />
                    </TimelineButton>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      ))}
    </section>
  )
}

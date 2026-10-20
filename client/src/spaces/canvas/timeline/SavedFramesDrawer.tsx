import { IconCamera, IconClose, IconDownload, IconRefresh, IconToCanvas, IconTrash } from '../../../ui/icons'
import type { FrameCaptureRecord } from './frameCaptureQueue'
import { systemErrorMessage } from '../../../ui/systemMessage'

// Полка снятых кадров ПЛАНШЕТА — сетка карточек в его полноэкранном окне
// правки клипа (TabletClip). На компьютере полка другая: лента карточек
// ПОВЕРХ превью, `TimelineFramesShelf` (там же правила выбора кадра и
// статусов). Каждый кадр — карточка со статусом: пока едет, видны фазы;
// готовый кадр можно показать на холсте, скачать или убрать.
//
// Focus не воруется: drawer открывается без перехвата фокуса, а закрытие
// возвращает фокус на тумблер (это делает родитель).

function timecode(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

export function isFrameBusy(record: FrameCaptureRecord): boolean {
  return record.phase === 'queued'
    || record.phase === 'seeking'
    || record.phase === 'encoding'
    || record.phase === 'uploading'
}

const STATUS_TEXT: Record<FrameCaptureRecord['phase'], string> = {
  queued: 'Queued',
  seeking: 'Finding frame…',
  encoding: 'Preparing…',
  uploading: 'Loading…',
  saved: 'Ready',
  error: 'Error',
  cancelled: 'Canceled',
}

export function SavedFramesDrawer({
  frames,
  onRetry,
  onCancel,
  onRemove,
  onShow,
  onDownload,
  onSeek,
}: {
  frames: readonly FrameCaptureRecord[]
  onRetry(id: string): void
  onCancel(id: string): void
  onRemove(id: string): void
  onShow(id: string): void
  onDownload(id: string): void
  onSeek(time: number): void
}) {
  if (frames.length === 0) {
    return (
      <div className="tl-shelf-empty">
        <IconCamera size={18} />
        Nothing here yet. Capture a frame (click “Capture frame” or press F) and it will appear here.
      </div>
    )
  }
  return (
    <div className="tl-shelf-grid" role="list" aria-label="Captured frames">
      {frames.map((record) => {
        const busy = isFrameBusy(record)
        const failed = record.phase === 'error'
        return (
          <div
            key={record.id}
            className={`tl-shelf-card ${record.phase}`}
            role="listitem"
            aria-label={`Frame ${record.requestedTime.toFixed(2)} s — ${STATUS_TEXT[record.phase]}`}
          >
            <button
              type="button"
              className="tl-shelf-thumb"
              onClick={() => onSeek(record.requestedTime)}
              disabled={failed}
              aria-label={`Go to ${record.requestedTime.toFixed(2)} s`}
            >
              {record.resultUrl ? (
                <img src={record.resultUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <span className="tl-shelf-spinner" aria-hidden="true" />
              )}
            </button>
            <div className="tl-shelf-meta">
              <span className="tl-shelf-time">{timecode(record.requestedTime)}</span>
              <span className={`tl-shelf-status ${record.phase}`}>{STATUS_TEXT[record.phase]}</span>
            </div>
            <div className="tl-shelf-actions">
              {failed && (
                <button type="button" title="Retry" onClick={() => onRetry(record.id)} aria-label="Retry frame capture">
                  <IconRefresh size={14} />
                </button>
              )}
              {busy && (
                <button type="button" title="Cancel" onClick={() => onCancel(record.id)} aria-label="Cancel frame capture">
                  <IconClose size={14} />
                </button>
              )}
              <button
                type="button"
                title="To canvas (G)"
                disabled={record.phase !== 'saved'}
                onClick={() => onShow(record.id)}
                aria-label="Show frame on canvas"
              >
                <IconToCanvas size={14} />
              </button>
              <button
                type="button"
                title="Download (D)"
                disabled={!record.resultUrl}
                onClick={() => onDownload(record.id)}
                aria-label="Download frame"
              >
                <IconDownload size={14} />
              </button>
              <button
                type="button"
                title="Remove"
                onClick={() => onRemove(record.id)}
                aria-label="Remove frame from shelf"
              >
                <IconTrash size={14} />
              </button>
            </div>
            {record.error && (
              <div className="tl-shelf-error" role="alert">{systemErrorMessage(record.error)}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

import { useEffect, useRef } from 'react'
import {
  IconClose,
  IconDownload,
  IconNext,
  IconPrev,
  IconRestore,
  IconTrash,
} from '../../../ui/icons'
import {
  archiveKindLabel,
  archiveResolution,
  archiveTitle,
  formatArchiveDate,
} from '../konva/archive'
import type { ArchivedItem } from '../konva/types'
import { formatBytes } from './archiveSort'
import { MediaPlaybackControls } from '../../../ui/MediaPlaybackControls'

// Крупный просмотр записи архива: то, ради чего архив вообще открывают —
// «а что это было?». Стрелки листают по текущему (отфильтрованному и
// отсортированному) списку, Esc закрывает просмотр, не закрывая панель.
export function ArchivePreview({
  entries,
  index,
  bytes,
  onIndex,
  onClose,
  onRestore,
  onDownload,
  onDelete,
}: {
  entries: ArchivedItem[]
  index: number
  bytes?: number
  onIndex(next: number): void
  onClose(): void
  onRestore(entry: ArchivedItem): void
  onDownload(entry: ArchivedItem): void
  onDelete(entry: ArchivedItem): void
}) {
  const entry = entries[index]
  const mediaRef = useRef<HTMLVideoElement>(null)
  const fullscreenRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
      else if (e.key === 'ArrowRight' && index < entries.length - 1) onIndex(index + 1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, entries.length, onIndex, onClose])

  if (!entry) return null

  const facts = [
    archiveKindLabel(entry.kind),
    archiveResolution(entry),
    bytes != null ? formatBytes(bytes) : null,
    `in Archive since ${formatArchiveDate(entry.archivedAt)}`,
  ].filter(Boolean)

  return (
    <div className="archive-preview" role="dialog" aria-label="Archive preview" onClick={onClose}>
      <div className="archive-preview-body" onClick={(e) => e.stopPropagation()}>
        <header>
          <strong>{archiveTitle(entry)}</strong>
          <span className="archive-preview-counter">
            {index + 1} / {entries.length}
          </span>
          <button className="icon-btn" title="Close preview (Esc)" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="archive-preview-stage">
          <button
            className="icon-btn archive-preview-nav"
            disabled={index === 0}
            title="Previous (←)"
            onClick={() => onIndex(index - 1)}
          >
            <IconPrev size={18} />
          </button>
          <div className="archive-preview-media">
            {entry.kind === 'image' && entry.src ? (
              <img src={entry.src} alt={archiveTitle(entry)} />
            ) : entry.kind === 'video' && entry.src ? (
              <div className="archive-preview-player" key={`${entry.id}:${entry.src}`} ref={fullscreenRef}>
                <video ref={mediaRef} src={entry.src} autoPlay={false} />
                <MediaPlaybackControls mediaRef={mediaRef} fullscreenRef={fullscreenRef} />
              </div>
            ) : (
              <pre>{entry.text}</pre>
            )}
          </div>
          <button
            className="icon-btn archive-preview-nav"
            disabled={index >= entries.length - 1}
            title="Next (→)"
            onClick={() => onIndex(index + 1)}
          >
            <IconNext size={18} />
          </button>
        </div>

        <footer>
          <div className="archive-preview-facts">
            <small>{facts.join(' · ')}</small>
            {entry.prompt && <small title={entry.prompt}>Prompt: {entry.prompt}</small>}
          </div>
          <div className="archive-preview-actions">
            <button className="generate" onClick={() => onRestore(entry)}>
              <IconRestore size={14} /> Return to canvas
            </button>
            <button className="editor-close" onClick={() => onDownload(entry)}>
              <IconDownload size={14} /> Download
            </button>
            <button className="editor-close danger" onClick={() => onDelete(entry)}>
              <IconTrash size={14} /> Delete
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

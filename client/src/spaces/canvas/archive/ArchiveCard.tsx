import { IconText, IconVideo } from '../../../ui/icons'
import {
  archiveKindLabel,
  archiveResolution,
  archiveTitle,
  formatArchiveDate,
} from '../konva/archive'
import type { ArchivedItem } from '../konva/types'
import { formatBytes } from './archiveSort'
import { screenPreviewSrc } from '../konva/screenPreview'

// Одна карточка архива: превью, имя, строчка фактов. Клик по карточке —
// крупный просмотр, галочка в углу — выбор для групповых действий (как в
// фотоприложениях: смотреть и отбирать — разные жесты, они не мешают друг другу).
export function ArchiveCard({
  entry,
  checked,
  bytes,
  onOpen,
  onToggle,
}: {
  entry: ArchivedItem
  checked: boolean
  bytes?: number
  onOpen(): void
  onToggle(additive: boolean): void
}) {
  const facts = [
    archiveKindLabel(entry.kind),
    archiveResolution(entry),
    bytes != null ? formatBytes(bytes) : null,
    formatArchiveDate(entry.archivedAt),
  ].filter(Boolean)

  return (
    <div className={`archive-card ${checked ? 'checked' : ''}`}>
      <button
        type="button"
        className="archive-card-thumb"
        title="Open preview"
        onClick={(e) => {
          // Shift/Ctrl+клик по карточке — привычный способ отбирать пачкой,
          // не целясь в маленькую галочку
          if (e.shiftKey || e.ctrlKey || e.metaKey) onToggle(true)
          else onOpen()
        }}
      >
        {entry.kind === 'image' && entry.src ? (
          // Карточка — превью; оригинал показывает крупный просмотр.
          <img src={screenPreviewSrc(entry.src, 400)} alt="" loading="lazy" />
        ) : entry.kind === 'video' && entry.src ? (
          <>
            <video src={entry.src} muted preload="metadata" />
            <IconVideo size={16} className="archive-card-badge" />
          </>
        ) : (
          <span className="archive-card-text">
            <IconText size={18} />
            <em>{(entry.text ?? '').slice(0, 140) || 'empty text'}</em>
          </span>
        )}
      </button>
      <label className="archive-check" title="Mark for group actions">
        <input type="checkbox" checked={checked} onChange={() => onToggle(true)} />
      </label>
      <div className="archive-card-meta">
        <strong title={archiveTitle(entry)}>{archiveTitle(entry)}</strong>
        <small>{facts.join(' · ')}</small>
      </div>
    </div>
  )
}

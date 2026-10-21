import { useMemo, useState } from 'react'
import { IconDownload, IconRestore, IconSearch, IconTrash } from '../ui/icons'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { ArchivedItem } from '../spaces/canvas/konva/types'
import { useContentVersion } from '../spaces/canvas/konva/useStore'
import { ARCHIVE_SORTS, filterArchive, formatBytes, sortArchive, type ArchiveSort } from '../spaces/canvas/archive/archiveSort'
import { useArchiveSizes } from '../spaces/canvas/archive/archiveSizes'
import { downloadArchiveZip } from '../spaces/canvas/archive/archiveDownload'
import { notify } from '../spaces/canvas/notifications'
import { TabletFullScreen } from './TabletFullScreen'
import { previewSrc } from './remoteSession'
import { useBoardHistory } from './boardHistory'
import { useT } from '../i18n/context.js'


// Архив доски.
//
// Материал, который с холста убрали, но терять не собираются. Поиск и
// сортировка вместо папок — решение пользователя: раскладывать руками ничего
// не нужно.
//
// Отбор — галочкой на карточке: на планшете нет ни Shift, ни Ctrl, и других
// способов выбрать несколько просто нет.

export function TabletArchive({ store, onClose }: { store: CanvasStore; onClose(): void }) {
  const t = useT()
  const history = useBoardHistory()
  useContentVersion(store)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ArchiveSort>('new')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [busy, setBusy] = useState(false)

  const entries = store.getArchive()
  const sizes = useArchiveSizes(entries, true)
  const shown = useMemo(
    () => sortArchive(filterArchive(entries, query), sort, sizes.sizes),
    [entries, query, sort, sizes.sizes],
  )

  const selected = shown.filter((entry) => picked.has(entry.id))
  const acting = selected.length > 0 ? selected : []

  const toggle = (id: string) => {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <TabletFullScreen
      title={t('Board archive')}
      subtitle={<span className="tablet-mono">{entries.length} {t(Math.abs(entries.length) === 1 ? 'object' : 'objects')}</span>}
      onCancel={onClose}
      cancelLabel={t('Close')}
      center={entries.length > 0 ? (
        <div className="tablet-archive-controls">
          <label className="tablet-search">
            <IconSearch size={16} />
            <input
              className="ui-field"
              value={query}
              placeholder={t('Search')}
              aria-label={t('Search archive')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="ui-toggle" role="group" aria-label={t('Sort')}>
            {ARCHIVE_SORTS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={sort === option.value ? 'on' : ''}
                aria-pressed={sort === option.value}
                onClick={() => setSort(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : undefined}
      footer={entries.length > 0 ? (
        <>
          {acting.length === 0 ? (
            <span className="tablet-mono">{t('Tap the objects you want to work with')}</span>
          ) : (
            <>
              <span className="tablet-mono">{t('selected: {0}', { 0: acting.length })}</span>
              <span className="tablet-full-gap" />
              <button
                type="button"
                className="ui-btn"
                onClick={async () => {
                  const ids = acting.map((entry) => entry.id)
                  if (!(await store.withSelection(ids, () => {}))) return
                  const returned = store.restoreArchived(ids)
                  setPicked(new Set())
                  notify({
                    kind: 'success',
                    message: t('To canvas: {0} {1}', { 0: returned.length, 1: t(Math.abs(returned.length) === 1 ? 'object' : 'objects') }),
                    action: { label: t('Undo'), run: history.undo },
                  })
                }}
              >
                <IconRestore size={18} />  {t('Return to canvas')}
              </button>
              <button
                type="button"
                className="ui-btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void downloadArchiveZip(acting)
                    .then((result) => {
                      if (result.failed > 0) notify({ kind: 'error', message: t('Could not download: {0}', { 0: result.failed }) })
                    })
                    .finally(() => setBusy(false))
                }}
              >
                <IconDownload size={18} />  {t('Download')}
              </button>
              <button
                type="button"
                className="ui-btn danger"
                onClick={async () => {
                  // Второе нажатие — вместо системного вопроса. Разряжается сама,
                  // чтобы случайно взведённая кнопка не ждала вечно.
                  if (!confirmWipe) {
                    setConfirmWipe(true)
                    window.setTimeout(() => setConfirmWipe(false), 4000)
                    return
                  }
                  const ids = acting.map((entry) => entry.id)
                  if (!(await store.withSelection(ids, () => {}))) return
                  const removed = store.removeArchived(ids)
                  setPicked(new Set())
                  setConfirmWipe(false)
                  notify({
                    kind: 'success',
                    message: t('Deleted permanently: {0}', { 0: removed }),
                    action: { label: t('Undo'), run: history.undo },
                  })
                }}
              >
                <IconTrash size={18} /> {confirmWipe ? t('Delete for good?') : t('Delete permanently')}
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <span className="tablet-mono">{t('Archived materials will appear here.')}</span>
          <span className="tablet-full-gap" />
          <button type="button" className="ui-btn primary" onClick={onClose}>{t('Back to board')}</button>
        </>
      )}
    >
      <div className={`tablet-archive-grid ${shown.length === 0 ? 'empty' : ''}`}>
        {shown.map((entry) => (
          <ArchiveCard
            key={entry.id}
            entry={entry}
            size={entry.src ? sizes.sizes.get(entry.src) : undefined}
            picked={picked.has(entry.id)}
            onToggle={() => toggle(entry.id)}
          />
        ))}
        {shown.length === 0 && <TabletArchiveEmptyMessage hasEntries={entries.length > 0} />}
      </div>
    </TabletFullScreen>
  )
}

export function TabletArchiveEmptyMessage({ hasEntries }: { hasEntries: boolean }) {
  const t = useT()
  return (
    <p className="tablet-archive-empty">
      {hasEntries
        ? t('Nothing found.')
        : t('The archive is empty. Use “Archive” in an object’s actions to send it here.')}
    </p>
  )
}

function ArchiveCard({
  entry,
  size,
  picked,
  onToggle,
}: {
  entry: ArchivedItem
  size?: number
  picked: boolean
  onToggle(): void
}) {
  const t = useT()
  return (
    <button
      type="button"
      className={`tablet-archive-card ${picked ? 'picked' : ''}`}
      aria-pressed={picked}
      onClick={onToggle}
    >
      <span className="tablet-archive-thumb">
        {entry.kind === 'image' && entry.src
          ? <img src={previewSrc(entry.src)} alt="" decoding="async" />
          : <span className="tablet-archive-kind">{entry.kind === 'video' ? t('video') : entry.kind === 'audio' ? t('sound') : t('text')}</span>}
      </span>
      <span className="tablet-archive-name">{entry.name || entry.text?.slice(0, 30) || t('object')}</span>
      <span className="tablet-archive-meta">{size ? formatBytes(size) : ''}</span>
      <span className={`tablet-archive-pick ${picked ? 'on' : ''}`} aria-hidden="true" />
    </button>
  )
}

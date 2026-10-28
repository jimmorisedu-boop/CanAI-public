import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconClose, IconDownload, IconRestore, IconSearch, IconTrash } from '../../../ui/icons'
import { useDialogFocus } from '../../../ui/dialogFocus'
import type { CanvasStore } from '../konva/canvasStore'
import { useContentVersion } from '../konva/useStore'
import type { ArchivedItem } from '../konva/types'
import { notify } from '../notifications'
import { ArchiveCard } from './ArchiveCard'
import { ArchivePreview } from './ArchivePreview'
import { downloadArchiveEntry, downloadArchiveZip } from './archiveDownload'
import { ARCHIVE_SORTS, filterArchive, sortArchive, type ArchiveSort } from './archiveSort'
import { useArchiveSizes } from './archiveSizes'
import { ARCHIVE_PAGE_SIZE, archiveDisplayPage } from './archiveDisplay'
import { useT } from '../../../i18n/context.js'


// Панель архива доски: поиск + сортировка + сетка превью. Открывается кликом
// (левым или правым) по плитке «Архив». Фон — .settings-backdrop, поэтому
// хоткеи холста сами замолкают, пока панель открыта (см. useCanvasHotkeys).
export function ArchivePanel({ store, onClose }: { store: CanvasStore; onClose(): void }) {
  const t = useT()
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onClose)
  useContentVersion(store)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ArchiveSort>('new')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [visibleLimit, setVisibleLimit] = useState(ARCHIVE_PAGE_SIZE)

  const archive = store.getArchive()
  // Вес всех файлов нужен только для сортировки по размеру. Раньше панель сразу
  // делала HEAD для всего архива (121 объект = 121 запроса), хотя пользователь
  // сортировал по дате и веса на первом экране ещё не видел.
  const { sizes, loading: sizesLoading } = useArchiveSizes(archive, sort === 'size')

  const ordered = useMemo(
    () => sortArchive(filterArchive(archive, query), sort, sizes),
    // sizes — стабильная ссылка (кэш модуля), поэтому пересчитываем и по числу
    // уже известных размеров: иначе сортировка «по размеру» не догоняла загрузку
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [archive, query, sort, sizes.size],
  )

  const pickedEntries = ordered.filter((entry) => picked.has(entry.id))
  const previewIndex = previewId ? ordered.findIndex((entry) => entry.id === previewId) : -1
  const displayPage = archiveDisplayPage(ordered, visibleLimit)

  useArchiveSizes(
    previewIndex >= 0 ? [ordered[previewIndex]] : [],
    previewIndex >= 0,
  )

  useEffect(() => setVisibleLimit(ARCHIVE_PAGE_SIZE), [query, sort])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !previewId) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, previewId])

  // просмотр закрывается сам, если запись исчезла из архива (удалили/вернули).
  // Именно здесь, а не в remove(): при удалении из просмотра мы заранее
  // переводим просмотр на соседнюю запись, и она обязана пережить удаление.
  useEffect(() => {
    if (previewId && !archive.some((entry) => entry.id === previewId)) setPreviewId(null)
  }, [archive, previewId])

  // «Удалить насовсем» переспрашивает вторым кликом; через 4 секунды вопрос
  // снимается сам, чтобы кнопка не осталась заряженной
  useEffect(() => {
    if (!confirmDelete) return
    const timer = window.setTimeout(() => setConfirmDelete(false), 4000)
    return () => window.clearTimeout(timer)
  }, [confirmDelete])

  function toggle(id: string): void {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setConfirmDelete(false)
  }

  async function restore(entries: ArchivedItem[]): Promise<void> {
    if (entries.length === 0) return
    const admitted = await store.withSelection(entries.map((entry) => entry.id), () => {})
    if (!admitted) return
    const count = store.restoreArchived(entries.map((entry) => entry.id)).length
    setPicked(new Set())
    setPreviewId(null)
    onClose()
    notify({
      kind: 'success',
      message: count === 1
        ? t('Object returned to canvas')
        : t('Returned to canvas: {0}', { 0: `${count} ${t(count === 1 ? 'object' : 'objects')}` }),
      action: { label: t('Cancel'), run: () => store.undo() },
    })
  }

  async function remove(entries: ArchivedItem[]): Promise<void> {
    if (entries.length === 0) return
    const admitted = await store.withSelection(entries.map((entry) => entry.id), () => {})
    if (!admitted) return
    const count = store.removeArchived(entries.map((entry) => entry.id))
    setPicked(new Set())
    setConfirmDelete(false)
    notify({
      kind: 'info',
      message: count === 1
        ? t('Removed from Archive')
        : t('Removed from Archive: {0}', { 0: `${count} ${t(count === 1 ? 'object' : 'objects')}` }),
      action: { label: t('Cancel'), run: () => store.undo() },
    })
  }

  async function download(entries: ArchivedItem[]): Promise<void> {
    if (entries.length === 0 || busy) return
    if (entries.length === 1) {
      downloadArchiveEntry(entries[0])
      return
    }
    setBusy(true)
    try {
      const { ok, failed } = await downloadArchiveZip(entries)
      if (ok === 0) notify({ kind: 'error', message: t('Failed to download the selection') })
      else if (failed > 0) notify({ kind: 'info', message: t('Downloaded {0}of {1} — some files are unavailable', { 0: ok, 1: ok + failed }) })
    } finally {
      setBusy(false)
    }
  }

  const allPicked = ordered.length > 0 && pickedEntries.length === ordered.length

  // Портал обязателен: ArchiveBar живёт в stacking context z=300, а промпт-док
  // в z=400. Без портала даже backdrop z=1000 оставался под промпт-панелью.
  return createPortal(
    <div className="settings-backdrop archive-backdrop" onClick={onClose}>
      <section
        ref={dialogRef}
        className="archive-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="archive-head">
          <h2 id="archive-title">{t('Archive')}</h2>
          <small>
            {archive.length === 0
              ? t('empty')
              : `${archive.length} ${t(archive.length === 1 ? 'object' : 'objects')}${
                  ordered.length !== archive.length ? `, ${t('found {0}', { 0: ordered.length })}` : ''
                }`}
          </small>
          <div className="archive-search">
            <IconSearch size={15} />
            <input
              type="text"
              value={query}
              placeholder={t('Search by name, text, or prompt')}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select
            className="archive-sort"
            value={sort}
            title={sizesLoading ? t('File sizes are still being calculated') : t('Order')}
            onChange={(e) => setSort(e.target.value as ArchiveSort)}
          >
            {ARCHIVE_SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
          <button className="icon-btn" title={t('Close (Esc)')} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="archive-toolbar">
          <label className="archive-select-all">
            <input
              type="checkbox"
              checked={allPicked}
              disabled={ordered.length === 0}
              onChange={() => setPicked(allPicked ? new Set() : new Set(ordered.map((entry) => entry.id)))}
            />
            <span>{pickedEntries.length > 0 ? t('Selected: {0}', { 0: pickedEntries.length }) : t('Select all')}</span>
          </label>
          <div className="archive-toolbar-actions">
            <button className="generate" disabled={!pickedEntries.length} onClick={() => restore(pickedEntries)}>
              <IconRestore size={14} />  {t('Return to canvas')}
            </button>
            <button
              className="editor-close"
              disabled={!pickedEntries.length || busy}
              onClick={() => void download(pickedEntries)}
            >
              <IconDownload size={14} /> {busy ? t('Preparing…') : t('Download')}
            </button>
            <button
              className={`editor-close danger ${confirmDelete ? 'armed' : ''}`}
              disabled={!pickedEntries.length}
              onClick={() => (confirmDelete ? remove(pickedEntries) : setConfirmDelete(true))}
            >
              <IconTrash size={14} /> {confirmDelete ? t('Delete {0}?', { 0: pickedEntries.length }) : t('Delete permanently')}
            </button>
          </div>
        </div>

        {ordered.length === 0 ? (
          <div className="archive-empty">
            {archive.length === 0
              ? t('Archive is empty. Select objects on the canvas and drag them to the Archive tile; they will wait here.')
              : t('Nothing found. Try another word or clear the search.')}
          </div>
        ) : (
          <div className="archive-grid">
            {displayPage.visible.map((entry) => (
              <ArchiveCard
                key={entry.id}
                entry={entry}
                checked={picked.has(entry.id)}
                bytes={entry.src ? sizes.get(entry.src) : undefined}
                onOpen={() => setPreviewId(entry.id)}
                onToggle={() => toggle(entry.id)}
              />
            ))}
            {displayPage.remaining > 0 && (
              <button
                type="button"
                className="archive-load-more"
                onClick={() => setVisibleLimit((current) => current + ARCHIVE_PAGE_SIZE)}
              >
                Show more {Math.min(ARCHIVE_PAGE_SIZE, displayPage.remaining)}
                <small>{t('Remaining')} {displayPage.remaining}</small>
              </button>
            )}
          </div>
        )}

        {previewIndex >= 0 && (
          <ArchivePreview
            entries={ordered}
            index={previewIndex}
            bytes={ordered[previewIndex].src ? sizes.get(ordered[previewIndex].src!) : undefined}
            onIndex={(next) => setPreviewId(ordered[next]?.id ?? null)}
            onClose={() => setPreviewId(null)}
            onRestore={(entry) => restore([entry])}
            onDownload={(entry) => void download([entry])}
            onDelete={(entry) => {
              const neighbour = ordered[previewIndex + 1] ?? ordered[previewIndex - 1] ?? null
              setPreviewId(neighbour ? neighbour.id : null)
              remove([entry])
            }}
          />
        )}
      </section>
    </div>,
    document.body,
  )
}

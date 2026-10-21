import { useEffect, useState } from 'react'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { downloadItems } from '../spaces/canvas/konva/zipExport'
import { runWithBoardLease } from '../spaces/canvas/konva/boardLeaseActions'
import { useT } from '../i18n/context.js'


// Меню объекта — по долгому нажатию.
//
// На планшете нет правой кнопки, а прятать действия в невидимые жесты нельзя:
// человек их не найдёт. Долгое нажатие — общепринятая замена, и оно
// открывает обычный лист снизу, где до каждой кнопки достаёт палец.

export function TabletItemSheet({
  store,
  itemId,
  onClose,
}: {
  store: CanvasStore
  itemId: string
  onClose(): void
}) {
  const t = useT()
  const item = store.getItem(itemId)
  const selected = store.getSelectedIds()
  const ids = selected.has(itemId) && selected.size > 1 ? [...selected] : [itemId]
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!item) onClose()
  }, [item, onClose])

  if (!item) return null

  const many = ids.length > 1
  const close = () => {
    setConfirmDelete(false)
    onClose()
  }

  return (
    <>
      <div className="tablet-sheet-backdrop" onPointerDown={close} />
      <div className="tablet-sheet" role="dialog" aria-label={t('Object actions')}>
        <p className="tablet-sheet-title">
          {many ? t('Objects selected: {0}', { 0: ids.length }) : item.name || item.text?.slice(0, 40) || 'Object'}
        </p>
        <button type="button" className="ui-btn" onClick={() => { store.setSelection(ids); close() }}>
          {t('Use as reference')}
        </button>
        <button
          type="button"
          className="ui-btn"
          onClick={() => {
            // Дублирование в сторе работает по выделению — сначала им и
            // становимся, иначе продублируется не то, что в меню.
            store.setSelection(ids)
            store.duplicateSelected()
            close()
          }}
        >

          {t('Duplicate')}
        </button>
        <button type="button" className="ui-btn" onClick={() => { void downloadItems(ids.map((id) => store.getItem(id)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))); close() }}>

          {t('Download')}
        </button>
        <button type="button" className="ui-btn" onClick={() => { store.archiveItems(ids); close() }}>
          {t('Move to archive')}
        </button>
        <button
          type="button"
          className="ui-btn danger"
          onClick={() => {
            // Второе нажатие вместо системного вопроса: на планшете диалог
            // перекрывает пол-экрана, а промахнуться пальцем легко.
            if (!confirmDelete) {
              setConfirmDelete(true)
              return
            }
            runWithBoardLease(store, ids, () => store.removeItems(ids))
            close()
          }}
        >
          {confirmDelete ? t('Delete for good?') : t('Delete')}
        </button>
        <button type="button" className="ui-btn quiet tablet-sheet-cancel" onClick={close}>{t('Cancel')}</button>
      </div>
    </>
  )
}

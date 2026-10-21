import { useEffect } from 'react'
import {
  IconArchive,
  IconCompare,
  IconCopy,
  IconCrop,
  IconDownload,
  IconFit,
  IconImage,
  IconOpenExternal,
  IconPaste,
  IconClose,
  IconSelectAll,
  IconSketch,
  IconSound,
  IconTimeline,
  IconStop,
  IconText,
  IconToBack,
  IconToFront,
  IconTrash,
  IconVideo,
} from '../../../ui/icons'
import { requestImageEdit } from '../editorBus'
import { startComparePicking } from '../compare/compareBus'
import { setCropTarget } from '../cropBus'
import { setSketchTarget } from '../sketchBus'
import { showErrorToast, showToast } from '../toastBus'
import type { CanvasStore } from './canvasStore'
import { cancelGeneration } from '../generationRegistry'
import { requestMediaImportCancel } from '../mediaImportCancelBus'
import { archiveSelection, archiveTargets } from './archiveSelection'
import { LEASE_REFUSED, runWithBoardLease } from './boardLeaseActions'
import { copySelected, hasClipboard, paste } from './clipboard'
import { extractAudioFromItem } from './extractAudio'
import { setTimelineTarget } from '../timeline/timelineBus'
import { zoomToFit } from './cameraOps'
import { downloadItemsAsZip } from './zipExport'
import { api } from '../../../api'
import { canvasItemFileName } from './mediaFileName'
import { useT } from '../../../i18n/context.js'


export interface MenuState {
  x: number // экранные координаты внутри .konva-wrap
  y: number
  itemId: string | null // null = меню пустого места
  world: { x: number; y: number } // мировые координаты клика (куда добавлять)
}

// Контекстное меню холста (правый клик) — как в Figma/Canva.
export function ContextMenu({
  store,
  menu,
  viewport,
  onAdd,
  onClose,
}: {
  store: CanvasStore
  menu: MenuState
  viewport: { w: number; h: number }
  onAdd: (kind: 'image' | 'video' | 'text', world: { x: number; y: number }) => void
  onClose: () => void
}) {
  const t = useT()
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close, { capture: true })
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close, { capture: true })
    }
  }, [onClose])

  const item = menu.itemId ? store.getItem(menu.itemId) : null
  const pending = menu.itemId ? store.getPending().find((p) => p.id === menu.itemId) : null
  const hasTarget = Boolean(item || pending)

  function run(action: () => void): void {
    onClose()
    action()
  }

  // ⚠️ Действие, которое ПРАВИТ объект, само берёт аренду — как перетаскивание
  // (см. itemHelpers) и как кнопки карточки-заглушки. Гасить пункт из-за
  // недостающей аренды нельзя: она истекает молча, и человек оставался с
  // выделенной картинкой, у которой не работает ни «Удалить», ни Delete
  // (жалоба 09.09.2026 «почему я не могу удалить на сетевой доске»).
  function runOwned(ids: readonly string[], action: () => void | Promise<void>): void {
    onClose()
    runWithBoardLease(store, ids, action, LEASE_REFUSED)
  }

  function download(): void {
    if (!item?.src) return
    const a = document.createElement('a')
    a.href = item.src
    a.download = canvasItemFileName(item)
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  async function downloadSelectionZip(): Promise<void> {
    const { ok, failed } = await downloadItemsAsZip(store.getSelectedItems())
    if (ok === 0) showErrorToast(t('Failed to download the selection'))
    else if (failed > 0) showToast(t('Downloaded {0}of {1} — some files are unavailable', { 0: ok, 1: ok + failed }))
  }

  const selectedItems = store.getSelectedItems()
  const hasMultiSelection = selectedItems.length > 1
  const hasMarkedSelection = selectedItems.some((i) => i.mark != null)
  // Гасим только то, что и правда держит ЖИВОЙ коллега: у него объект помечен
  // «Занято: имя». Своя аренда тут ни при чём — её берёт само действие.
  const canMutateTarget = !menu.itemId || store.looksEditable([menu.itemId])
  const canMutateSelection = store.looksEditable([...store.getSelectedIds()])

  return (
    <div
      className="add-menu canvas-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {hasTarget ? (
        <>
          {item && (
            <>
              <button className="add-menu-item" onClick={() => run(() => copySelected(store))}>
                <IconCopy size={16} />
                <span className="mi-label">{t('Copy')}</span>
                <kbd>Ctrl+C</kbd>
              </button>
              {item.kind === 'text' && (
                <button className="add-menu-item" disabled={!canMutateTarget} onClick={() => runOwned([item.id], () => store.autoFitText(item.id))}>
                  <IconFit size={16} />
                  <span className="mi-label">{t('Expand text')}</span>
                </button>
              )}
              {item.kind === 'image' && item.src && (
                <>
                  <button
                    className="add-menu-item"
                    disabled={!canMutateTarget}
                    onClick={() =>
                      runOwned([item.id], () => requestImageEdit({ shapeId: item.id, src: item.src!, name: item.name || 'image' }))
                    }
                  >
                    <IconOpenExternal size={16} />
                    <span className="mi-label">{t('Open in editor')}</span>
                    <kbd>F2</kbd>
                  </button>
                  <button className="add-menu-item" disabled={!canMutateTarget} onClick={() => runOwned([item.id], () => setSketchTarget(item.id))}>
                    <IconSketch size={16} />
                    <span className="mi-label">{t('Sketch overlay')}</span>
                  </button>
                  <button className="add-menu-item" disabled={!canMutateTarget} onClick={() => runOwned([item.id], () => setCropTarget(item.id))}>
                    <IconCrop size={16} />
                    <span className="mi-label">{t('Crop')}</span>
                  </button>
                </>
              )}
              {item.kind === 'video' && (
                <>
                  <button className="add-menu-item" disabled={!canMutateTarget} onClick={() => runOwned([item.id], () => setTimelineTarget(item.id))}>
                    <IconTimeline size={16} />
                    <span className="mi-label">{t('Clip editing')}</span>
                    <kbd>T</kbd>
                  </button>
                  <button className="add-menu-item" disabled={!canMutateTarget} onClick={() => runOwned([item.id], () => extractAudioFromItem(store, item.id))}>
                    <IconSound size={16} />
                    <span className="mi-label">{t('Separate audio')}</span>
                  </button>
                </>
              )}
              {(item.kind === 'image' || item.kind === 'video') && (
                /* исходник назначается тем, что с него начинают: щёлкнул
                   правой по той картинке, от которой пляшешь */
                <button className="add-menu-item" onClick={() => run(() => startComparePicking(item.id))}>
                  <IconCompare size={16} />
                  <span className="mi-label">{t('Compare with…')}</span>
                  <kbd>Q</kbd>
                </button>
              )}
              {(item.kind === 'image' || item.kind === 'video' || item.kind === 'audio') && item.src && (
                <>
                  <button className="add-menu-item" onClick={() => run(download)}>
                    <IconDownload size={16} />
                    <span className="mi-label">{item.kind === 'audio' ? t('Download audio') : t('Download')}</span>
                  </button>
                  <button
                    className="add-menu-item"
                    onClick={() =>
                      run(() => api.revealFile(item.src!).catch((err) => showErrorToast(err.message || t('Error'))))
                    }
                  >
                    <IconOpenExternal size={16} />
                    <span className="mi-label">{t('Show in folder')}</span>
                  </button>
                </>
              )}
            </>
          )}
          {hasMultiSelection && (
            <button className="add-menu-item" onClick={() => run(() => void downloadSelectionZip())}>
              <IconDownload size={16} />
              <span className="mi-label">{t('Download selection (ZIP)')}</span>
            </button>
          )}
          {hasMarkedSelection && (
            <button
              className="add-menu-item"
              disabled={!canMutateSelection}
              onClick={() => runOwned([...store.getSelectedIds()], () => store.setMarks([...store.getSelectedIds()], undefined))}
            >
              <IconClose size={16} />
              <span className="mi-label">{t('Remove label')}</span>
            </button>
          )}
          {/* Заглушка генерации — не объект: слои её не двигают, а «Удалить»
              для идущей ничего не делает. Показываем то, что действительно
              применимо, вместо трёх молчаливых пунктов. */}
          {item ? (
            <>
              <div className="add-menu-divider" />
              {/* до этого в архив можно было попасть ТОЛЬКО перетаскиванием на
                  плитку — жест, о котором нельзя догадаться (F-16) */}
               <button className="add-menu-item" disabled={!canMutateSelection} onClick={() => runOwned(archiveTargets(store, item.id), () => { archiveSelection(store, archiveTargets(store, item.id)) })}>
                <IconArchive size={16} />
                <span className="mi-label">{t('To Archive')}</span>
                <kbd>Shift+Del</kbd>
              </button>
               <button className="add-menu-item" disabled={!canMutateSelection} onClick={() => runOwned([...store.getSelectedIds()], () => store.bringToFront([...store.getSelectedIds()]))}>
                <IconToFront size={16} />
                <span className="mi-label">{t('Bring to front')}</span>
              </button>
               <button className="add-menu-item" disabled={!canMutateSelection} onClick={() => runOwned([...store.getSelectedIds()], () => store.sendToBack([...store.getSelectedIds()]))}>
                <IconToBack size={16} />
                <span className="mi-label">{t('Send to back')}</span>
              </button>
              <div className="add-menu-divider" />
               <button className="add-menu-item danger" disabled={!canMutateSelection} onClick={() => runOwned([...store.getSelectedIds()], () => store.removeSelected())}>
                <IconTrash size={16} />
                <span className="mi-label">{t('Delete')}</span>
                <kbd>Del</kbd>
              </button>
            </>
          ) : pending?.status === 'loading' ? (
            <button
              className="add-menu-item danger"
              disabled={!pending.jobId || !canMutateTarget}
              onClick={() => run(() => {
                if (!pending.jobId) return
                if (pending.taskType === 'media-import') requestMediaImportCancel(pending.jobId)
                else void cancelGeneration(pending.jobId).catch(() => {})
              })}
            >
              <IconStop size={16} />
              <span className="mi-label">{pending.taskType === 'media-import' ? t('Stop download') : t('Stop generation')}</span>
            </button>
          ) : (
             <button className="add-menu-item danger" disabled={!canMutateTarget} onClick={() => runOwned([...store.getSelectedIds()], () => store.removeSelected())}>
              <IconTrash size={16} />
              <span className="mi-label">{t('Remove card')}</span>
              <kbd>Del</kbd>
            </button>
          )}
        </>
      ) : (
        <>
          <button className="add-menu-item" onClick={() => run(() => onAdd('image', menu.world))}>
            <IconImage size={16} />
            <span className="mi-label">{t('Add image')}</span>
          </button>
          <button className="add-menu-item" onClick={() => run(() => onAdd('video', menu.world))}>
            <IconVideo size={16} />
            <span className="mi-label">{t('Add video')}</span>
          </button>
          <button className="add-menu-item" onClick={() => run(() => onAdd('text', menu.world))}>
            <IconText size={16} />
            <span className="mi-label">{t('Add text')}</span>
          </button>
          <div className="add-menu-divider" />
          <button className="add-menu-item" disabled={!hasClipboard()} onClick={() => run(() => paste(store, menu.world, viewport))}>
            <IconPaste size={16} />
            <span className="mi-label">{t('Paste')}</span>
            <kbd>Ctrl+V</kbd>
          </button>
          <button className="add-menu-item" onClick={() => run(() => store.selectAll())}>
            <IconSelectAll size={16} />
            <span className="mi-label">{t('Select all')}</span>
            <kbd>Ctrl+A</kbd>
          </button>
          <button className="add-menu-item" onClick={() => run(() => zoomToFit(store, viewport))}>
            <IconFit size={16} />
            <span className="mi-label">{t('Show all')}</span>
            <kbd>Shift+1</kbd>
          </button>
        </>
      )}
    </div>
  )
}

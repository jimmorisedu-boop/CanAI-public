import { useCallback } from 'react'
import { api } from '../api'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { CanvasItem, PinnedAsset } from '../spaces/canvas/konva/types'
import { downloadItems, downloadMarkedAsZip } from '../spaces/canvas/konva/zipExport'
import { runWithBoardLease } from '../spaces/canvas/konva/boardLeaseActions'
import { useCatalogModels } from '../spaces/canvas/genOptions'
import { assetToRef } from '../spaces/canvas/konva/assetRef'
import { requestAddPromptAsset } from '../spaces/canvas/promptAssetBus'
import { notify } from '../spaces/canvas/notifications'
import { plural } from '../ui/plural'
import { setTimelineTarget } from '../spaces/canvas/timeline/timelineBus'
import { viewportBounds } from './boardGestures'
import { actionNeedsMutationLease, type InspectorAction } from './inspectorModel'
import type { TabletEditor } from './TabletOverlays'
import { tabletSystemMessage } from './tabletSystemMessage'

export function boardExportItems(items: CanvasItem[]): CanvasItem[] {
  return items.filter((item) => item.kind !== 'link')
}

// Что делают кнопки инспектора и меню объекта.
//
// Отдельным модулем, потому что кнопок два набора (инспектор справа и меню по
// долгому нажатию), а действие за ними ОДНО. Разложить его по обоим экранам
// значит однажды починить только в одном.

export function useBoardActions({
  store,
  projectId,
  viewport,
  setEditor,
  setBusyNote,
  onUndo,
}: {
  store: CanvasStore
  projectId: string
  viewport(): { w: number; h: number }
  setEditor(editor: TabletEditor): void
  setBusyNote(note: string | null): void
  onUndo(): void
}) {
  const { models } = useCatalogModels()

  const modelNameOf = useCallback(
    (item: CanvasItem) => models.find((model) => model.id === item.modelId)?.name,
    [models],
  )

  const centerOfView = useCallback(() => {
    const bounds = viewportBounds(store.getCamera(), viewport(), 0)
    return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
  }, [store, viewport])

  const addTextInView = useCallback(() => {
    const id = store.placeText('', centerOfView())
    store.setSelection([id])
    setEditor({ kind: 'text', itemId: id })
  }, [store, centerOfView, setEditor])

  const useAssetAsReference = useCallback((asset: PinnedAsset) => {
    // Ассет уходит референсом в промпт — ровно как нажатие по слоту на
    // компьютере. Полка для того и нужна: держать под рукой то, из чего
    // генерируешь, не выискивая это на доске.
    requestAddPromptAsset(assetToRef(asset))
  }, [])

  const exportMarked = useCallback(async (boardName: string) => {
    setBusyNote('Building archive…')
    try {
      const result = await downloadMarkedAsZip(store.getItems(), projectId)
      setBusyNote(null)
      if (result.ok === 0) {
        notify({ kind: 'error', message: 'Could not build archive' })
        return
      }
      notify({
        kind: 'success',
        message: `In archive ${result.ok} ${plural(result.ok, ['file', 'files', 'files'])}  of ${boardName}`,
      })
    } catch (error) {
      setBusyNote(null)
      notify({ kind: 'error', message: tabletSystemMessage(error, 'Could not build archive') })
    }
  }, [store, projectId, setBusyNote])

  const exportBoard = useCallback(async (boardName: string, selectedOnly = false) => {
    const items = boardExportItems(store.getItems().filter((item) => !selectedOnly || store.getSelectedIds().has(item.id)))
    if (items.length === 0) {
      notify({ kind: 'info', message: 'There is nothing to export on the board yet' })
      return
    }
    setBusyNote('Collecting files…')
    try {
      const result = await downloadItems(items)
      if (result.cancelled) return
      if (result.failed > 0) {
        notify({ kind: 'error', message: `Could not download: ${result.failed}` })
      } else {
        notify({ kind: 'success', message: `Export “${boardName}” ready` })
      }
    } catch (error) {
      notify({ kind: 'error', message: tabletSystemMessage(error, 'Could not export board') })
    } finally {
      setBusyNote(null)
    }
  }, [store, setBusyNote])

  const run = useCallback((action: InspectorAction, items: CanvasItem[]) => {
    const ids = items.map((item) => item.id)
    const first = items[0]
    if (!first) return
    if (actionNeedsMutationLease(action) && !store.canMutateItems(ids)) {
      notify({ kind: 'info', message: 'Another participant is editing this object' })
      return
    }

    switch (action) {
      case 'sketch':
        setEditor({ kind: 'sketch', itemId: first.id })
        return
      case 'crop':
        setEditor({ kind: 'crop', itemId: first.id })
        return
      case 'clip':
        // ⚠️ Цель ставим ЗДЕСЬ, в обработчике, а не внутри режима. Сеанс
        // таймлайна читает её при первом рендере и дальше только слушает
        // изменения — установка после монтирования приходила в пустоту, и
        // режим молча не открывался (поймано прогоном 26.08.2026).
        setTimelineTarget(first.id)
        setEditor({ kind: 'clip', itemId: first.id })
        return
      case 'compare':
        setEditor({ kind: 'compare', baseId: first.id, candidateIds: items.slice(1).map((item) => item.id) })
        return
      case 'edit-text':
        setEditor({ kind: 'text', itemId: first.id })
        return
      case 'extract-audio':
        setTimelineTarget(first.id)
        setEditor({ kind: 'clip', itemId: first.id, tool: 'audio' })
        return
      case 'duplicate':
        store.setSelection(ids)
        store.duplicateSelected()
        return
      case 'pin': {
        const slot = nextFreeSlot(store)
        store.pinAsset({
          slot,
          kind: first.kind === 'video' ? 'video' : first.kind === 'audio' ? 'audio' : first.kind === 'text' ? 'text' : 'image',
          src: first.src,
          assetId: first.assetId,
          mime: first.mime,
          text: first.text,
          name: first.name,
          width: first.naturalWidth,
          height: first.naturalHeight,
        })
        notify({ kind: 'success', message: 'Added to assets' })
        return
      }
      case 'front':
        runWithBoardLease(store, ids, () => store.bringToFront(ids))
        return
      case 'back':
        runWithBoardLease(store, ids, () => store.sendToBack(ids))
        return
      case 'download':
        setBusyNote('Preparing files…')
        void downloadItems(items)
          .then((result) => {
            setBusyNote(null)
            if (result.failed > 0) {
              notify({ kind: 'error', message: `Could not download: ${result.failed}` })
            }
          })
          .catch((error: unknown) => {
            setBusyNote(null)
            notify({ kind: 'error', message: tabletSystemMessage(error, 'Could not download') })
          })
        return
      case 'archive':
        // ⚠️ Об успехе сообщаем ТОЛЬКО после настоящей правки: без аренды стор
        // молча возвращался, а «В архив: 1 объект» уже было сказано.
        runWithBoardLease(store, ids, () => {
          const moved = store.archiveItems(ids)
          notify({
            kind: 'success',
            message: `Archive: ${moved} ${plural(moved, ['object', 'objects', 'objects'])}`,
            action: { label: 'Undo', run: onUndo },
          })
        })
        return
      case 'delete':
        runWithBoardLease(store, ids, () => {
          store.removeItems(ids)
          notify({
            kind: 'success',
            message: `Deleted: ${ids.length} ${plural(ids.length, ['object', 'objects', 'objects'])}`,
            action: { label: 'Undo', run: onUndo },
          })
        })
        return
    }
  }, [store, setEditor, setBusyNote, onUndo])

  return { run, addTextInView, useAssetAsReference, exportMarked, exportBoard, modelNameOf, api }
}

/** Первый свободный слот полки: занятый перезаписывать нельзя. */
function nextFreeSlot(store: CanvasStore): number {
  const taken = new Set(store.getAssets().map((asset) => asset.slot))
  for (let slot = 0; slot < 8; slot += 1) if (!taken.has(slot)) return slot
  // Полка заполнена — кладём в последний: это лучше, чем молча не сделать
  // ничего в ответ на нажатие.
  return 7
}

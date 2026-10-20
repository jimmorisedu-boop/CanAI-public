import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { assetToRef } from '../spaces/canvas/konva/assetRef'
import { notify } from '../spaces/canvas/notifications'
import { plural } from '../ui/plural'
import { itemToRef } from '../spaces/canvas/konva/selection'
import { requestAddPromptAsset } from '../spaces/canvas/promptAssetBus'

// Куда можно отпустить объект: полка ассетов и плитка архива.
//
// Приём тот же, что на компьютере: под пальцем в момент отпускания ищем
// зону через elementFromPoint. Разница одна и она в пользу планшета — здесь
// это единственный способ закрепить объект, потому что правой кнопки нет.

export type BoardDrop =
  | { kind: 'asset'; slot: number }
  | { kind: 'archive' }
  | { kind: 'prompt' }
  | null

export function dropTargetAt(clientX: number, clientY: number): BoardDrop {
  const element = document.elementFromPoint(clientX, clientY)
  if (!element) return null
  if (element.closest('[data-tablet-prompt-dropzone]')) return { kind: 'prompt' }
  const slot = element.closest('[data-asset-slot]')
  if (slot) {
    const raw = Number(slot.getAttribute('data-asset-slot'))
    return Number.isInteger(raw) ? { kind: 'asset', slot: raw } : null
  }
  if (element.closest('[data-archive-dropzone]')) return { kind: 'archive' }
  return null
}

/**
 * Выполнить сброс. Возвращает true, если объект НЕ должен переезжать: и полка,
 * и архив оставляют холст в покое — объект либо возвращается на место
 * (закрепление), либо уезжает с доски целиком (архив).
 */
export function applyBoardDrop(
  store: CanvasStore,
  drop: NonNullable<BoardDrop>,
  ids: readonly string[],
  onUndo?: () => void,
): boolean {
  if (drop.kind === 'prompt') {
    for (const id of ids) {
      const item = store.getItem(id)
      const ref = item && itemToRef(item)
      if (ref) requestAddPromptAsset(ref)
    }
    return true
  }
  if (drop.kind === 'asset') {
    const item = store.getItem(ids[0] ?? '')
    if (!item) return false
    store.pinAsset({
      slot: drop.slot,
      kind: item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'audio' : item.kind === 'text' ? 'text' : 'image',
      src: item.src,
      assetId: item.assetId,
      mime: item.mime,
      text: item.text,
      name: item.name,
      width: item.naturalWidth,
      height: item.naturalHeight,
    })
    notify({ kind: 'success', message: 'Added to assets' })
    return true
  }

  const moved = store.archiveItems([...ids])
  if (moved === 0) return false
  notify({
    kind: 'success',
    message: `Archive: ${moved} ${plural(moved, ['object', 'objects', 'objects'])}`,
    ...(onUndo ? { action: { label: 'Undo', run: onUndo } } : {}),
  })
  return true
}

/** Референс из закреплённого ассета — тот же, что на компьютере. */
export { assetToRef }

import { OBJECTS, pluralWithCount } from '../../../ui/plural'
import { notify } from '../notifications'
import type { CanvasStore } from './canvasStore'

// Отправка в архив — одна точка на все входы: перетаскивание на плитку,
// пункт контекстного меню, кнопка над выделением и Shift+Delete. Раньше это
// умел только жест перетаскивания, и функцию нельзя было найти без справки.
export function archiveSelection(store: CanvasStore, ids: string[]): number {
  if (ids.length === 0) return 0
  const moved = store.archiveItems(ids)
  if (moved === 0) return 0
  notify({
    kind: 'success',
    message: moved === 1 ? 'Object is in Archive' : `Moved to Archive: ${pluralWithCount(moved, OBJECTS)}`,
    action: { label: 'Cancel', run: () => store.undo() },
  })
  return moved
}

// Что уедет: если тянут/жмут по объекту из выделения — всё выделение,
// иначе только он сам.
export function archiveTargets(store: CanvasStore, itemId?: string): string[] {
  const selected = store.getSelectedIds()
  if (itemId && !(selected.has(itemId) && selected.size > 1)) return [itemId]
  return [...selected].filter((id) => Boolean(store.getItem(id)))
}

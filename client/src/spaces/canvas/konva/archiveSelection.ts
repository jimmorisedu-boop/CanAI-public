import { notify } from '../notifications'
import type { CanvasStore } from './canvasStore'
import { t } from '../../../i18n/translate.js'

// Отправка в архив — одна точка на все входы: перетаскивание на плитку,
// пункт контекстного меню, кнопка над выделением и Shift+Delete. Раньше это
// умел только жест перетаскивания, и функцию нельзя было найти без справки.
export function archiveSelection(store: CanvasStore, ids: string[]): number {
  if (ids.length === 0) return 0
  const moved = store.archiveItems(ids)
  if (moved === 0) return 0
  notify({
    kind: 'success',
    message: moved === 1
      ? t('Object is in Archive')
      : t('Moved to Archive: {0}', { 0: `${moved} ${t('objects')}` }),
    action: { label: t('Cancel'), run: () => store.undo() },
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

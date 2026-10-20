import type { CanvasItem } from '../spaces/canvas/konva/types'
import type { InspectorAction } from './inspectorModel'

export type ContextAction = InspectorAction | 'grid'

export interface ContextActionSet {
  primary: ContextAction[]
  overflow: InspectorAction[]
}

const COMMON_MORE: InspectorAction[] = ['pin', 'front', 'back', 'download', 'archive']

/**
 * Короткая матрица панели у выделения. Здесь намеренно нет `delete`:
 * с рабочей доски объект безопасно уходит в архив, а окончательное удаление
 * остаётся в самом архиве.
 */
export function contextActionsFor(items: CanvasItem[]): ContextActionSet {
  const first = items[0]
  if (!first) return { primary: [], overflow: [] }

  if (items.length > 1) {
    const comparable = items.every((item) => item.kind === 'image' || item.kind === 'video')
    return {
      primary: comparable ? ['grid', 'compare', 'duplicate'] : ['grid', 'duplicate'],
      overflow: ['front', 'back', 'download', 'archive'],
    }
  }

  if (first.kind === 'image') {
    return { primary: ['view', 'resize', 'crop'], overflow: ['sketch', ...COMMON_MORE] }
  }
  if (first.kind === 'video') {
    return { primary: ['view', 'resize', 'clip'], overflow: COMMON_MORE }
  }
  if (first.kind === 'audio') {
    return { primary: ['resize', 'duplicate', 'download'], overflow: ['pin', 'front', 'back', 'archive'] }
  }
  if (first.kind === 'text') {
    return { primary: ['edit-text', 'resize', 'duplicate'], overflow: ['front', 'back', 'download', 'archive'] }
  }
  return { primary: ['resize', 'duplicate'], overflow: ['front', 'back', 'archive'] }
}

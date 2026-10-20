import type { CanvasItem } from './konva/types'

export interface ExportGroup {
  id: string
  mark: number
  name: string
  itemIds: string[]
}

export function groupsFromLegacyItems(items: CanvasItem[]): ExportGroup[] {
  const groups = new Map<number, string[]>()
  for (const item of items) {
    if (item.mark == null || item.kind === 'link') continue
    groups.set(item.mark, [...(groups.get(item.mark) ?? []), item.id])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([mark, itemIds]) => ({
      id: String(mark),
      mark,
      name: `Group ${mark}`,
      itemIds,
    }))
}

import type { CanvasItem } from './types'

export function canPinCanvasItem(
  item: Pick<CanvasItem, 'kind' | 'src' | 'text' | 'link'>,
): boolean {
  if (item.kind === 'link') return false
  return item.kind === 'text' ? Boolean(item.text) : Boolean(item.src)
}

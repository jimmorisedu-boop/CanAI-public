import type { CanvasItem } from '../spaces/canvas/konva/types'

export function mediaDoubleTapAction(item: Pick<CanvasItem, 'kind' | 'prompt' | 'modelId'>): 'details' | 'viewer' {
  return item.kind === 'image' && Boolean(item.prompt || item.modelId) ? 'details' : 'viewer'
}

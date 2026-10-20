import { itemToRef } from './konva/selection'
import type { CanvasItem, Placeholder } from './konva/types'
import type { PromptChatDropEvent } from './promptChatDropBus'

export interface PromptChatDropResult {
  event: PromptChatDropEvent
  position: { x: number; y: number }
}

const unavailable: PromptChatDropEvent = {
  kind: 'error',
  message: "This object cannot be used as a reference yet",
}

export function createPromptChatDropResult(
  item?: CanvasItem,
  pending?: Placeholder,
): PromptChatDropResult | null {
  if (item) {
    if (item.kind === 'link') {
      return {
        event: { kind: 'error', message: "This link is not a reference — download the media first" },
        position: { x: item.x, y: item.y },
      }
    }
    const ref = itemToRef(item)
    return {
      event: ref ? { kind: 'reference', ref } : unavailable,
      position: { x: item.x, y: item.y },
    }
  }
  if (pending) {
    return {
      event: unavailable,
      position: { x: pending.x, y: pending.y },
    }
  }
  return null
}

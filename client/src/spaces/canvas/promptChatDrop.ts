import { itemToRef } from './konva/selection'
import type { CanvasItem, Placeholder } from './konva/types'
import type { PromptChatDropEvent } from './promptChatDropBus'
import type { CanvasStore } from './konva/canvasStore'

export interface PromptChatDropResult {
  event: PromptChatDropEvent
  position: { x: number; y: number }
}

const unavailable: PromptChatDropEvent = {
  kind: 'error',
  message: "This object cannot be used as a reference yet",
}

/** Read the whole gesture from the board, including culled group members. */
export function createPromptChatGroupDrop(
  store: Pick<CanvasStore, 'getItem' | 'getPending'>,
  ids: readonly string[],
): PromptChatDropEvent | null {
  const results = [...new Set(ids)].flatMap((id) => {
    const result = createPromptChatDropResult(store.getItem(id), store.getPending().find((item) => item.id === id))
    return result ? [result.event] : []
  })
  const refs = results.flatMap((event) => event.kind === 'reference' ? [event.ref] : [])
  return refs.length ? { kind: 'references', refs } : results[0] ?? null
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

import type { SelectionRef } from './konva/selection'

export type PromptChatDropEvent =
  | { kind: 'reference'; ref: SelectionRef }
  | { kind: 'error'; message: string }

export interface PromptChatDropHandler {
  drop(event: PromptChatDropEvent): void
  hover(active: boolean): void
}

let activeHandler: PromptChatDropHandler | null = null

export function registerPromptChatDropHandler(
  handler: PromptChatDropHandler | null,
): () => void {
  activeHandler = handler
  return () => {
    if (activeHandler === handler) activeHandler = null
  }
}

export function requestPromptChatDrop(event: PromptChatDropEvent): boolean {
  if (!activeHandler) return false
  activeHandler.drop(
    event.kind === 'reference'
      ? { kind: 'reference', ref: { ...event.ref } }
      : { ...event },
  )
  return true
}

export function notifyPromptChatDropHover(active: boolean): void {
  activeHandler?.hover(active)
}

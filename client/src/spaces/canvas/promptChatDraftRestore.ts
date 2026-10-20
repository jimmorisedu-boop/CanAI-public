import type { PromptChatDraft } from './promptChatTypes'

/**
 * When Discuss opens before the first conversation is loaded, edits are held
 * locally. Restore them only for that first active conversation; a deliberate
 * switch between already-loaded conversations must still use its own draft.
 */
export function pendingDiscussDraftToRestore(input: {
  pending: PromptChatDraft | null
  wasOpen: boolean
  previousConversationId: string | null
  activeConversationId: string | null
}): PromptChatDraft | null {
  if (!input.pending || !input.wasOpen || input.previousConversationId !== null || !input.activeConversationId) {
    return null
  }
  return structuredClone(input.pending)
}

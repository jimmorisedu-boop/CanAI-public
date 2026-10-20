import type { SelectionRef } from './konva/selection'
import type {
  PromptChatDraft,
  PromptChatAttachment,
} from './promptChatTypes'

const EMPTY_DRAFT: PromptChatDraft = {
  text: '',
  attachments: [],
  selectionStart: 0,
  selectionEnd: 0,
}

export type PromptEnterAction = 'ask' | 'generate'

export function resolvePromptEnterAction(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  chatOpen: boolean,
): PromptEnterAction | null {
  if (event.key !== 'Enter') return null
  if (event.altKey) return 'ask'
  if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return null
  return chatOpen ? 'ask' : 'generate'
}

export function activateConversationDraft(
  drafts: Record<string, PromptChatDraft>,
  conversationId: string | null,
): PromptChatDraft {
  return structuredClone(
    (conversationId ? drafts[conversationId] : undefined) ?? EMPTY_DRAFT,
  )
}

function attachmentFromRef(ref: SelectionRef): PromptChatAttachment {
  return {
    shapeId: ref.shapeId,
    ...(ref.assetId !== undefined ? { assetId: ref.assetId } : {}),
    kind: ref.kind,
    label: ref.label,
    ...(ref.src !== undefined ? { src: ref.src } : {}),
    ...(ref.text !== undefined ? { text: ref.text } : {}),
    ...(ref.w !== undefined ? { width: ref.w } : {}),
    ...(ref.h !== undefined ? { height: ref.h } : {}),
  }
}

export function refsFromConversationDraft(draft: PromptChatDraft): SelectionRef[] {
  return draft.attachments.map((attachment) => ({
    shapeId: attachment.shapeId,
    ...(attachment.assetId !== undefined ? { assetId: attachment.assetId } : {}),
    kind: attachment.kind,
    label: attachment.label,
    src: attachment.src,
    text: attachment.text,
    w: attachment.width,
    h: attachment.height,
  }))
}

export function draftFromComposer(
  text: string,
  refs: SelectionRef[],
  selectionStart: number,
  selectionEnd: number,
): PromptChatDraft {
  const safeStart = Math.max(0, Math.min(text.length, selectionStart))
  const safeEnd = Math.max(safeStart, Math.min(text.length, selectionEnd))
  return {
    text,
    attachments: refs.map(attachmentFromRef),
    selectionStart: safeStart,
    selectionEnd: safeEnd,
  }
}

import type { PromptChatStoreDeps } from './promptChatStore.js'

export type PromptChatHttpTransport = Pick<PromptChatStoreDeps,
  | 'listPromptChats' | 'createPromptChat' | 'loadPromptChatPage' | 'patchPromptChat'
  | 'setPromptChatPreferences'
  | 'activatePromptChat' | 'estimatePromptChatMessage' | 'sendPromptChatMessage'
  | 'recordPromptChatMessage' | 'appendPromptChatHistoryMessages'
  | 'rebuildPromptChatContext' | 'trashPromptChat' | 'listPromptChatTrash'
  | 'restorePromptChat' | 'deletePromptChatPermanent'
>

function target(
  key: string,
  local: PromptChatHttpTransport,
  cloudSource: PromptChatHttpTransport | (() => PromptChatHttpTransport),
): { id: string; api: PromptChatHttpTransport } {
  const cloud = typeof cloudSource === 'function' ? cloudSource() : cloudSource
  if (key.startsWith('cloud:')) return { id: key.slice('cloud:'.length), api: cloud }
  if (key.startsWith('local:')) return { id: key.slice('local:'.length), api: local }
  return { id: key, api: local }
}

export function createPromptChatTransport(
  local: PromptChatHttpTransport,
  cloud: PromptChatHttpTransport | (() => PromptChatHttpTransport),
): PromptChatHttpTransport {
  return {
    listPromptChats: (key) => { const t = target(key, local, cloud); return t.api.listPromptChats(t.id) },
    setPromptChatPreferences: (key, patch) => {
      const t = target(key, local, cloud)
      if (!t.api.setPromptChatPreferences) {
        return Promise.resolve({
          index: { version: 2, revision: 0, activeConversationId: null, conversations: [], hasTrash: false },
          boardMemoryControlSupported: false,
        })
      }
      return t.api.setPromptChatPreferences(t.id, patch)
    },
    createPromptChat: (key, requestId) => { const t = target(key, local, cloud); return t.api.createPromptChat(t.id, requestId) },
    loadPromptChatPage: (key, conversationId, before) => { const t = target(key, local, cloud); return t.api.loadPromptChatPage(t.id, conversationId, before) },
    patchPromptChat: (key, conversationId, requestId, patch) => { const t = target(key, local, cloud); return t.api.patchPromptChat(t.id, conversationId, requestId, patch) },
    activatePromptChat: (key, conversationId, requestId) => { const t = target(key, local, cloud); return t.api.activatePromptChat(t.id, conversationId, requestId) },
    estimatePromptChatMessage: (key, conversationId, text, attachments, boardMemoryEnabled) => {
      const t = target(key, local, cloud)
      return t.api.estimatePromptChatMessage(t.id, conversationId, text, attachments, boardMemoryEnabled)
    },
    sendPromptChatMessage: (key, conversationId, input) => { const t = target(key, local, cloud); return t.api.sendPromptChatMessage(t.id, conversationId, input) },
    recordPromptChatMessage: (key, conversationId, input) => { const t = target(key, local, cloud); return t.api.recordPromptChatMessage(t.id, conversationId, input) },
    appendPromptChatHistoryMessages: (key, conversationId, input) => { const t = target(key, local, cloud); return t.api.appendPromptChatHistoryMessages(t.id, conversationId, input) },
    rebuildPromptChatContext: (key, conversationId) => { const t = target(key, local, cloud); return t.api.rebuildPromptChatContext(t.id, conversationId) },
    trashPromptChat: (key, conversationId, requestId) => { const t = target(key, local, cloud); return t.api.trashPromptChat(t.id, conversationId, requestId) },
    listPromptChatTrash: (key) => { const t = target(key, local, cloud); return t.api.listPromptChatTrash(t.id) },
    restorePromptChat: (key, conversationId, requestId) => { const t = target(key, local, cloud); return t.api.restorePromptChat(t.id, conversationId, requestId) },
    deletePromptChatPermanent: (key, conversationId, requestId) => { const t = target(key, local, cloud); return t.api.deletePromptChatPermanent(t.id, conversationId, requestId) },
  }
}

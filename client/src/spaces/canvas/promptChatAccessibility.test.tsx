import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantShelf } from './AssistantShelf'
import { PromptChatDrawer } from './PromptChatDrawer'
import { CanvasStore } from './konva/canvasStore'
import { promptChatStore } from './promptChatStore'

test('чат сообщает модель, ленту и непрочитанный ответ без зависимости от цвета', () => {
  const shelf = renderToStaticMarkup(
    <AssistantShelf
      projectId="accessibility"
      store={new CanvasStore()}
      models={[{
        id: 'gemini',
        name: 'Gemini',
        kind: 'text',
        refs: false,
        params: [],
      }]}
      height={400}
    />,
  )
  const drawer = renderToStaticMarkup(
    <PromptChatDrawer
      open
      conversations={[{
        id: 'c1',
        title: 'Кампания',
        createdAt: 1,
        updatedAt: 2,
        preview: 'Ответ готов',
        attention: 'unread',
      }]}
      activeId={null}
      trash={[]}
      onClose={() => {}}
      onCreate={() => {}}
      onSelect={() => {}}
      onRename={() => {}}
      onTrash={() => {}}
      onRestore={() => {}}
      onPermanentDelete={() => {}}
    />,
  )

  assert.match(shelf, /aria-label="Chat model"/)
  assert.match(shelf, /aria-live="polite"/)
  assert.match(drawer, /New response/)
})

test('активный ответ показывает статус без второй кнопки «Стоп»', () => {
  const projectId = 'accessibility-running'
  const snapshot = promptChatStore.getSnapshot(projectId)
  snapshot.loadState = 'ready'
  snapshot.activeId = 'conversation-running'
  snapshot.active = {
    meta: {
      version: 2,
      revision: 1,
      id: 'conversation-running',
      projectId,
      title: 'Активный диалог',
      selectedModelId: 'gemini',
      createdAt: 1,
      updatedAt: 1,
      draft: { text: '', attachments: [], selectionStart: 0, selectionEnd: 0 },
      activeJobIds: [],
    },
    messages: [{
      id: 'assistant-running',
      role: 'assistant',
      text: '',
      createdAt: Date.now(),
      status: 'running',
    }],
    before: null,
    contextHealth: 'ready',
  }

  const active = renderToStaticMarkup(
    <AssistantShelf
      projectId={projectId}
      store={new CanvasStore()}
      models={[]}
      height={400}
    />,
  )

  assert.match(active, /role="status"/)
  assert.match(active, /Writing prompt…/)
  assert.doesNotMatch(active, /Stop/)
})

test('готовый промпт оставляет одно главное действие', () => {
  const projectId = 'accessibility-calm-reading'
  const snapshot = promptChatStore.getSnapshot(projectId)
  snapshot.loadState = 'ready'
  snapshot.activeId = 'conversation-calm-reading'
  snapshot.active = {
    meta: {
      version: 2,
      revision: 1,
      id: 'conversation-calm-reading',
      projectId,
      title: 'Спокойное чтение',
      selectedModelId: 'gemini',
      createdAt: 1,
      updatedAt: 1,
      draft: { text: '', attachments: [], selectionStart: 0, selectionEnd: 0 },
      activeJobIds: [],
    },
    messages: [{
      id: 'assistant-done',
      role: 'assistant',
      text: '',
      reply: 'Готовый ответ',
      prompts: [{ title: 'Киберпанк улица', prompt: 'A calm prompt' }],
      createdAt: 1,
      status: 'done',
      modelId: 'gemini',
    }],
    before: null,
    contextHealth: 'ready',
  }

  const html = renderToStaticMarkup(
    <AssistantShelf
      projectId={projectId}
      store={new CanvasStore()}
      models={[{
        id: 'gemini',
        name: 'Gemini',
        kind: 'text',
        refs: false,
        params: [],
      }]}
      height={400}
    />,
  )

  assert.equal((html.match(/prompt-chat-action icon-tab primary/g) ?? []).length, 1)
  assert.match(html, /class="prompt-chat-action icon-tab primary"[^>]*>[\s\S]*?Use prompt<\/button>/)
  assert.match(html, /class="prompt-chat-action icon-tab"[^>]*>[\s\S]*?Copy<\/button>/)
  assert.match(html, /class="prompt-chat-action icon-tab"[^>]*>[\s\S]*?Add to canvas<\/button>/)
})

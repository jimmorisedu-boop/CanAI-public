import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasItem, Placeholder } from './konva/types'
import { createPromptChatDropResult } from './promptChatDrop'

test('готовый объект превращается в референс с исходной позицией', () => {
  const item: CanvasItem = {
    id: 'image-1',
    kind: 'image',
    x: 10,
    y: 20,
    w: 100,
    h: 80,
    src: '/media/ref.png',
    name: 'Референс',
  }

  assert.deepEqual(createPromptChatDropResult(item), {
    event: {
      kind: 'reference',
      ref: {
        shapeId: 'image-1',
        kind: 'image',
        label: 'Референс',
        src: '/media/ref.png',
        w: 100,
        h: 80,
      },
    },
    position: { x: 10, y: 20 },
  })
})

test('pending-карточка возвращается на место с понятной ошибкой', () => {
  const pending: Placeholder = {
    id: 'pending-1',
    kind: 'image',
    x: 30,
    y: 40,
    w: 120,
    h: 120,
    label: 'Модель',
    status: 'loading',
    startedAt: 1,
  }

  assert.deepEqual(createPromptChatDropResult(undefined, pending), {
    event: {
      kind: 'error',
      message: 'This object cannot be used as a reference yet',
    },
    position: { x: 30, y: 40 },
  })
})

test('карточка ссылки просит сначала скачать медиа', () => {
  const link: CanvasItem = {
    id: 'link-1',
    kind: 'link',
    x: 50,
    y: 60,
    w: 320,
    h: 280,
    link: {
      url: 'https://www.instagram.com/p/test/',
      normalizedUrl: 'https://www.instagram.com/p/test/',
      provider: 'instagram',
      sourceLabel: 'Instagram',
      entries: [],
      state: 'ready',
    },
  }

  assert.deepEqual(createPromptChatDropResult(link), {
    event: {
      kind: 'error',
      message: 'This link is not a reference — download the media first',
    },
    position: { x: 50, y: 60 },
  })
})

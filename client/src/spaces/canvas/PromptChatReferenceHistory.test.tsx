import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SelectionRef } from './konva/selection'
import { PromptChatReferenceHistory } from './PromptChatReferenceHistory'

test('chat history shows saved image, video, and text references without composer actions', () => {
  const refs: SelectionRef[] = [
    { shapeId: 'image', kind: 'image', label: 'Кадр', src: '/media/history.png' },
    { shapeId: 'video', kind: 'video', label: 'Ролик', src: '/media/clip.mp4' },
    { shapeId: 'text', kind: 'text', label: 'Мягкий свет', text: 'Мягкий свет' },
  ]

  const html = renderToStaticMarkup(<PromptChatReferenceHistory refs={refs} />)

  assert.match(html, /class="prompt-chat-reference-history ref-chips"/)
  // Local images use the bounded screen preview path; the source media URL is
  // still retained by the reference for generation and export.
  assert.match(html, /src="\/media\/preview\/history\.png\?w=256"/)
  assert.match(html, /src="\/media\/clip\.mp4"/)
  assert.match(html, /Мягкий свет/)
  assert.equal((html.match(/class="ref-chip"/g) ?? []).length, 3)
  assert.doesNotMatch(html, /role="button"/)
  assert.doesNotMatch(html, /tabindex=/)
})

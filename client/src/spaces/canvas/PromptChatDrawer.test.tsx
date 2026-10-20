import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PromptChatDrawer } from './PromptChatDrawer'
import type { PromptChatSummary } from './promptChatTypes'

function conversations(count: number): PromptChatSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    title: index === 0 ? 'Кампания' : `Диалог ${index + 1}`,
    createdAt: index,
    updatedAt: count - index,
    preview: index === 0 ? 'Сделать мягкий свет' : '',
    attention: index === 1 ? 'running' : 'idle',
  }))
}

function render(count: number): string {
  return renderToStaticMarkup(
    <PromptChatDrawer
      open
      conversations={conversations(count)}
      activeId="c0"
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
}

test('drawer имеет лаконичную семантику и не показывает ранний поиск', () => {
  const html = render(7)
  assert.match(html, /aria-label="Chats"/)
  assert.match(html, />New chat</)
  assert.match(html, /aria-label="Chat actions “Кампания”"/)
  assert.match(html, /aria-current="true"/)
  assert.doesNotMatch(html, /Search by title/)
})

test('с восьми диалогов появляется поиск и доступный статус фоновой задачи', () => {
  const html = render(8)
  assert.match(html, /aria-label="Search by title"/)
  assert.match(html, /Assistant is responding/)
})

test('закрытый drawer не оставляет интерактивной разметки', () => {
  const html = renderToStaticMarkup(
    <PromptChatDrawer
      open={false}
      conversations={conversations(8)}
      activeId="c0"
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
  assert.equal(html, '')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TextEditOverlay } from './TextEditOverlay'
import type { CanvasStore } from './canvasStore'
import type { CanvasItem } from './types'

function renderOverlay(overrides: Partial<CanvasItem> = {}): string {
  const item: CanvasItem = {
    id: 'multiline-text',
    kind: 'text',
    x: 40,
    y: 60,
    w: 640,
    h: 420,
    fontSize: 48,
    text: 'заменить на норм\nи меньше улыбиться',
    ...overrides,
  }
  const store = {
    getCamera: () => ({ x: 0, y: 0, scale: 1 }),
  } as CanvasStore

  return renderToStaticMarkup(
    <TextEditOverlay store={store} item={item} onClose={() => {}} />,
  )
}

test('редактор сохраняет форму существующего текста с переносами', () => {
  const html = renderOverlay()

  assert.match(html, /width:640px/)
  assert.match(html, /height:420px/)
})

test('переполненный редактор сообщает о скрытом тексте и включает прокрутку', () => {
  const html = renderOverlay({
    w: 260,
    h: 90,
    fontSize: 32,
    text: 'первая строка\nвторая строка\nтретья строка',
  })

  assert.match(html, /text-edit-overlay is-overflowing/)
  assert.match(html, /aria-describedby="text-overflow-multiline-text"/)
  assert.match(html, /Part of the text is hidden; scroll to see it/)
})

test('помещающийся текст не получает ложный индикатор', () => {
  const html = renderOverlay({ w: 640, h: 420, fontSize: 32, text: 'одна строка' })

  assert.doesNotMatch(html, /is-overflowing/)
  assert.doesNotMatch(html, /Part of the text is hidden/)
})

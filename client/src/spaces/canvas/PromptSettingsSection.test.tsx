import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PromptSettingsSection } from './PromptSettingsSection'

function render(compact: boolean, open = false, attention = false): string {
  return renderToStaticMarkup(
    <PromptSettingsSection
      compact={compact}
      open={open}
      attention={attention}
      onOpenChange={() => {}}
    >
      <label>Модель <select aria-label="Модель"><option>Flux</option></select></label>
    </PromptSettingsSection>,
  )
}

test('обычный режим показывает параметры без лишнего раскрытия', () => {
  const html = render(false)

  assert.doesNotMatch(html, />Parameters</)
  assert.match(html, /aria-label="Модель"/)
})

test('компактный режим прячет параметры за понятной кнопкой', () => {
  const html = render(true, false, true)

  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /data-attention="true"/)
  assert.match(html, /hidden=""/)
  assert.match(html, /aria-label="Модель"/)
})

test('раскрытые компактные параметры образуют подписанную область', () => {
  const html = render(true, true)

  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /role="region"/)
  assert.match(html, /aria-label="Generation parameters"/)
  assert.match(html, /aria-label="Модель"/)
})

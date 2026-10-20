import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NodesCompactToolbar } from './NodesCompactToolbar'

function render(defaultMenuOpen = false, attention = false): string {
  return renderToStaticMarkup(
    <NodesCompactToolbar
      name="Рекламный ролик"
      placeholder="Макрос 1"
      loaded
      attention={attention}
      defaultMenuOpen={defaultMenuOpen}
      onBack={() => {}}
      onNameChange={() => {}}
      addActions={<button type="button">Image</button>}
      validationAction={<button type="button">Validate</button>}
      saveAction={<button type="button">Save</button>}
      deleteAction={<button type="button">Delete</button>}
    />,
  )
}

test('компактная панель всегда оставляет возврат, название и Ещё', () => {
  const html = render(false, true)

  assert.match(html, /Canvas<\/button>/)
  assert.match(html, /aria-label="Macro name"/)
  assert.match(html, /value="Рекламный ролик"/)
  assert.match(html, /aria-label="More"/)
  assert.match(html, /data-attention="true"/)
  assert.match(html, /hidden=""/)
})

test('открытое меню содержит добавление, проверку, сохранение и удаление', () => {
  const html = render(true)
  const labels = ['Add node', 'Image', 'Validate', 'Save', 'Delete']
  let cursor = -1

  for (const label of labels) {
    const next = html.indexOf(label, cursor + 1)
    assert.ok(next > cursor, `${label} должно идти после предыдущего раздела`)
    cursor = next
  }
  assert.doesNotMatch(html, /hidden=""/)
})

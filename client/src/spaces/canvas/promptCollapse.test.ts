import assert from 'node:assert/strict'
import test from 'node:test'
import { promptCollapseKey } from './usePromptCollapse'

const event = (patch: Partial<KeyboardEvent> = {}) => ({
  key: 's', code: 'KeyS', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
  defaultPrevented: false, repeat: false, isComposing: false, composedPath: () => [], ...patch,
}) as unknown as KeyboardEvent

test('панель: физическая S работает на любой раскладке, Ы — запасной путь', () => {
  for (const key of ['s', 'S', 'ы', 'Ы', 'ش']) assert.equal(promptCollapseKey(event({ key }), null), true)
  assert.equal(promptCollapseKey(event({ key: 'ы', code: '' }), null), true)
  assert.equal(promptCollapseKey(event({ key: 'a', code: 'KeyA' }), null), false)
})

test('панель не перехватывает сочетания, автоповтор, IME и уже обработанные события', () => {
  for (const flag of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey', 'repeat', 'isComposing', 'defaultPrevented']) {
    assert.equal(promptCollapseKey(event({ [flag]: true }), null), false, flag)
  }
})

test('ввод защищён по фокусу и полному пути события, включая вложенный редактор', () => {
  for (const selector of ['input', 'textarea', 'select', '[contenteditable]', '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]']) {
    const field = { closest: (query: string) => query.includes(selector) ? {} : null } as unknown as Element
    assert.equal(promptCollapseKey(event(), field), false, selector)
    assert.equal(promptCollapseKey(event({ composedPath: () => [field] }), null), false, selector)
  }
  const editable = { isContentEditable: true } as unknown as Element
  assert.equal(promptCollapseKey(event(), editable), false)
  assert.equal(promptCollapseKey(event(), { closest: () => null } as unknown as Element), true, 'обычная кнопка разрешена')
})

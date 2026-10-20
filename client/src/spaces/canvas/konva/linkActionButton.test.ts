import assert from 'node:assert/strict'
import test from 'node:test'
import { linkActionButtonStyle, setLinkActionButtonCursor } from './linkActionButton.js'

test('hover changes both neutral and primary button surfaces', () => {
  assert.notDeepEqual(linkActionButtonStyle(false, false), linkActionButtonStyle(false, true))
  assert.notDeepEqual(linkActionButtonStyle(true, false), linkActionButtonStyle(true, true))
})

test('главная кнопка красится акцентом темы, а не зашитым цветом', () => {
  // Карточка ссылки жила на старом оранжевом #ff6038, когда весь остальной
  // интерфейс уже перешёл на вермилион, — и выглядела деталью из другого
  // приложения. Цвет обязан приходить сверху, из токенов.
  const themed = linkActionButtonStyle(true, false, { base: '#d33f21', hover: '#bd3518' })
  assert.equal(themed.fill, '#d33f21')
  assert.equal(linkActionButtonStyle(true, true, { base: '#d33f21', hover: '#bd3518' }).fill, '#bd3518')

  // Вторая кнопка нейтральна при любом акценте: акцент — на одно действие
  const neutral = linkActionButtonStyle(false, false, { base: '#d33f21', hover: '#bd3518' })
  assert.equal(neutral.fill.includes('127'), true)
})


test('hover owns and restores the stage pointer cursor', () => {
  const container = { style: { cursor: '' } } as HTMLElement
  setLinkActionButtonCursor(container, true)
  assert.equal(container.style.cursor, 'pointer')
  setLinkActionButtonCursor(container, false)
  assert.equal(container.style.cursor, '')
})

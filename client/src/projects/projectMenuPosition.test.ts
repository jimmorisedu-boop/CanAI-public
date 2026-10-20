import assert from 'node:assert/strict'
import test from 'node:test'
import { positionProjectMenu } from './projectMenuPosition'

const viewport = { left: 0, top: 0, width: 800, height: 500 }

test('меню карточки у нижнего края раскрывается вверх и целиком остаётся в окне', () => {
  const anchor = { left: 700, right: 728, top: 460, bottom: 488 }
  const menu = { width: 160, height: 200 }
  const result = positionProjectMenu(anchor, menu, viewport)
  assert.equal(result.opensUp, true)
  assert.ok(result.top >= 8 && result.top + menu.height <= anchor.top - 4)
  assert.ok(result.left >= 8 && result.left + menu.width <= viewport.width - 8)
})

test('меню у верхнего и левого края раскрывается вниз без выхода за окно', () => {
  const anchor = { left: 0, right: 28, top: 4, bottom: 32 }
  const result = positionProjectMenu(anchor, { width: 160, height: 200 }, viewport)
  assert.equal(result.opensUp, false)
  assert.equal(result.left, 8)
  assert.ok(result.top > anchor.bottom && result.top + 200 <= viewport.height - 8)
})

test('в низком узком окне меню получает пределы для внутренней прокрутки', () => {
  const small = { left: 0, top: 0, width: 140, height: 160 }
  const result = positionProjectMenu({ left: 100, right: 128, top: 120, bottom: 148 }, { width: 160, height: 300 }, small)
  assert.equal(result.opensUp, true)
  assert.equal(result.maxWidth, 124)
  assert.ok(result.maxHeight > 0 && result.maxHeight < 300)
  assert.ok(result.top >= 8 && result.top + result.maxHeight <= 120 - 4)
})

test('позиция учитывает смещение видимой области при масштабировании страницы', () => {
  const shifted = { left: 100, top: 80, width: 400, height: 300 }
  const result = positionProjectMenu({ left: 450, right: 478, top: 330, bottom: 358 }, { width: 160, height: 200 }, shifted)
  assert.ok(result.left >= shifted.left + 8)
  assert.ok(result.left + 160 <= shifted.left + shifted.width - 8)
  assert.ok(result.top >= shifted.top + 8 && result.top + 200 <= shifted.top + shifted.height - 8)
})

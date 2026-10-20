// @ts-expect-error Client production build does not depend on Node typings.
import assert from 'node:assert/strict'
// @ts-expect-error Client production build does not depend on Node typings.
import test from 'node:test'
import { linkItemLayout, linkItemScale } from './linkItemLayout.js'

test('standard 360×280 card keeps text above aligned actions', () => {
  const layout = linkItemLayout(360, 280)
  assert(layout.title.y + layout.title.height <= layout.url.y)
  assert(layout.url.y + layout.url.height < layout.openButton.y)
  assert.equal(layout.openButton.y, layout.downloadButton.y)
  assert.equal(layout.openButton.height, layout.downloadButton.height)
  assert.equal(layout.openButton.width, layout.downloadButton.width)
  assert(layout.downloadButton.x + layout.downloadButton.width <= 360)
})

test('compact resized card hides text before overlapping actions', () => {
  const layout = linkItemLayout(240, 190)
  assert(layout.preview.height >= 64)
  assert(layout.title.height >= 0)
  assert(layout.url.y + layout.url.height <= layout.openButton.y)
  assert(layout.openButton.y + layout.openButton.height <= 190)
})

test('карточка растёт целиком: кнопки и поля тянутся вместе с ней', () => {
  // Жалоба 19.08.2026: «при растягивании кнопки становятся больше, а текст
  // меньше». Ширина кнопок шла за карточкой, а высоты и кегли стояли числами.
  const small = linkItemLayout(360, 280)
  const big = linkItemLayout(720, 560)
  assert(big.openButton.height > small.openButton.height, 'кнопка обязана вырасти в высоту, а не только в ширину')
  assert(big.badge.height > small.badge.height)
  assert(linkItemScale(720, 560) > linkItemScale(360, 280))
})

test('множитель берётся от меньшей стороны и не уходит в крайности', () => {
  // Широкая и низкая карточка не должна раздувать шрифт.
  assert.equal(linkItemScale(1200, 280), linkItemScale(280, 280))
  assert(linkItemScale(60, 40) >= 0.75, 'на крошечной карточке текст не исчезает')
  assert(linkItemScale(4000, 4000) <= 2, 'на огромной не превращается в плакат')
})

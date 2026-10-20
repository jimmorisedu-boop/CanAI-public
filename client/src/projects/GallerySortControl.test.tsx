import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GallerySortControl, GallerySortMenu } from './GallerySortControl'

test('закрытая сортировка использует одну кнопку вместо системного select', () => {
  const html = renderToStaticMarkup(<GallerySortControl value="recent" onChange={() => {}} />)

  assert.match(html, /aria-haspopup="listbox"/)
  assert.match(html, /Sort/)
  assert.match(html, /Recent/)
  assert.doesNotMatch(html, /<select/)
})

test('открытое меню объявляет три варианта и текущее значение', () => {
  const html = renderToStaticMarkup(
    <GallerySortMenu value="name" active="created" onSelect={() => {}} />,
  )

  assert.match(html, /role="listbox"/)
  assert.equal((html.match(/role="option"/g) ?? []).length, 3)
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1)
  assert.match(html, /Name/)
  assert.match(html, /Newest/)
})

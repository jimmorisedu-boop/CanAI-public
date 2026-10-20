// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import { moveGallerySort } from './gallerySortModel'

test('стрелки циклически перемещают активный вариант сортировки', () => {
  assert.equal(moveGallerySort('recent', 'ArrowDown'), 'name')
  assert.equal(moveGallerySort('recent', 'ArrowUp'), 'created')
})

test('Home и End переходят к краям списка сортировки', () => {
  assert.equal(moveGallerySort('name', 'Home'), 'recent')
  assert.equal(moveGallerySort('name', 'End'), 'created')
})

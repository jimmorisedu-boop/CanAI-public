import test from 'node:test'
import assert from 'node:assert/strict'
import { PREVIEW_WIDTH, refChipPreviewPosition } from './refChipPreviewPos'

const VIEWPORT = { width: 1200, height: 800 }

function chip(top: number, left: number): { top: number; bottom: number; left: number; right: number } {
  return { top, bottom: top + 32, left, right: left + 40 }
}

test('места сверху хватает — превью над чипом, отсчёт от низа окна', () => {
  const place = refChipPreviewPosition(chip(600, 500), VIEWPORT)
  assert.equal(place.placement, 'top')
  assert.equal(place.offset, VIEWPORT.height - 600 + 8)
  assert.equal(place.maxMediaHeight, 200)
})

test('чип у верхней кромки — превью уходит вниз, отсчёт от верха окна', () => {
  const place = refChipPreviewPosition(chip(20, 500), VIEWPORT)
  assert.equal(place.placement, 'bottom')
  assert.equal(place.offset, 20 + 32 + 8)
})

test('превью центрируется по чипу и не вылезает за края окна', () => {
  const centered = refChipPreviewPosition(chip(600, 500), VIEWPORT)
  assert.equal(centered.left, 520 - PREVIEW_WIDTH / 2)

  assert.equal(refChipPreviewPosition(chip(600, 0), VIEWPORT).left, 8)
  assert.equal(
    refChipPreviewPosition(chip(600, 1180), VIEWPORT).left,
    VIEWPORT.width - PREVIEW_WIDTH - 8,
  )
})

test('в тесноте картинка ужимается, но не ниже пола', () => {
  // сверху 100px, снизу 668 — уходим вниз и берём полный размер
  const low = refChipPreviewPosition(chip(100, 500), VIEWPORT)
  assert.equal(low.placement, 'bottom')
  assert.equal(low.maxMediaHeight, 200)

  // окно-щель: с обеих сторон тесно — берём сторону, где просторнее, и ужимаемся
  const tight = refChipPreviewPosition(chip(60, 500), { width: 1200, height: 160 })
  assert.equal(tight.placement, 'bottom')
  assert.ok(tight.maxMediaHeight < 200)
  assert.ok(tight.maxMediaHeight >= 60)

  const nowhere = refChipPreviewPosition(chip(10, 500), { width: 1200, height: 60 })
  assert.equal(nowhere.maxMediaHeight, 60)
})

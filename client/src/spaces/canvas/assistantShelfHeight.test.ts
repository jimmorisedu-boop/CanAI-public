import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampShelfHeight,
  resizeShelfHeight,
  SHELF_DEFAULT_HEIGHT,
  SHELF_MIN_HEIGHT,
} from './assistantShelfHeight'

test('окно помощника не ниже минимума и влезает в доступное место', () => {
  assert.equal(clampShelfHeight(40, 720), SHELF_MIN_HEIGHT)
  assert.equal(clampShelfHeight(300, 720), 300)
  // потолок — не 70% окна (504), а то, что реально остаётся после топ-бара,
  // самого промпт-бара и отступов: иначе верх ленты срезается overflow:hidden
  assert.equal(clampShelfHeight(9000, 720), 470)
})

test('историю можно свернуть до строки заголовка, освобождая холст', () => {
  assert.equal(clampShelfHeight(72, 720), 72)
  assert.equal(resizeShelfHeight(280, 300, 508, 720), 72)
  assert.equal(resizeShelfHeight(72, 508, 300, 720), 280)
})

test('в большом окне работает процентный потолок', () => {
  // 70% от 1400 = 980 меньше, чем доступные 1150 — значит ограничивает процент
  assert.equal(clampShelfHeight(9000, 1400), 980)
})

test('в низком окне минимум важнее и процента, и запаса', () => {
  assert.equal(clampShelfHeight(400, 200), SHELF_MIN_HEIGHT)
})

test('битое значение откатывается к высоте по умолчанию', () => {
  assert.equal(clampShelfHeight(Number.NaN, 720), SHELF_DEFAULT_HEIGHT)
  // но и дефолт не может превысить доступное место: в окне 500px под ленту
  // остаётся ровно 250px (500 − топ-бар, бар и отступы)
  assert.equal(clampShelfHeight(Number.NaN, 500), 250)
})

test('тяга вверх увеличивает окно, вниз — уменьшает', () => {
  assert.equal(resizeShelfHeight(280, 500, 400, 1000), 380)
  assert.equal(resizeShelfHeight(380, 400, 500, 1000), 280)
  // ниже минимума не пускаем даже при резком движении вниз
  assert.equal(resizeShelfHeight(280, 400, 900, 1000), SHELF_MIN_HEIGHT)
  // и выше доступного места тоже: шапка окна не должна уехать за край
  assert.equal(resizeShelfHeight(280, 700, 0, 720), 470)
})

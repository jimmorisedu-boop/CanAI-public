// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { snapMovingBoxes, snapResizedBox, unionBox, type SnapBox } from './snapMath.js'

const box = (x: number, y: number, w = 100, h = 100) => ({ x, y, w, h })

test('липнет ближайшая пара краёв, а не первая попавшаяся', () => {
  const сосед = box(300, 0)
  // левый край рамки в 4px от левого края соседа — прилипнет к нему
  const результат = snapMovingBoxes([box(296, 0)], [сосед], 6)
  assert.equal(результат.dx, 4)
  assert.equal(результат.dy, 0)
})

test('дальше порога не липнет вовсе', () => {
  // и по Y разводим: у ровно совпадающих верхов расстояние 0, это тоже прилипание
  const результат = snapMovingBoxes([box(280, 0)], [box(300, 500)], 6)
  assert.deepEqual({ dx: результат.dx, dy: результат.dy }, { dx: 0, dy: 0 })
  assert.deepEqual(результат.guides, [])
})

test('центры тоже липнут, и по обеим осям сразу', () => {
  // центр рамки в 3px от центра соседа по X и в 2px по Y
  const результат = snapMovingBoxes([box(3, 2)], [box(0, 0)], 6)
  assert.equal(результат.dx, -3)
  assert.equal(результат.dy, -2)
  assert.equal(результат.guides.length, 2)
})

// ⚠️ Заголовок этого теста раньше гласил «группа выравнивается ОБЩЕЙ рамкой,
// А НЕ схваченным объектом» — то самое правило, которое 26.08.2026 признано
// половиной беды: с ним направляющие почти переставали появляться. Теперь
// якорями служат ОБА, и тест проверяет именно это.
test('у группы якорь — и общая рамка, и каждый объект в ней', () => {
  const стопка = [box(0, 0), box(200, 0)]
  assert.deepEqual(unionBox(стопка), { x: 0, y: 0, w: 300, h: 100 })

  // совпадает ПРАВЫЙ край общей рамки (300) — липнет она целиком
  const порамке = snapMovingBoxes(стопка, [box(4, 400, 300, 50)], 6)
  assert.equal(порамке.dx, 4, 'вся стопка встаёт по краю соседа')

  // а здесь совпадает левый край ВТОРОЙ картинки (200), общая рамка — ни с чем
  const пообъекту = snapMovingBoxes(стопка, [box(203, 400, 40, 50)], 6)
  assert.equal(пообъекту.dx, 3, 'отдельный объект тоже якорь')
})

test('общая рамка одного объекта — он сам', () => {
  assert.deepEqual(unionBox([box(10, 20, 30, 40)]), { x: 10, y: 20, w: 30, h: 40 })
})

test('пустой список не ломает арифметику', () => {
  assert.deepEqual(unionBox([]), { x: 0, y: 0, w: 0, h: 0 })
  const результат = snapMovingBoxes([box(0, 0)], [], 6)
  assert.deepEqual({ dx: результат.dx, dy: результат.dy, guides: результат.guides }, { dx: 0, dy: 0, guides: [] })
})

test('направляющая тянется через оба объекта, а не только через рамку', () => {
  const результат = snapMovingBoxes([box(0, 0)], [box(0, 300)], 6)
  const [вертикальная] = результат.guides
  assert.deepEqual(вертикальная, [0, 0, 0, 400], 'от верха рамки до низа соседа')
})

// ── Прилипание при ИЗМЕНЕНИИ РАЗМЕРА (просьба 09.09.2026) ────────────────────

test('липнет только тот край, который двигают', () => {
  const origin: SnapBox = { x: 0, y: 0, w: 100, h: 100 }
  // Тянем правый край к 204 — рядом сосед с левым краем на 205.
  const result = snapResizedBox({ x: 0, y: 0, w: 204, h: 100 }, origin, [
    { x: 205, y: 0, w: 50, h: 100 },
  ], 6)
  assert.equal(result.box.w, 205, 'правый край дотянулся до соседа')
  assert.equal(result.box.x, 0, 'левый край стоял и остался на месте')
  assert.equal(result.guides.length, 1)
})

test('неподвижный край не липнет, даже если рядом сосед', () => {
  const origin: SnapBox = { x: 100, y: 0, w: 100, h: 100 }
  // Левый край на 100 в двух пикселях от соседа, но тянут ПРАВЫЙ.
  const result = snapResizedBox({ x: 100, y: 0, w: 160, h: 100 }, origin, [
    { x: 98, y: 0, w: 1, h: 100 },
  ], 6)
  assert.equal(result.box.x, 100, 'стоящий край нельзя двигать — объект уехал бы из-под ручки')
  assert.equal(result.box.w, 160)
})

test('тяга за левый край меняет и место, и ширину', () => {
  const origin: SnapBox = { x: 100, y: 0, w: 100, h: 100 }
  const result = snapResizedBox({ x: 53, y: 0, w: 147, h: 100 }, origin, [
    { x: 50, y: 400, w: 100, h: 100 },
  ], 6)
  assert.equal(result.box.x, 50)
  assert.equal(result.box.w, 150, 'правый край остался на 200')
})

test('без соседей рядом рамка не двигается и направляющих нет', () => {
  const origin: SnapBox = { x: 0, y: 0, w: 100, h: 100 }
  const box: SnapBox = { x: 0, y: 0, w: 140, h: 100 }
  const result = snapResizedBox(box, origin, [{ x: 900, y: 900, w: 10, h: 10 }], 6)
  assert.deepEqual(result.box, box)
  assert.deepEqual(result.guides, [])
})

test('угловая тяга липнет по обеим осям сразу', () => {
  const origin: SnapBox = { x: 0, y: 0, w: 100, h: 100 }
  const result = snapResizedBox({ x: 0, y: 0, w: 197, h: 297 }, origin, [
    { x: 200, y: 300, w: 40, h: 40 },
  ], 6)
  assert.equal(result.box.w, 200)
  assert.equal(result.box.h, 300)
  assert.equal(result.guides.length, 2)
})

test('прилипание не искажает пропорции картинки при уменьшении', () => {
  const origin: SnapBox = { x: 0, y: 0, w: 400, h: 100 }
  const resized: SnapBox = { x: 0, y: 0, w: 200, h: 50 }
  // Правый край попал в порог смарт-гайда, но одноосное прилипание
  // сделало бы 203×50 и растянуло изображение после mouseup.
  const result = snapResizedBox(resized, origin, [
    { x: 203, y: 300, w: 100, h: 100 },
  ], 6, { preserveAspectRatio: true })

  assert.deepEqual(result.box, resized)
  assert.deepEqual(result.guides, [])
  assert.equal(result.box.w / result.box.h, origin.w / origin.h)
})

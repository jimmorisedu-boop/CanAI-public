import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { anchorScreenPosition, clampAnchorToViewport, placeCanvasToolbar } from './useCanvasAnchor.js'
import { itemAabb, type Bounds } from './geometry.js'

const point = { x: 100, y: 50, screenOffsetY: -44 }

test('панель стоит над точкой холста в её экранных координатах', () => {
  assert.deepEqual(anchorScreenPosition({ x: 0, y: 0, scale: 1 }, point), { left: 100, top: 6 })
  // Панорама двигает панель ровно на столько же, сколько холст.
  assert.deepEqual(anchorScreenPosition({ x: 120, y: -40, scale: 1 }, point), { left: 220, top: -34 })
  // Зум растягивает расстояние до точки, но не сам отступ панели над ней.
  assert.deepEqual(anchorScreenPosition({ x: 0, y: 0, scale: 2 }, point), { left: 200, top: 56 })
})

test('смещение переноса складывается в МИРОВЫХ координатах, до масштаба', () => {
  const dragged = anchorScreenPosition({ x: 0, y: 0, scale: 2 }, point, { dx: 10, dy: 5 })
  assert.deepEqual(dragged, { left: 220, top: 66 }, 'иначе на отдалённой доске панель уезжала бы вдвое')
})

const viewport = { w: 800, h: 600 }
const panel = { w: 220, h: 36 }

const camera = { x: 0, y: 0, scale: 1 }
const selection = (...bounds: Bounds[]) => ({ ...point, bounds })

test('запись пользователя: видео полностью за экраном — панель скрыта с любой стороны', () => {
  for (const box of [
    { x: 300, y: -1000, w: 480, h: 270 },
    { x: 300, y: 600, w: 480, h: 270 },
    { x: -480, y: 100, w: 480, h: 270 },
    { x: 800, y: 100, w: 480, h: 270 },
  ]) assert.equal(placeCanvasToolbar(camera, selection(box), viewport, panel), null)
})

test('видна только нижняя полоска видео — кнопки под ней, не закрывают кадр', () => {
  assert.deepEqual(placeCanvasToolbar(camera, selection({ x: 200, y: -280, w: 400, h: 300 }), viewport, panel), { left: 400, top: 28 })
})

test('крупный объект: панель по центру видимой части, а не уехавшего мирового центра', () => {
  assert.deepEqual(placeCanvasToolbar(camera, selection({ x: -1200, y: -400, w: 2000, h: 1200 }), viewport, panel), { left: 400, top: 8 })
})

test('пустое место в рамке группы не удерживает панель скрытых объектов', () => {
  assert.equal(placeCanvasToolbar(camera, selection(
    { x: -400, y: 100, w: 200, h: 200 },
    { x: 1000, y: 100, w: 200, h: 200 },
  ), viewport, panel), null)
})

test('в группе панель привязана к видимому объекту, даже если остальные далеко за экраном', () => {
  assert.deepEqual(placeCanvasToolbar(camera, selection(
    { x: 200, y: 200, w: 400, h: 200 },
    { x: -2000, y: -2000, w: 200, h: 200 },
  ), viewport, panel), { left: 400, top: 156 })
})

test('возврат камеры сразу возвращает панель к объекту после выхода за экран', () => {
  const anchor = selection({ x: 200, y: 200, w: 400, h: 200 })
  assert.equal(placeCanvasToolbar({ ...camera, y: -800 }, anchor, viewport, panel), null)
  assert.deepEqual(placeCanvasToolbar(camera, anchor, viewport, panel), { left: 400, top: 156 })
})

test('перенос и зум участвуют и в размещении, и в видимости панели', () => {
  const anchor = selection({ x: 100, y: 100, w: 200, h: 100 })
  assert.deepEqual(placeCanvasToolbar({ ...camera, scale: 2 }, anchor, viewport, panel, { dx: 10, dy: 20 }), { left: 420, top: 196 })
  assert.equal(placeCanvasToolbar({ ...camera, scale: 2 }, anchor, viewport, panel, { dx: 10, dy: -400 }), null)
})

test('повёрнутый объект привязывает панель к настоящей рамке, а не исходной ширине', () => {
  const bounds = itemAabb({ id: 'rotated', kind: 'image', x: 400, y: 200, w: 200, h: 100, rotation: 90 })
  const position = placeCanvasToolbar(camera, selection(bounds), viewport, panel)!
  assert.ok(Math.abs(position.left - 350) < 1e-6)
  assert.ok(Math.abs(position.top - 156) < 1e-6)
})

test('видимость оценивается по всему холсту, даже если панель нужно поднять над доком', () => {
  const position = placeCanvasToolbar(camera, selection({ x: 200, y: 450, w: 400, h: 100 }), viewport, panel, undefined, 180)
  assert.ok(position)
  assert.equal(position.left, 400)
  assert.ok(position.top + panel.h <= viewport.h - 180 - 8)
})

test('крупная картинка или видео: верх объекта за экраном, все кнопки остаются на холсте', () => {
  for (const scale of [0.25, 1, 4]) {
    const position = anchorScreenPosition({ x: 0, y: -500, scale }, point)
    const placed = clampAnchorToViewport(position, viewport, panel)
    assert.equal(placed.top, 8)
    assert.ok(placed.left - panel.w / 2 >= 8)
    assert.ok(placed.left + panel.w / 2 <= viewport.w - 8)
  }
})

test('у левого, правого и нижнего краёв учитывается весь размер панели', () => {
  assert.deepEqual(clampAnchorToViewport({ left: -1000, top: 1000 }, viewport, panel), { left: 118, top: 556 })
  assert.deepEqual(clampAnchorToViewport({ left: 1000, top: 100 }, viewport, panel), { left: 682, top: 100 })
})

test('панель не меняет позицию, пока целиком помещается над объектом', () => {
  const position = { left: 400, top: 200 }
  assert.deepEqual(clampAnchorToViewport(position, viewport, panel), position)
})

test('изменение размера окна и панели заново удерживает все кнопки в доступной области', () => {
  const placed = clampAnchorToViewport({ left: 600, top: 500 }, { w: 320, h: 240 }, { w: 300, h: 72 })
  assert.deepEqual(placed, { left: 162, top: 160 })
})

test('резерв нижнего дока оставляет панель над промпт-баром', () => {
  const reserve = 180
  const placed = clampAnchorToViewport({ left: 400, top: 500 }, { w: 800, h: 600 - reserve }, panel)
  assert.equal(placed.top + panel.h, 600 - reserve - 8)
})

test('нулевой замер скрытой доски не теряет исходную позицию', () => {
  const position = { left: 400, top: 200 }
  assert.deepEqual(clampAnchorToViewport(position, { w: 0, h: 0 }, panel), position)
})

/**
 * ⚠️ Позицию считает сам хук, а не React-рендер: при панораме и зуме Konva
 * двигает сцену каждый кадр, а в стор камера попадает раз в 50 мс, и панель
 * отставала от холста ровно на этот интервал (жалоба 07.09.2026).
 */
test('панель слушает кадровую шину камеры, а не только стор', async () => {
  const source = await readFile(new URL('./useCanvasAnchor.ts', import.meta.url), 'utf8')
  assert.match(source, /subscribeAnnotationCamera/)
  assert.match(source, /subscribeCanvasDrag/)

  const canvas = await readFile(new URL('./KonvaCanvas.tsx', import.meta.url), 'utf8')
  const toolbars = canvas.slice(canvas.indexOf('<ItemToolbar'))
  assert.doesNotMatch(
    toolbars.slice(0, 1200),
    /left: cam\.x/,
    'позиция панели не считается из React-состояния камеры',
  )
})

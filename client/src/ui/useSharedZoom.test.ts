import assert from 'node:assert/strict'
import test from 'node:test'
import { pointZoom, shouldHandleZoomWheel, zoomTransform, type ZoomState } from './useSharedZoom'

// Зум к точке — чистая арифметика, поэтому проверяется без DOM. Главное
// свойство одно: точка кадра под курсором после зума остаётся под курсором.

const frame = { width: 1000, height: 600 }

/** Где на экране окажется точка кадра `p` (координаты невзумленной рамки). */
function onScreen(zoom: ZoomState, p: { x: number; y: number }) {
  const cx = frame.width / 2
  const cy = frame.height / 2
  return { x: cx + zoom.x + (p.x - cx) * zoom.scale, y: cy + zoom.y + (p.y - cy) * zoom.scale }
}

test('зум к точке: точка под курсором не уезжает', () => {
  const identity: ZoomState = { scale: 1, x: 0, y: 0 }
  const point = { x: 800, y: 150 }
  const zoomed = pointZoom(identity, 2, point, frame)
  const after = onScreen(zoomed, point)
  assert.ok(Math.abs(after.x - point.x) < 1e-9)
  assert.ok(Math.abs(after.y - point.y) < 1e-9)
})

test('зум к точке при уже приближённом кадре тоже держит точку', () => {
  const start: ZoomState = { scale: 2, x: -120, y: 40 }
  const point = { x: 300, y: 420 }
  // что лежало под курсором до зума, в координатах рамки
  const cx = frame.width / 2
  const cy = frame.height / 2
  const under = { x: cx + (point.x - cx - start.x) / start.scale, y: cy + (point.y - cy - start.y) / start.scale }
  const next = pointZoom(start, 3.5, point, frame)
  const after = onScreen(next, under)
  assert.ok(Math.abs(after.x - point.x) < 1e-9)
  assert.ok(Math.abs(after.y - point.y) < 1e-9)
})

test('масштаб не выходит за пределы, а возврат к единице отдаёт «вписано»', () => {
  const start: ZoomState = { scale: 2, x: 30, y: -10 }
  assert.equal(pointZoom(start, 1000, { x: 10, y: 10 }, frame).scale, 24)
  assert.deepEqual(pointZoom(start, 1, { x: 10, y: 10 }, frame), { scale: 1, x: 0, y: 0 })
  assert.deepEqual(pointZoom(start, 0.2, { x: 10, y: 10 }, frame), { scale: 1, x: 0, y: 0 })
})

test('на «вписано» transform не накладывается вовсе', () => {
  assert.equal(zoomTransform({ scale: 1, x: 0, y: 0 }), 'none')
  assert.equal(zoomTransform({ scale: 2, x: 5, y: 6 }), 'translate(5px, 6px) scale(2)')
})

test('Alt + колесо пропускается превью-зумом, чтобы масштабировать таймлайн по времени', () => {
  assert.equal(shouldHandleZoomWheel({ altKey: false }), true)
  assert.equal(shouldHandleZoomWheel({ altKey: true }), false)
})

// @ts-expect-error Node test runtime
import test from 'node:test'
// @ts-expect-error Node test runtime
import assert from 'node:assert/strict'
import { adjacentFrameTime, collectFrameTimes } from './videoFrameIndex'
import { placeVideoFrames } from './videoFrameSelection'
import { CanvasStore } from '../spaces/canvas/konva/canvasStore'
test('кадры идут по времени показа, включая B-кадры и переменные интервалы', async () => {
  async function* packets() { for (const timestamp of [0, .12, .04, .08, .20]) yield { timestamp } }
  const times = await collectFrameTimes(packets())
  assert.deepEqual(times, [0, .04, .08, .12, .20])
  assert.equal(adjacentFrameTime(times, .13, 1), .20)
  assert.equal(adjacentFrameTime(times, .13, -1), .08)
  assert.equal(adjacentFrameTime(times, 0, -1), 0)
  assert.equal(adjacentFrameTime(times, .20, 1), .20)
})
test('пакет кадров ложится справа сеткой и отменяется одним действием', () => {
  const store = new CanvasStore()
  const source = { id: 'video', kind: 'video' as const, x: 0, y: 0, w: 300, h: 400, src: '/media/video.mp4' }
  store.loadDoc({ version: 1, items: [source], camera: { x: 0, y: 0, scale: 1 } })
  const frames = Array.from({ length: 10 }, (_, i) => ({ url: `/media/frame-${i}.png`, mime: 'image/png', width: 300, height: 400, time: i }))
  const ids = placeVideoFrames(store, source, frames)
  assert.equal(ids.length, 10)
  const placed = store.getItems().filter(item => ids.includes(item.id))
  assert.ok(placed.every(item => item.x >= 324))
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i], b = placed[j]
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
  }
  store.undo()
  assert.deepEqual(store.getItems().map(item => item.id), ['video'])
})
test('кадры растянутого клипа встают шириной клипа, а не 440', () => {
  // Жалоба 22.09.2026: кадр обязан быть в том же масштабе, что и клип.
  const store = new CanvasStore()
  const source = { id: 'video', kind: 'video' as const, x: 0, y: 0, w: 900, h: 1600, src: '/media/video.mp4' }
  store.loadDoc({ version: 1, items: [source], camera: { x: 0, y: 0, scale: 1 } })
  const frames = Array.from({ length: 3 }, (_, i) => ({ url: `/media/frame-${i}.png`, mime: 'image/png', width: 720, height: 1280, time: i }))
  const ids = placeVideoFrames(store, source, frames)
  const placed = store.getItems().filter(item => ids.includes(item.id))
  assert.ok(placed.every(item => item.w === 900 && item.h === 1600), JSON.stringify(placed.map(item => [item.w, item.h])))
})

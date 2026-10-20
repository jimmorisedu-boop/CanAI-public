// @ts-expect-error Тест запускается с серверным tsx и Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается с серверным tsx и Node-типами.
import test from 'node:test'
import { nextCameraFromWheel } from './canvasWheel.js'

const camera = { x: 10, y: 20, scale: 1 }
const pointer = { x: 100, y: 80 }

test('режим мыши сохраняет прежний ступенчатый зум и игнорирует deltaX', () => {
  const next = nextCameraFromWheel(camera, pointer, {
    deltaX: 999,
    deltaY: -1,
    ctrlKey: false,
  }, 'mouse')

  assert.equal(next.scale, 1.08)
  assert.ok(Math.abs(next.x - 2.8) < 1e-12)
  assert.ok(Math.abs(next.y - 15.2) < 1e-12)
})

test('обычный жест двумя пальцами в режиме тачпада панорамирует холст', () => {
  const next = nextCameraFromWheel(camera, pointer, {
    deltaX: 12,
    deltaY: -7,
    ctrlKey: false,
  }, 'touchpad')

  assert.deepEqual(next, { x: -2, y: 27, scale: 1 })
})

test('pinch тачпада даёт плавный зум к указателю', () => {
  const next = nextCameraFromWheel(camera, pointer, {
    deltaX: 0,
    deltaY: -100,
    ctrlKey: true,
  }, 'touchpad')

  assert.ok(Math.abs(next.scale - Math.exp(0.2)) < 1e-12)
  assert.ok(Math.abs((pointer.x - next.x) / next.scale - 90) < 1e-12)
  assert.ok(Math.abs((pointer.y - next.y) / next.scale - 60) < 1e-12)
})

test('плавный зум тачпада соблюдает пределы масштаба', () => {
  assert.equal(nextCameraFromWheel(
    { x: 0, y: 0, scale: 7.9 },
    pointer,
    { deltaX: 0, deltaY: -1000, ctrlKey: true },
    'touchpad',
  ).scale, 8)
  assert.equal(nextCameraFromWheel(
    { x: 0, y: 0, scale: 0.051 },
    pointer,
    { deltaX: 0, deltaY: 1000, ctrlKey: true },
    'touchpad',
  ).scale, 0.05)
})

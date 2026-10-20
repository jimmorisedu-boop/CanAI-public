import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from './canvasStore.js'
import { startLocalWork } from './localWorkPlaceholder.js'
import {
  captureFrameToCanvas,
  CAPTURE_CX,
  isVideoFrameCapturePoint,
  MUTE_CX,
  VIDEO_CONTROL_CY,
  VIDEO_CONTROL_EDGE,
  VIDEO_FRAME_CAPTURE_SIZE,
  videoControlScale,
} from './videoFrameCapture.js'

/** Доска с одним клипом Full HD, растянутым на доске до w×h. */
function boardWithClip(w: number, h: number) {
  const store = new CanvasStore()
  const clip = {
    id: 'clip', kind: 'video' as const, x: 100, y: 200, w, h,
    src: '/media/clip.mp4', naturalWidth: 1920, naturalHeight: 1080,
  }
  store.loadDoc({ version: 1, items: [clip], camera: { x: 0, y: 0, scale: 1 } })
  store.select('clip')
  return { store, clip }
}

const captureFullHdFrame = (store: CanvasStore) => captureFrameToCanvas(
  store,
  { id: 'clip' },
  async () => ({ blob: new Blob(['frame'], { type: 'image/png' }), width: 1920, height: 1080, name: 'кадр.png' }),
  async () => ({ url: '/media/frame.png', mime: 'image/png' }),
)

// Жалоба 22.09.2026 со снимком: клип растягивают как угодно, а кадр вставал
// всегда шириной 440 — у уменьшенного клипа огромным, у увеличенного крошечным.
for (const [label, w, h] of [['уменьшенного', 160, 90], ['увеличенного', 1600, 900], ['крошечного', 64, 36]] as const) {
  test(`кадр из ${label} клипа встаёт размером клипа, правее и по нижнему краю`, async () => {
    const { store, clip } = boardWithClip(w, h)
    const frameId = await captureFullHdFrame(store)
    const frame = store.getItem(frameId!)!
    assert.equal(frame.kind, 'image')
    assert.deepEqual({ w: frame.w, h: frame.h }, { w: clip.w, h: clip.h })
    assert.ok(frame.x >= clip.x + clip.w, 'кадр правее клипа')
    assert.equal(frame.y + frame.h, clip.y + clip.h, 'по нижнему краю клипа')
    assert.deepEqual([...store.getSelectedIds()], ['clip'], 'выделенным остаётся клип')
  })
}

test('склейка скетча встаёт размером исходной картинки', async () => {
  // Скетч идёт той же заглушкой (bakeSketchToNewImage → startLocalWork).
  const store = new CanvasStore()
  const photo = {
    id: 'photo', kind: 'image' as const, x: 0, y: 0, w: 150, h: 200,
    src: '/media/photo.png', naturalWidth: 1200, naturalHeight: 1600,
  }
  store.loadDoc({ version: 1, items: [photo], camera: { x: 0, y: 0, scale: 1 } })
  const work = startLocalWork(store, { label: 'Building image…', anchorId: 'photo' })
  await work.done({ url: '/media/sketch.png', mime: 'image/png', width: 1200, height: 1600 }, 'sketch')
  const result = store.getItems().find((item) => item.src === '/media/sketch.png')!
  assert.deepEqual({ w: result.w, h: result.h }, { w: 150, h: 200 })
})

test('кнопка кадра стоит второй и принимает нажатие по своей коробке 44 на 44', () => {
  // Первой, у самого угла, стоит кнопка звука (просьба 21.09.2026), кадр — следом.
  assert.equal(isVideoFrameCapturePoint({ x: 50, y: 6 }), true)
  assert.equal(isVideoFrameCapturePoint({ x: 92, y: 48 }), true)
  assert.equal(isVideoFrameCapturePoint({ x: 20, y: 20 }), false, 'у угла теперь кнопка звука')
  assert.equal(isVideoFrameCapturePoint({ x: 94, y: 20 }), false)
})

test('кнопки кадра и звука не меняют размер от габаритов клипа', () => {
  // Иначе один и тот же контрол гуляет от 21 до 95 внутренних пикселей,
  // а масштаб холста усиливает разброс ещё сильнее.
  assert.equal(videoControlScale(440, 248), 1)
  assert.equal(videoControlScale(120, 68), 1)
  assert.equal(videoControlScale(3000, 1700), 1)
  assert.equal(videoControlScale(2000, 248), 1)
  assert.equal(videoControlScale(248, 2000), 1)
  // Мусорные размеры не роняют отрисовку и тоже не меняют контрол.
  assert.equal(videoControlScale(0, 0), 1)
  assert.equal(videoControlScale(Number.NaN, 100), 1)
})

test('попадание по кнопке кадра считается с тем же масштабом', () => {
  assert.equal(isVideoFrameCapturePoint({ x: 100, y: 12 }), false)
  assert.equal(isVideoFrameCapturePoint({ x: 100, y: 12 }, 2), true)
  assert.equal(isVideoFrameCapturePoint({ x: 30, y: 10 }, 0.5), true)
  assert.equal(isVideoFrameCapturePoint({ x: 60, y: 10 }, 0.5), false)
})

test('звук у самого угла, кадр следом, оба на линии плашек с именем', () => {
  // Просьба 21.09.2026: поменять местами и отодвинуть от края. Край кружка
  // (радиус 19) стоит там же, где плашки с именем и временем внизу, — в 8.
  assert.ok(MUTE_CX < CAPTURE_CX, 'звук — первым')
  assert.equal(CAPTURE_CX - MUTE_CX, VIDEO_FRAME_CAPTURE_SIZE, 'один шаг, одна строка')
  assert.equal(MUTE_CX - 19, VIDEO_CONTROL_EDGE)
  assert.equal(VIDEO_CONTROL_CY - 19, VIDEO_CONTROL_EDGE)
  assert.equal(VIDEO_CONTROL_EDGE, 8)
})

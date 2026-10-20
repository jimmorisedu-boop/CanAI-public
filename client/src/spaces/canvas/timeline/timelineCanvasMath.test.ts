import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampPan,
  clampScale,
  canonicalCaptureKey,
  fitScale,
  freezeCaptureRequest,
  mapCropPointerToNormalized,
  MAX_SCALE,
  MIN_SCALE,
  nativeScale,
  normalizeWheelDelta,
  panLimits,
  toggleFitZoom,
  wheelScaleFactor,
  zoomAtPoint,
} from './timelineCanvasMath'

test('normalizeWheelDelta: pixel/line/page дают сопоставимый шаг', () => {
  // pixels (0)
  assert.equal(normalizeWheelDelta(120, 0), 120)
  assert.equal(normalizeWheelDelta(-120, 0), -120)
  // lines (1): ~3 строки по 16
  assert.equal(normalizeWheelDelta(3, 1), 48)
  assert.equal(normalizeWheelDelta(-3, 1), -48)
  // pages (2): половина viewport
  assert.equal(normalizeWheelDelta(1, 2, { width: 100, height: 400 }), 200)
  assert.equal(normalizeWheelDelta(-1, 2, { width: 100, height: 400 }), -200)
  // page без viewport — фолбэк 300 (полстраницы номинального окна 600)
  assert.equal(normalizeWheelDelta(1, 2), 300)
  assert.equal(normalizeWheelDelta(-1, 2), -300)
})

test('wheelScaleFactor: знак дельты задаёт приближение/отдаление', () => {
  assert.ok(wheelScaleFactor(-100) > 1, 'вверх — приблизить')
  assert.ok(wheelScaleFactor(100) < 1, 'вниз — отдалить')
})

test('clampScale держит границы и пускает внутрь', () => {
  assert.equal(clampScale(0.1), MIN_SCALE)
  assert.equal(clampScale(1000), MAX_SCALE)
  assert.equal(clampScale(3), 3)
})

test('zoomAtPoint: точка под курсором совпадает до эпсилон', () => {
  const frame = { width: 800, height: 600 }
  const prev = { scale: 1, x: 0, y: 0 }
  const point = { x: 300, y: 200 }
  const next = zoomAtPoint(prev, 2, point, frame)
  assert.equal(next.scale, 2)
  const cx = frame.width / 2
  const cy = frame.height / 2
  const fitX = cx + (point.x - cx - prev.x) / prev.scale
  const fitY = cy + (point.y - cy - prev.y) / prev.scale
  const checkX = next.x + (fitX - cx) * next.scale + cx
  const checkY = next.y + (fitY - cy) * next.scale + cy
  assert.ok(Math.abs(checkX - point.x) < 1e-6, `x: ${checkX} vs ${point.x}`)
  assert.ok(Math.abs(checkY - point.y) < 1e-6, `y: ${checkY} vs ${point.y}`)
})

test('zoomAtPoint: ниже единицы возвращает identity', () => {
  const next = zoomAtPoint({ scale: 5, x: 100, y: 100 }, 0.5, { x: 10, y: 10 }, { width: 100, height: 100 })
  assert.deepEqual(next, { scale: 1, x: 0, y: 0 })
})

test('clampPan: четыре края и NaN', () => {
  const viewport = { width: 400, height: 300 }
  const content = { width: 600, height: 450 }
  // scale 2 -> контент 1200x900, пространство (1200-400)/2=400, (900-300)/2=300
  assert.deepEqual(clampPan(2, { x: 9999, y: 9999 }, viewport, content), { x: 400, y: 300 })
  assert.deepEqual(clampPan(2, { x: -9999, y: -9999 }, viewport, content), { x: -400, y: -300 })
  assert.deepEqual(clampPan(2, { x: 10, y: 10 }, viewport, content), { x: 10, y: 10 })
  // scale=1 -> identity, никакой пан не остаётся
  assert.deepEqual(clampPan(1, { x: 50, y: 50 }, viewport, content), { x: 0, y: 0 })
  assert.deepEqual(clampPan(1, { x: 0, y: 0 }, viewport, content), { x: 0, y: 0 })
  // NaN -> ноль
  assert.deepEqual(clampPan(2, { x: Number.NaN, y: Number.NaN }, viewport, content), { x: 0, y: 0 })
  // маленький контент при зум -> нет пространства
  assert.deepEqual(clampPan(2, { x: 50, y: 50 }, { width: 400, height: 300 }, { width: 100, height: 50 }), { x: 0, y: 0 })
})

test('clampPan: вписанный кадр меньше окна не уезжает', () => {
  const viewport = { width: 800, height: 600 }
  const content = { width: 640, height: 360 }
  // scale 2 -> контент 1280x720, по x пространство (1280-800)/2=240, по y контент
  // 720>600 -> (720-600)/2=60
  assert.deepEqual(clampPan(2, { x: 1000, y: 1000 }, viewport, content), { x: 240, y: 60 })
})

test('panLimits: предел сдвига, а не зажатое смещение — иначе хук зума зажмёт пан в ноль', () => {
  const viewport = { width: 800, height: 600 }
  const content = { width: 640, height: 360 }
  // 2×: кадр 1280×720 против окна 800×600 — по x ±240, по y ±60
  assert.deepEqual(panLimits(2, viewport, content), { x: 240, y: 60 })
  // вписанный кадр сдвигать нечего
  assert.deepEqual(panLimits(1, viewport, content), { x: 0, y: 0 })
  // кадр, который и в 1.5× помещается в окно по ширине, по этой оси стоит по центру
  assert.deepEqual(panLimits(1.5, viewport, content), { x: 80, y: 0 })
  assert.deepEqual(panLimits(1.2, viewport, content), { x: 0, y: 0 })
  // и clampPan — это ровно предел, применённый к смещению
  assert.deepEqual(clampPan(2, { x: 1e6, y: -1e6 }, viewport, content), { x: 240, y: -60 })
})

test('fitScale/nativeScale различаются на маленьком окне и большом видео', () => {
  const video = { width: 1920, height: 1080 }
  const small = { width: 320, height: 180 }
  assert.ok(Math.abs(fitScale(video, small) - 0.1666) < 0.001, 'fit помещает целиком')
  assert.ok(Math.abs(nativeScale(video, small) - 6) < 0.001, 'native = 1 пиксель к 1')
  // native строго больше fit на маленьком окне
  assert.ok(nativeScale(video, small) > fitScale(video, small))
})

test('toggleFitZoom: fit ↔ 2× в точке, native не участвует', () => {
  const frame = { width: 400, height: 300 }
  const point = { x: 120, y: 90 }
  const zoomed = toggleFitZoom(true, { scale: 2, x: 5, y: 5 }, point, frame)
  assert.deepEqual(zoomed, { scale: 1, x: 0, y: 0 }, 'уже зумирован -> fit')
  const next = toggleFitZoom(false, { scale: 1, x: 0, y: 0 }, point, frame)
  assert.equal(next.scale, 2, 'из fit -> 2×')
})

test('canonicalCaptureKey: без epsilon-склейки соседних времён', () => {
  const a = canonicalCaptureKey({ source: 'i1' }, undefined, 1.0123)
  const b = canonicalCaptureKey({ source: 'i1' }, undefined, 1.0124)
  assert.notEqual(a, b, 'соседние времена не склеиваются')
  const same = canonicalCaptureKey({ source: 'i1', assetId: 'A1' }, undefined, 1.0123)
  assert.equal(
    canonicalCaptureKey({ source: 'i1', assetId: 'A1' }, undefined, 1.0123),
    same,
    'одно и то же время одного исходника — один ключ',
  )
  const otherAsset = canonicalCaptureKey({ source: 'i1', assetId: 'A2' }, undefined, 1.0123)
  assert.notEqual(otherAsset, same, 'другой asset — другой ключ')
  const otherItem = canonicalCaptureKey({ source: 'i2', assetId: 'A1' }, undefined, 1.0123)
  assert.notEqual(otherItem, same, 'другой исходник — другой ключ')
})

test('canonicalCaptureKey: decodedPTS приоритетнее exact, но без eps', () => {
  const a = canonicalCaptureKey({ source: 'i1' }, 5, 100)
  const b = canonicalCaptureKey({ source: 'i1' }, 5.0000001, 100)
  assert.notEqual(a, b, 'разный PTS — разные ключи')
  const c = canonicalCaptureKey({ source: 'i1' }, 5, 999)
  assert.equal(c, canonicalCaptureKey({ source: 'i1' }, 5, 123), 'exact не влияет, если PTS есть')
})

test('freezeCaptureRequest: immutable снимок и стабильный ключ', () => {
  const req = freezeCaptureRequest({ source: 'item-9', assetId: 'ast_1' }, 3.25)
  assert.equal(req.requestedTime, 3.25)
  assert.ok(req.requestId.length > 0)
  // ключ не зависит от номера запроса (два вызова по одному времени — разные
  // requestId, но один dedupKey)
  const req2 = freezeCaptureRequest({ source: 'item-9', assetId: 'ast_1' }, 3.25)
  assert.equal(req.dedupKey, req2.dedupKey)
  assert.notEqual(req.requestId, req2.requestId)
})

test('mapCropPointerToNormalized: содержит прямой переход при scale 1', () => {
  const rect = { width: 400, height: 200 }
  const viewport = { width: 800, height: 600 }
  const point = { x: 400 + 100, y: 300 + 50 }
  const n = mapCropPointerToNormalized(rect, { scale: 1, x: 0, y: 0 }, point, viewport)
  // fitX = point.x = 500; 500/400 = 1.25; fitY = point.y = 350; 350/200 = 1.75
  assert.ok(Math.abs(n.x - 1.25) < 1e-6)
  assert.ok(Math.abs(n.y - 1.75) < 1e-6)
})

test('mapCropPointerToNormalized: зум не смещает доли (при прямоугольной рамке)', () => {
  const rect = { width: 1000, height: 500 }
  const viewport = { width: 1000, height: 500 }
  const center = { x: 500, y: 250 }
  const a = mapCropPointerToNormalized(rect, { scale: 1, x: 0, y: 0 }, center, viewport)
  const b = mapCropPointerToNormalized(rect, { scale: 2, x: 0, y: 0 }, center, viewport)
  assert.ok(Math.abs(a.x - 0.5) < 1e-6 && Math.abs(a.y - 0.5) < 1e-6)
  assert.ok(Math.abs(b.x - 0.5) < 1e-6 && Math.abs(b.y - 0.5) < 1e-6)
})

test('mapCropPointerToNormalized: зум И пан — доли те же (обратный ход точный)', () => {
  // Обратная к формуле связка: screen = c + (fit - c) * scale + pan.
  // Считаем экранную точку для известной доли при зуме с паном и требуем,
  // чтобы преобразование вернуло ровно эту долю (раздел 8 ТЗ: кадрирование
  // считается от исходных размеров, а не от CSS-окна).
  const rect = { width: 1600, height: 900 }
  const viewport = { width: 800, height: 600 }
  const transform = { scale: 2.5, x: -120, y: 70 }
  const cx = viewport.width / 2
  const cy = viewport.height / 2
  for (const fraction of [{ x: 0.25, y: 0.75 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.1 }]) {
    const fitX = fraction.x * rect.width
    const fitY = fraction.y * rect.height
    const pointer = {
      x: cx + (fitX - cx) * transform.scale + transform.x,
      y: cy + (fitY - cy) * transform.scale + transform.y,
    }
    const back = mapCropPointerToNormalized(rect, transform, pointer, viewport)
    assert.ok(Math.abs(back.x - fraction.x) < 1e-9, `x: ${back.x} vs ${fraction.x}`)
    assert.ok(Math.abs(back.y - fraction.y) < 1e-9, `y: ${back.y} vs ${fraction.y}`)
  }
})

test('mapCropPointerToNormalized: пустая рамка и NaN не дают мусора', () => {
  const viewport = { width: 800, height: 600 }
  const zero = mapCropPointerToNormalized({ width: 0, height: 0 }, { scale: 1, x: 0, y: 0 }, { x: 10, y: 10 }, viewport)
  assert.deepEqual(zero, { x: 0, y: 0 })
  const nan = mapCropPointerToNormalized(
    { width: 100, height: 100 },
    { scale: Number.NaN, x: 0, y: 0 },
    { x: 10, y: 10 },
    viewport,
  )
  assert.deepEqual(nan, { x: 0, y: 0 })
})
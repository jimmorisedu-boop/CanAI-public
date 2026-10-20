// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { readdirSync, readFileSync } from 'node:fs'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import path from 'node:path'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { fileURLToPath } from 'node:url'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import './canvasWheel.test.js'
import { MAX_SCALE, zoomToBounds } from './cameraOps'
import { quantizeScale } from './cameraScale'

test('zoomToBounds caps a tiny result at the canvas maximum scale', () => {
  const camera = zoomToBounds(
    { x: 7, y: 9, scale: 1 },
    { x: 100, y: 200, w: 10, h: 10 },
    { w: 1000, h: 800 },
  )

  assert.equal(camera.scale, MAX_SCALE)
  assert.deepEqual(camera, { scale: 8, x: -340, y: -1240 })
})

test('zoomToBounds fits a result group inside the padded viewport', () => {
  const camera = zoomToBounds(
    { x: 0, y: 0, scale: 1 },
    { x: 0, y: 0, w: 1000, h: 500 },
    { w: 1200, h: 800 },
  )

  assert.deepEqual(camera, { scale: 1.04, x: 80, y: 140 })
  assert.ok(camera.x >= 80)
  assert.ok(camera.y >= 80)
  assert.ok(camera.x + 1000 * camera.scale <= 1120)
  assert.ok(camera.y + 500 * camera.scale <= 720)
})

test('zoomToBounds keeps the current camera when there are no usable bounds', () => {
  const current = { x: 17, y: -25, scale: 0.75 }

  assert.deepEqual(zoomToBounds(current, null, { w: 1200, h: 800 }), current)
  assert.deepEqual(
    zoomToBounds(current, { x: 0, y: 0, w: 0, h: 100 }, { w: 1200, h: 800 }),
    current,
  )
})

// Потребители масштаба держат по нему МИНИМАЛЬНЫЙ размер на экране: 3px у
// полоски промпта, 12px у метки. Огрубление законно ровно до тех пор, пока
// ошибка на экране меньше половины пикселя.
test('огрубление не смещает экранный размер заметно для глаза', () => {
  for (let raw = 0.02; raw < 4; raw *= 1.03) {
    const q = quantizeScale(raw)
    const ошибка = Math.abs(3 / q - 3 / raw) * raw // в экранных пикселях
    assert.ok(ошибка < 0.5, `при масштабе ${raw.toFixed(3)}error${ошибка.toFixed(2)}px`)
  }
})

// Смысл огрубления — в том, что подряд идущие кадры зума дают ОДНО значение.
// Иначе каждая ступень колеса перерисовывала бы все декорации в кадре.
test('плавный зум даёт десятки ступеней, а не сотни', () => {
  const шаги = new Set<number>()
  for (let raw = 1; raw > 0.06; raw *= 0.98) шаги.add(quantizeScale(raw))
  assert.ok(шаги.size < 25, `ступеней ${шаги.size} — огрубление не работает`)
  assert.ok(шаги.size > 5, 'слишком грубо: размер будет прыгать заметно')
})

test('крайние и бессмысленные значения не роняют расчёт', () => {
  assert.equal(quantizeScale(0), 1)
  assert.equal(quantizeScale(-1), 1)
  assert.equal(quantizeScale(Number.NaN), 1)
  assert.ok(quantizeScale(1) === 1, 'сто процентов обязаны остаться собой')
})

// Подписка на камеру внутри фигуры перечёркивает React.memo: пропсы стабильны,
// а компонент всё равно перерисовывается на каждое движение камеры. На доске
// из 600 картинок это давало 246 мс на сдвиг (замер 2026-08-08), после
// переноса подписки в сами декорации — 0 мс.
test('фигуры не подписаны на камеру — только их декорации', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const виновные: string[] = []
  for (const name of ['ImageItem.tsx', 'VideoItem.tsx', 'TextItem.tsx', 'GifItem.tsx']) {
    const source = readFileSync(path.join(dir, name), 'utf8')
    // подписка допустима только внутри мелких декораций (LeftAccentStrip),
    // а не в теле самой фигуры
    const тело = source.slice(source.indexOf('memo(function'))
    if (/useCameraScale\(/.test(тело)) виновные.push(name)
  }
  assert.deepEqual(виновные, [], `подписка на камеру в теле фигуры: ${виновные.join(', ')}`)
  // сторож на будущее: файлов фигур может стать больше
  assert.ok(
    readdirSync(dir).filter((f) => /Item\.tsx$/.test(f)).length >= 3,
    'не нашли файлы фигур — проверь путь',
  )
})

// Вес файла показывается бейджем ТОЛЬКО под курсором, то есть максимум у
// одного объекта. Запрашивать его у каждого объекта в кадре — это сотни
// HEAD-обращений ради подписи, которую никто не смотрит (замер 2026-08-09:
// на 300 картинках половина из 1176 обращений к media была именно такой).
test('вес файла запрашивается только под курсором', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const безУсловия: string[] = []
  for (const name of ['ImageItem.tsx', 'VideoItem.tsx', 'GifItem.tsx']) {
    const source = readFileSync(path.join(dir, name), 'utf8')
    for (const call of source.match(/useMediaSize\([^)]*\)/g) ?? []) {
      // второй аргумент — признак «сейчас видно»; без него запрос уйдёт всегда
      if (!/,/.test(call)) безУсловия.push(`${name}: ${call}`)
    }
  }
  assert.deepEqual(безУсловия, [], `вес файла тянется безусловно: ${безУсловия.join(', ')}`)
})

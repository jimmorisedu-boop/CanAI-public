import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessSeries,
  fitSeriesCamera,
  placeSeriesCues,
  visibleFraction,
} from './generationSeriesGeometry'

test('24.9% карточки не считается видимостью, а 25% считается', () => {
  const viewport = { x: 0, y: 0, w: 100, h: 100 }
  const camera = { x: 0, y: 0, scale: 1 }

  assert.ok(visibleFraction({ x: 75.1, y: 0, w: 100, h: 100 }, camera, viewport) < 0.25)
  assert.equal(visibleFraction({ x: 75, y: 0, w: 100, h: 100 }, camera, viewport), 0.25)
})

test('частично скрытый ряд возвращает направление и число скрытых карточек', () => {
  const result = assessSeries([
    { id: 'a', bounds: { x: 10, y: 10, w: 40, h: 40 } },
    { id: 'b', bounds: { x: 130, y: 10, w: 40, h: 40 } },
  ], { x: 0, y: 0, scale: 1 }, { x: 0, y: 0, w: 100, h: 100 })

  assert.deepEqual(result?.meaningfulVisibleIds, ['a'])
  assert.deepEqual(result?.hiddenIds, ['b'])
  assert.equal(result?.direction, 'right')
})

test('игнорирует неверные bounds и объединяет все корректные bounds серии', () => {
  const result = assessSeries([
    { id: 'invalid', bounds: { x: NaN, y: 0, w: 10, h: 10 } },
    { id: 'first', bounds: { x: -20, y: 10, w: 30, h: 20 } },
    { id: 'last', bounds: { x: 50, y: 40, w: 40, h: 30 } },
  ], { x: 0, y: 0, scale: 1 }, { x: 0, y: 0, w: 100, h: 100 })

  assert.deepEqual(result?.bounds, { x: -20, y: 10, w: 110, h: 60 })
  assert.deepEqual(result?.meaningfulVisibleIds, ['first', 'last'])
  assert.equal(assessSeries([], { x: 0, y: 0, scale: 1 }, { x: 0, y: 0, w: 100, h: 100 }), null)
})

test('скрытые карточки с разными доминирующими сторонами дают mixed', () => {
  const result = assessSeries([
    { id: 'right', bounds: { x: 130, y: 10, w: 40, h: 40 } },
    { id: 'down', bounds: { x: 10, y: 130, w: 40, h: 40 } },
  ], { x: 0, y: 0, scale: 1 }, { x: 0, y: 0, w: 100, h: 100 })

  assert.equal(result?.direction, 'mixed')
})

test('fit центрирует внутри safe viewport и никогда не увеличивает масштаб', () => {
  const current = { x: 0, y: 0, scale: 0.5 }
  const next = fitSeriesCamera(
    current,
    { x: 1000, y: 0, w: 100, h: 100 },
    { x: 0, y: 0, w: 800, h: 600 },
    48,
  )

  assert.equal(next?.scale, 0.5)
  assert.equal(next?.x, 400 - 1050 * 0.5)
  assert.equal(next?.y, 300 - 50 * 0.5)
})

test('fit соблюдает MIN_SCALE и отвергает неверную геометрию', () => {
  const next = fitSeriesCamera(
    { x: 0, y: 0, scale: 1 },
    { x: 0, y: 0, w: 10_000, h: 10_000 },
    { x: 0, y: 0, w: 100, h: 100 },
    0,
  )

  assert.equal(next?.scale, 0.05)
  assert.equal(fitSeriesCamera({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 0, w: 100, h: 100 }), null)
  assert.equal(fitSeriesCamera({ x: 0, y: 0, scale: 0.01 }, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 100 }), null)
})

test('cue остаётся на inset 16px, имеет минимум 116×44 и сдвигается при коллизии', () => {
  const cues = placeSeriesCues([
    { launchId: 'first', direction: 'right', hiddenCount: 1, totalCount: 2 },
    { launchId: 'second', direction: 'right', hiddenCount: 2, totalCount: 3 },
  ], { x: 0, y: 0, w: 400, h: 300 }, [])

  assert.deepEqual(cues[0], {
    launchId: 'first', direction: 'right', hiddenCount: 1, totalCount: 2, x: 268, y: 128,
  })
  assert.equal(cues[1]?.x, 268)
  assert.equal(cues[1]?.y, 180)
})

test('три cue в низком safe viewport не налезают друг на друга', () => {
  const cues = placeSeriesCues([
    { launchId: 'first', direction: 'right', hiddenCount: 1, totalCount: 2 },
    { launchId: 'second', direction: 'right', hiddenCount: 1, totalCount: 2 },
    { launchId: 'third', direction: 'right', hiddenCount: 1, totalCount: 2 },
  ], { x: 0, y: 48, w: 287, h: 239 }, [])

  const sorted = [...cues].sort((a, b) => a.y - b.y)
  assert.equal(sorted.length, 3)
  assert.equal(sorted[1]!.y - (sorted[0]!.y + 44), 8)
  assert.equal(sorted[2]!.y - (sorted[1]!.y + 44), 8)
})

test('верхние и нижние cue после коллизии сохраняют ровно 8px зазор по X', () => {
  for (const direction of ['up', 'down'] as const) {
    const cues = placeSeriesCues([
      { launchId: `${direction}-first`, direction, hiddenCount: 1, totalCount: 2 },
      { launchId: `${direction}-second`, direction, hiddenCount: 1, totalCount: 2 },
    ], { x: 0, y: 0, w: 400, h: 300 }, [])

    assert.equal(cues[1]!.x - (cues[0]!.x + 116), 8)
  }
})

test('cue сдвигается от препятствия и clampится по второй оси', () => {
  const clamped = placeSeriesCues([
    { launchId: 'blocked', direction: 'right', hiddenCount: 1, totalCount: 2 },
  ], { x: 0, y: 0, w: 400, h: 150 }, [{ x: 260, y: 40, w: 130, h: 80 }])

  assert.equal(clamped[0]?.y, 90)
})

test('mixed cue попадает в правый нижний угол', () => {
  const viewport = { x: 0, y: 0, w: 400, h: 300 }
  const cues = placeSeriesCues([
    { launchId: 'mixed', direction: 'mixed', hiddenCount: 1, totalCount: 2 },
  ], viewport, [])

  assert.deepEqual(cues[0], {
    launchId: 'mixed', direction: 'mixed', hiddenCount: 1, totalCount: 2, x: 268, y: 240,
  })
})

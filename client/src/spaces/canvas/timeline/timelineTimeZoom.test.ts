import assert from 'node:assert/strict'
import test from 'node:test'
import {
  followHeadInWindow,
  fullTimeWindow,
  isWindowZoomed,
  panTimeWindow,
  rulerTicksForWindow,
  slicePeaksForWindow,
  snapTimelineTime,
  timeToWindowPercent,
  timeZoomFactor,
  windowRatioToTime,
  zoomTimeWindow,
} from './timelineTimeZoom'

test('fullTimeWindow покрывает весь клип и имеет масштаб 1×', () => {
  const win = fullTimeWindow(20)
  assert.deepEqual(win, { start: 0, end: 20 })
  assert.equal(timeZoomFactor(win, 20), 1)
  assert.equal(isWindowZoomed(win, 20), false)
})

test('zoomTimeWindow приближает и отдаляет относительно времени под курсором (Alt + колесо)', () => {
  const full = fullTimeWindow(20)
  // Курсор на 5с (25% дорожки), приближаем в 2 раза → окно шириной 10с, где 5с остаётся на 25% ([2.5, 12.5])
  const z2 = zoomTimeWindow(full, 20, 2, 5)
  assert.ok(Math.abs(z2.start - 2.5) < 1e-6)
  assert.ok(Math.abs(z2.end - 12.5) < 1e-6)
  assert.ok(Math.abs(timeToWindowPercent(5, z2) - 25) < 1e-6)
  assert.equal(isWindowZoomed(z2, 20), true)
  assert.ok(Math.abs(timeZoomFactor(z2, 20) - 2) < 1e-6)

  // Отдаляем обратно в 2 раза — возвращаемся к полному окну [0, 20]
  const back = zoomTimeWindow(z2, 20, 0.5, 5)
  assert.deepEqual(back, { start: 0, end: 20 })
  assert.equal(isWindowZoomed(back, 20), false)
})

test('zoomTimeWindow зажимает окно в границах клипа и максимального зума', () => {
  const full = fullTimeWindow(16)
  // Огромный зум не делает окно уже 1 секунды и сохраняет якорную позицию под курсором
  const deep = zoomTimeWindow(full, 16, 100, 15.8)
  assert.ok(Math.abs((deep.end - deep.start) - 1) < 1e-6)
  assert.ok(Math.abs(timeToWindowPercent(15.8, deep) - (15.8 / 16) * 100) < 1e-6)
  assert.ok(deep.start >= 0 && deep.end <= 16)

  // Отдаление у правого края зажимает правую границу в конец клипа (16с)
  const clampedRight = zoomTimeWindow({ start: 15, end: 16 }, 16, 0.25, 15.1)
  assert.deepEqual(clampedRight, { start: 12, end: 16 })
})

test('panTimeWindow и followHeadInWindow двигают видимое окно без выхода за [0, duration]', () => {
  const win = { start: 4, end: 8 }
  assert.deepEqual(panTimeWindow(win, 20, 3), { start: 7, end: 11 })
  assert.deepEqual(panTimeWindow(win, 20, -10), { start: 0, end: 4 })
  assert.deepEqual(panTimeWindow(win, 20, 50), { start: 16, end: 20 })

  // Пока голова внутри окна — окно не дёргается
  assert.deepEqual(followHeadInWindow(win, 20, 6.2), win)
  // Голова ушла вправо — окно перелистывается вперёд и держит голову видимой
  const followedRight = followHeadInWindow(win, 20, 9.5)
  assert.ok(followedRight.start > win.start)
  assert.ok(9.5 >= followedRight.start && 9.5 <= followedRight.end)
  // Голова ушла влево — окно перелистывается назад
  const followedLeft = followHeadInWindow(win, 20, 2.0)
  assert.ok(followedLeft.start < win.start)
  assert.ok(2.0 >= followedLeft.start && 2.0 <= followedLeft.end)
})

test('windowRatioToTime и timeToWindowPercent взаимно обратны внутри окна', () => {
  const win = { start: 5, end: 15 }
  const time = windowRatioToTime(0.35, win, 30)
  assert.ok(Math.abs(time - 8.5) < 1e-6)
  assert.ok(Math.abs(timeToWindowPercent(time, win) - 35) < 1e-6)
})

test('snapTimelineTime притягивает к ближайшей метке в пределах порога в пикселях и отключается по bypass', () => {
  const win = { start: 0, end: 10 }
  // 1000px дорожка → 6px = 0.06с
  assert.deepEqual(snapTimelineTime(4.04, [1, 4, 8], win, 1000, false), { time: 4, snapped: true })
  assert.deepEqual(snapTimelineTime(4.2, [1, 4, 8], win, 1000, false), { time: 4.2, snapped: false })
  assert.deepEqual(snapTimelineTime(4.04, [1, 4, 8], win, 1000, true), { time: 4.04, snapped: false })
})

test('rulerTicksForWindow уплотняет деления при приближении времени', () => {
  const wideTicks = rulerTicksForWindow({ start: 0, end: 60 }, 800).filter((tick) => tick.major)
  const zoomedTicks = rulerTicksForWindow({ start: 10, end: 12 }, 800).filter((tick) => tick.major)
  assert.ok(wideTicks.length >= 4 && wideTicks.length <= 15)
  assert.ok(zoomedTicks.length >= 4 && zoomedTicks.length <= 15)
  // На двухсекундном окне шаг делений меньше секунды
  assert.ok(zoomedTicks[1].time - zoomedTicks[0].time < 1)
})

test('slicePeaksForWindow вырезает и масштабирует пики аудио под текущее окно времени', () => {
  // Первая половина тихая (10), вторая громкая (90)
  const peaks = [...Array.from({ length: 50 }, () => 10), ...Array.from({ length: 50 }, () => 90)]
  const firstHalf = slicePeaksForWindow(peaks, { start: 0, end: 5 }, 10, 10)
  const secondHalf = slicePeaksForWindow(peaks, { start: 5, end: 10 }, 10, 10)
  assert.equal(firstHalf.length, 10)
  assert.equal(secondHalf.length, 10)
  assert.ok(firstHalf.every((v) => v <= 20))
  assert.ok(secondHalf.every((v) => v >= 80))
})

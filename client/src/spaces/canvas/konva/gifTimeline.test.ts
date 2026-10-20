import assert from 'node:assert/strict'
import test from 'node:test'
import { gifFrameAt, gifFrameStartMs, gifTotalMs } from './gifTimeline'

// Плеер GIF (просьба 22.09.2026 «плеер как для видео, только для гиф»):
// у кадров разная длительность, и перемотка обязана это учитывать.
const durations = [100, 50, 200, 100]

test('полная длительность и начало кадра — суммы, а не кадр × шаг', () => {
  assert.equal(gifTotalMs(durations), 450)
  assert.equal(gifFrameStartMs(durations, 0), 0)
  assert.equal(gifFrameStartMs(durations, 2), 150)
  assert.equal(gifFrameStartMs(durations, 3), 350)
})

test('кадр в момент времени — с учётом разной длительности кадров', () => {
  assert.equal(gifFrameAt(durations, 0), 0)
  assert.equal(gifFrameAt(durations, 99), 0)
  assert.equal(gifFrameAt(durations, 100), 1)
  assert.equal(gifFrameAt(durations, 149), 1)
  assert.equal(gifFrameAt(durations, 150), 2)
  assert.equal(gifFrameAt(durations, 349), 2)
  assert.equal(gifFrameAt(durations, 350), 3)
})

test('граница кадра не уезжает из-за дробей: 0.75 полосы × 1.2 с — это 900 мс', () => {
  const twelve = Array.from({ length: 12 }, () => 100)
  assert.equal(0.75 * 1.2 * 1000 < 900, true, 'дробь и правда чуть меньше границы')
  assert.equal(gifFrameAt(twelve, 0.75 * 1.2 * 1000), 9)
})

test('за краями полосы — первый и последний кадр, а не начало по кругу', () => {
  assert.equal(gifFrameAt(durations, -10), 0)
  assert.equal(gifFrameAt(durations, 450), 3)
  assert.equal(gifFrameAt(durations, 10_000), 3)
  assert.equal(gifFrameAt(durations, Number.NaN), 0)
  assert.equal(gifFrameAt([], 100), 0)
})

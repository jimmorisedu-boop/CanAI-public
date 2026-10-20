import test from 'node:test'
import assert from 'node:assert/strict'
import {
  alternateStep,
  clampToDuration,
  DRIFT_THRESHOLD,
  shouldSeek,
  syncPlan,
  timelineDuration,
  type VideoLike,
} from './compareSync'

const video = (patch: Partial<VideoLike> = {}): VideoLike => ({
  currentTime: 0,
  playbackRate: 1,
  paused: true,
  readyState: 4,
  ...patch,
})

test('мелкий дрейф не трогаем — иначе воспроизведение дёргается', () => {
  const primary = video({ currentTime: 5 })
  const secondary = video({ currentTime: 5.05 }) // 0.05 < порога
  assert.deepEqual(syncPlan(primary, [secondary]), [])
})

test('заметное расхождение подтягивается к ведущему', () => {
  const primary = video({ currentTime: 5 })
  const secondary = video({ currentTime: 7 })
  assert.deepEqual(syncPlan(primary, [secondary]), [{ index: 0, seekTo: 5 }])
})

test('порог — ровно 0.12с и он публичный', () => {
  assert.equal(DRIFT_THRESHOLD, 0.12)
  assert.equal(shouldSeek(5, 5.1), false)
  assert.equal(shouldSeek(5, 5.2), true)
  assert.equal(shouldSeek(5, 5.05, { force: true }), true)
  assert.equal(shouldSeek(5, 5.05, { resetTime: true }), true)
})

test('без метаданных currentTime не пишем — присвоение потерялось бы', () => {
  const primary = video({ currentTime: 5 })
  const notReady = video({ currentTime: 0, readyState: 0 })
  assert.deepEqual(syncPlan(primary, [notReady]), [])
})

test('скорость и состояние play/pause копируются с ведущего', () => {
  const primary = video({ currentTime: 2, playbackRate: 0.5, paused: false })
  const secondary = video({ currentTime: 2, playbackRate: 1, paused: true })
  assert.deepEqual(syncPlan(primary, [secondary]), [
    { index: 0, setRate: 0.5, play: true },
  ])
})

test('сброс возвращает всех в начало независимо от порога', () => {
  const primary = video({ currentTime: 9 })
  const secondary = video({ currentTime: 9 })
  assert.deepEqual(syncPlan(primary, [secondary], { resetTime: true }), [
    { index: 0, seekTo: 0 },
  ])
})

test('план строится на каждого подчинённого отдельно', () => {
  const primary = video({ currentTime: 4, paused: false })
  const plan = syncPlan(primary, [
    video({ currentTime: 4, paused: false }), // в норме — команды нет
    video({ currentTime: 0, paused: false }), // отстал
    video({ currentTime: 4, paused: true }), // на паузе
  ])
  assert.deepEqual(plan, [
    { index: 1, seekTo: 4 },
    { index: 2, play: true },
  ])
})

test('режим «по очереди» перекидывает воспроизведение между двумя видео', () => {
  const first = alternateStep(null)
  assert.equal(first.playingIndex, 0)
  assert.equal(first.playFrom, 0)
  assert.equal(first.pause, 1)

  const second = alternateStep({ playingIndex: 0 })
  assert.equal(second.playingIndex, 1)
  assert.equal(second.playFrom, 1)
  assert.equal(second.pause, 0)

  assert.equal(alternateStep({ playingIndex: 1 }).playingIndex, 0)
})

test('общая шкала идёт по самому длинному, мусор в длительностях игнорируем', () => {
  assert.equal(timelineDuration([5, 8, 3]), 8)
  assert.equal(timelineDuration([NaN, Infinity, 4]), 4)
  assert.equal(timelineDuration([]), 0)
  assert.equal(timelineDuration([0, -2]), 0)
})

test('время не выходит за шкалу', () => {
  assert.equal(clampToDuration(-1, 10), 0)
  assert.equal(clampToDuration(4, 10), 4)
  assert.equal(clampToDuration(99, 10), 10)
  assert.equal(clampToDuration(4, 0), 0)
})

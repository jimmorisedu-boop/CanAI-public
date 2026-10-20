import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUDIO_BIG_STEP_S,
  AUDIO_STEP_S,
  audioSeekStep,
  nextAudioTime,
  timeFromWaveRatio,
} from './audioSeek.js'

test('шаг стрелки: секунда, с Shift — заметно больше', () => {
  assert.equal(audioSeekStep(false), AUDIO_STEP_S)
  assert.equal(audioSeekStep(true), AUDIO_BIG_STEP_S)
  assert.ok(AUDIO_BIG_STEP_S > AUDIO_STEP_S * 4, 'иначе большой шаг неотличим от обычного')
})

test('курсор не уходит за края дорожки', () => {
  // Уехав за конец, звук просто перестал бы играть без объяснений.
  assert.equal(nextAudioTime({ current: 0.4, duration: 55, direction: -1, shiftKey: false }), 0)
  assert.equal(nextAudioTime({ current: 54.5, duration: 55, direction: 1, shiftKey: false }), 55)
  assert.equal(nextAudioTime({ current: 3, duration: 6, direction: 1, shiftKey: true }), 6)
})

test('обычный шаг двигает ровно на секунду в обе стороны', () => {
  assert.equal(nextAudioTime({ current: 10, duration: 55, direction: 1, shiftKey: false }), 11)
  assert.equal(nextAudioTime({ current: 10, duration: 55, direction: -1, shiftKey: false }), 9)
  assert.equal(nextAudioTime({ current: 10, duration: 55, direction: 1, shiftKey: true }), 20)
})

test('неизвестная длительность не даёт уехать в никуда', () => {
  // duration у только что импортированного mp3 может ещё не прочитаться.
  assert.equal(nextAudioTime({ current: 5, duration: 0, direction: 1, shiftKey: false }), 0)
  assert.equal(nextAudioTime({ current: 5, duration: Number.NaN, direction: 1, shiftKey: false }), 0)
  assert.equal(timeFromWaveRatio(0.5, 0), 0)
})

test('клик по волне переводится в время по доле ширины', () => {
  assert.equal(timeFromWaveRatio(0, 60), 0)
  assert.equal(timeFromWaveRatio(0.5, 60), 30)
  assert.equal(timeFromWaveRatio(1, 60), 60)
  // мимо краёв — прижимаем, а не отдаём отрицательное время
  assert.equal(timeFromWaveRatio(-0.2, 60), 0)
  assert.equal(timeFromWaveRatio(1.4, 60), 60)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { AUDIO_ITEM_HEIGHT, AUDIO_ITEM_WIDTH, audioTitle, formatDuration } from './audioMeta.js'

test('длительность округляется до секунд и не показывает часы', () => {
  assert.equal(formatDuration(7), '0:07')
  assert.equal(formatDuration(7.4), '0:07')
  assert.equal(formatDuration(7.6), '0:08')
  assert.equal(formatDuration(83), '1:23')
  assert.equal(formatDuration(725), '12:05')
  assert.equal(formatDuration(0), '0:00')
})

test('неизвестная длительность честно показывает прочерк, а не ноль', () => {
  // Плашка со стоящим «0:00» врёт: файл может быть длинным, просто метаданные
  // ещё не прочитались или не читаются вовсе.
  assert.equal(formatDuration(undefined), '—')
  assert.equal(formatDuration(Number.NaN), '—')
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '—')
  assert.equal(formatDuration(-3), '—')
})

test('в подписи остаётся имя без расширения', () => {
  assert.equal(audioTitle('voice-04.mp3'), 'voice-04')
  assert.equal(audioTitle('шот 04 — звук.wav'), 'шот 04 — звук')
  // точка в середине имени — часть названия, а не расширение
  assert.equal(audioTitle('take.2.final.m4a'), 'take.2.final')
  // файл без расширения теряет только пустоту
  assert.equal(audioTitle('дорожка'), 'дорожка')
})

test('безымянный файл получает слово, а не пустую плашку', () => {
  assert.equal(audioTitle(undefined), 'audio')
  assert.equal(audioTitle(''), 'audio')
  assert.equal(audioTitle('   '), 'audio')
  assert.equal(audioTitle('.mp3'), 'audio')
})

test('плашка звука имеет размеры по умолчанию', () => {
  assert.ok(AUDIO_ITEM_WIDTH > AUDIO_ITEM_HEIGHT, 'дорожка — горизонтальная плашка, а не квадрат')
  assert.ok(AUDIO_ITEM_HEIGHT >= 20, 'ниже этого onTransformEnd всё равно не даст сжать')
})

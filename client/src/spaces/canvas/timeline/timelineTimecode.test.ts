import assert from 'node:assert/strict'
import test from 'node:test'
import { timecode } from './timelineTimecode'

test('таймкод — минуты:секунды.сотые, всегда двумя цифрами', () => {
  assert.equal(timecode(0), '00:00.00')
  assert.equal(timecode(10.6), '00:10.60')
  assert.equal(timecode(4.2), '00:04.20')
  assert.equal(timecode(75.5), '01:15.50')
  assert.equal(timecode(600), '10:00.00')
})

test('граница минуты не даёт «00:60.00»', () => {
  assert.equal(timecode(59.999), '01:00.00')
  assert.equal(timecode(59.994), '00:59.99')
})

test('мусор на входе — нулевой таймкод, а не NaN в разметке', () => {
  assert.equal(timecode(Number.NaN), '00:00.00')
  assert.equal(timecode(-3), '00:00.00')
  assert.equal(timecode(Number.POSITIVE_INFINITY), '00:00.00')
})

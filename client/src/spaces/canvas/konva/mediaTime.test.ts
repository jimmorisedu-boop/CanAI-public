import assert from 'node:assert/strict'
import test from 'node:test'
import { formatMediaTime } from './mediaTime'

test('время плеера не теряет сотую на дробях: 1,2 с — это «0:01.20»', () => {
  assert.equal(formatMediaTime(1.2), '0:01.20')
  assert.equal(formatMediaTime(0.9), '0:00.90')
  assert.equal(formatMediaTime(4.35), '0:04.35')
})

test('минуты, секунды и сотые — отбрасываем, а не округляем', () => {
  assert.equal(formatMediaTime(0), '0:00.00')
  assert.equal(formatMediaTime(2.999), '0:02.99')
  assert.equal(formatMediaTime(61.5), '1:01.50')
  assert.equal(formatMediaTime(3599.99), '59:59.99')
})

test('негодное время — нули, а не «NaN:NaN»', () => {
  assert.equal(formatMediaTime(Number.NaN), '0:00.00')
  assert.equal(formatMediaTime(Number.POSITIVE_INFINITY), '0:00.00')
  assert.equal(formatMediaTime(-3), '0:00.00')
})

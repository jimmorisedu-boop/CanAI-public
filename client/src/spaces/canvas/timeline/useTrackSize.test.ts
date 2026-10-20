import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldAcceptTrackSize } from './useTrackSize'

test('первый осмысленный размер принимается всегда', () => {
  assert.equal(shouldAcceptTrackSize({ width: 0, height: 0 }, { width: 994, height: 38 }), true)
})

test('нулевой или отрицательный размер не принимается: плёнку не пересобирают ради «ничего»', () => {
  assert.equal(shouldAcceptTrackSize({ width: 994, height: 38 }, { width: 0, height: 38 }), false)
  assert.equal(shouldAcceptTrackSize({ width: 994, height: 38 }, { width: 994, height: 0 }), false)
})

test('мелкое изменение ширины плёнку не трогает, заметное — пересчитывает', () => {
  const prev = { width: 1000, height: 38 }
  assert.equal(shouldAcceptTrackSize(prev, { width: 1040, height: 38 }), false)
  assert.equal(shouldAcceptTrackSize(prev, { width: 880, height: 38 }), true)
  assert.equal(shouldAcceptTrackSize(prev, { width: 1200, height: 38 }), true)
})

test('смена высоты (тач-экран) пересчитывает плёнку даже без смены ширины', () => {
  assert.equal(shouldAcceptTrackSize({ width: 1000, height: 38 }, { width: 1000, height: 44 }), true)
  assert.equal(shouldAcceptTrackSize({ width: 1000, height: 38 }, { width: 1000, height: 39 }), false)
})

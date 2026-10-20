import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_CANDIDATES, parseShotScores, peakCandidates } from './shotDetect.js'

const OUTPUT = [
  'frame:0    pts:0      pts_time:0',
  'lavfi.scd.score=0.000000',
  'frame:24   pts:24000  pts_time:1.000000',
  'lavfi.scd.score=42.500000',
  'frame:25   pts:25000  pts_time:1.041667',
  'lavfi.scd.score=38.100000',
  'frame:96   pts:96000  pts_time:4.000000',
  'lavfi.scd.score=3.200000',
].join('\n')

test('пары «время + балл» читаются из вывода фильтра', () => {
  assert.deepEqual(parseShotScores(OUTPUT), [
    { time: 0, score: 0 },
    { time: 1, score: 42.5 },
    { time: 1.042, score: 38.1 },
    { time: 4, score: 3.2 },
  ])
})

test('балл без времени и время без балла не превращаются в кандидата', () => {
  // ffmpeg иногда рвёт вывод: одинокая строка не должна прицепиться к чужому
  // времени и создать метку там, где ничего не происходило.
  assert.deepEqual(parseShotScores('lavfi.scd.score=50.0'), [])
  assert.deepEqual(parseShotScores('frame:1 pts_time:2.0'), [])
  assert.deepEqual(parseShotScores(''), [])
})

test('из группы близких срабатываний остаётся самое уверенное', () => {
  // У настоящей склейки высокий балл держится несколько кадров подряд. Без
  // слияния одна склейка дала бы частокол меток вплотную.
  const peaks = peakCandidates(parseShotScores(OUTPUT))
  assert.deepEqual(peaks, [{ time: 1, score: 42.5 }, { time: 4, score: 3.2 }])
})

test('тишина в начале не считается склейкой', () => {
  // Нулевой кадр всегда «не похож на предыдущий», потому что предыдущего нет.
  // Резать в самом начале бессмысленно — там и так граница клипа.
  const peaks = peakCandidates([{ time: 0, score: 99 }, { time: 2, score: 20 }])
  assert.deepEqual(peaks, [{ time: 2, score: 20 }])
})

test('слабые срабатывания отсекаются порогом пола', () => {
  const peaks = peakCandidates([{ time: 1, score: 1.2 }, { time: 3, score: 2.5 }])
  assert.deepEqual(peaks, [{ time: 3, score: 2.5 }])
})

test('список кандидатов ограничен и отсортирован по времени', () => {
  const many = Array.from({ length: 200 }, (_, index) => ({ time: (index + 1) * 2, score: 10 + (index % 7) }))
  const peaks = peakCandidates(many)
  assert.equal(peaks.length, MAX_CANDIDATES, 'больше не разглядеть на дорожке')
  const times = peaks.map((candidate) => candidate.time)
  assert.deepEqual(times, [...times].sort((left, right) => left - right))
})

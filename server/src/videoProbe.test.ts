import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFrameRate, parseVideoFacts } from './videoProbe.js'

test('частота кадров читается дробью, как её отдаёт ffprobe', () => {
  assert.equal(parseFrameRate('24/1'), 24)
  assert.equal(parseFrameRate('30000/1001'), 30000 / 1001)
  assert.equal(parseFrameRate('25'), 25)
})

test('невнятная частота остаётся неизвестной, а не бесконечностью', () => {
  // «0/0» бывает у файлов без нормальных заголовков. Поделив на ноль, стрелка
  // в таймлайне шагала бы в бесконечность.
  assert.equal(parseFrameRate('0/0'), undefined)
  assert.equal(parseFrameRate('24/0'), undefined)
  assert.equal(parseFrameRate('N/A'), undefined)
  assert.equal(parseFrameRate(undefined), undefined)
  assert.equal(parseFrameRate('100000/1'), undefined, 'заведомо неправдоподобная частота')
})

test('факты о видео читаются, а недостающее остаётся неизвестным', () => {
  const facts = parseVideoFacts(JSON.stringify({
    streams: [{ codec_type: 'video', width: 1280, height: 720, r_frame_rate: '24/1' }, { codec_type: 'audio' }],
    format: { duration: '12.400000' },
  }))
  assert.deepEqual(facts, { duration: 12.4, width: 1280, height: 720, fps: 24, hasAudio: true })

  // Поток без размеров бывает у битых файлов: лучше «не знаю», чем нули,
  // по которым потом посчитается заглушка размером ноль на ноль.
  const partial = parseVideoFacts(JSON.stringify({ streams: [{ codec_type: 'video' }], format: {} }))
  assert.deepEqual(partial, { duration: 0, width: undefined, height: undefined, fps: undefined, hasAudio: false })
})

test('пустой ответ ffprobe не роняет разбор', () => {
  assert.deepEqual(parseVideoFacts(''), { duration: 0, width: undefined, height: undefined, fps: undefined, hasAudio: false })
})

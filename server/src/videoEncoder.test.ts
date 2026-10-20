import assert from 'node:assert/strict'
import test from 'node:test'
import { cropFilter, encoderArgs, parseEncoders, pickEncoder } from './videoEncoder.js'

const ENCODERS_OUTPUT = [
 'Encoders:',
 ' V..... = Video',
 ' ------',
 ' V....D h264_amf             AMD AMF H.264 Encoder (codec h264)',
 ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
 ' V..... libopenh264          OpenH264 H.264 / AVC / MPEG-4 AVC (codec h264)',
 ' A..... aac                  AAC (Advanced Audio Coding)',
].join('\n')

test('имена кодировщиков вычитываются из таблицы ffmpeg', () => {
  const found = parseEncoders(ENCODERS_OUTPUT)
  assert.ok(found.has('h264_nvenc'))
  assert.ok(found.has('libopenh264'))
  assert.ok(found.has('aac'))
  assert.equal(found.has('Encoders:'), false)
})

test('аппаратный кодировщик предпочтительнее программного', () => {
  assert.equal(pickEncoder(parseEncoders(ENCODERS_OUTPUT)), 'h264_nvenc')
  assert.equal(pickEncoder(new Set(['h264_qsv', 'libopenh264'])), 'h264_qsv')
  // Без видеокарты остаётся программный — и он ЕСТЬ в нашей LGPL-сборке,
  // так что кроп работает и на слабой машине.
  assert.equal(pickEncoder(new Set(['libopenh264'])), 'libopenh264')
})

test('x264 не выбирается, даже если он в сборке есть', () => {
  // Он GPL. В сборке для покупателя его нет, но чужая системная сборка может
  // его принести — и молча заразить результат лицензией.
  assert.equal(pickEncoder(new Set(['libx264', 'libx265'])), null)
})

// h264_videotoolbox добавлен ПЕРВЫМ в список предпочтений. На Windows его в
// сборке нет вовсе, поэтому выбор обязан остаться прежним — иначе добавление
// маковского кодировщика тихо поменяло бы поведение на чужой системе.
test('кодировщик Apple не отбирает выбор у Windows-сборки', () => {
  const windowsLike = new Set(['h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264'])
  assert.equal(pickEncoder(windowsLike), 'h264_nvenc')
  assert.equal(pickEncoder(new Set(['h264_amf', 'libopenh264'])), 'h264_amf')

  // А на маке доступен только он.
  assert.equal(pickEncoder(new Set(['h264_videotoolbox'])), 'h264_videotoolbox')
})

// ⚠️ У VideoToolbox шкала перевёрнута: 1..100, больше — лучше. Общий запасной
// `-q 20` (он для libopenh264) означал бы там сильное ухудшение: замер дал
// SSIM 0.967 против 0.9986 при 65.
test('качество для кодировщика Apple задано его собственной шкалой', () => {
  assert.deepEqual(encoderArgs('h264_videotoolbox'), ['-q:v', '65'])
  // Остальные не сдвинулись.
  assert.deepEqual(encoderArgs('h264_nvenc'), ['-preset', 'p5', '-rc', 'vbr', '-cq', '20', '-b:v', '0'])
  assert.deepEqual(encoderArgs('libopenh264'), ['-q', '20'])
})

test('у каждого кодировщика своя ручка качества', () => {
  assert.ok(encoderArgs('h264_nvenc').includes('-cq'))
  assert.ok(encoderArgs('h264_qsv').includes('-global_quality'))
  assert.ok(encoderArgs('h264_amf').includes('-qp_i'))
  assert.ok(encoderArgs('libopenh264').includes('-q'))
})

test('кроп переводится в пиксели с ЧЁТНЫМИ сторонами', () => {
  // У H.264 цветность прорежена вдвое: кадр с нечётной стороной кодировщик
  // либо не примет, либо молча подгонит сам.
  assert.equal(cropFilter({ x: 0, y: 0, w: 1, h: 1 }, { width: 1280, height: 720 }), 'crop=1280:720:0:0')
  assert.equal(cropFilter({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, { width: 641, height: 361 }), 'crop=320:180:64:72')
})

test('вырожденный и вылезающий за кадр кроп отвергается, а не подгоняется', () => {
  // Схлопнутая в точку рамка превращалась бы в честный на вид кадр 2×2, и
  // человек получил бы пиксель вместо отказа.
  assert.equal(cropFilter({ x: 0, y: 0, w: 0, h: 0 }, { width: 100, height: 100 }), null)
  assert.equal(cropFilter({ x: 0, y: 0, w: 0.01, h: 0.5 }, { width: 100, height: 100 }), null)
  assert.equal(cropFilter({ x: 0, y: 0, w: 2, h: 2 }, { width: 100, height: 100 }), null)
  assert.equal(cropFilter({ x: 0.8, y: 0, w: 0.5, h: 0.5 }, { width: 100, height: 100 }), null)
  assert.equal(cropFilter({ x: -0.1, y: 0, w: 0.5, h: 0.5 }, { width: 100, height: 100 }), null)
})

test('кроп у самого края остаётся внутри кадра', () => {
  assert.equal(cropFilter({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, { width: 100, height: 100 }), 'crop=50:50:50:50')
})

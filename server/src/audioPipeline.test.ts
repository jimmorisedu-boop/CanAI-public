import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildAudioInput } from './fal.js'
import { resolveModel } from './catalog.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const source = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8')

// ⚠️ Оба сторожа ниже закрывают дефекты, найденные прогоном 20.08.2026: звук
// не запускался (промпт уходил не в то поле) и не доезжал (файл отвергался
// после оплаты). Обе поломки были невидимы в типах — только вживую.

test('промпт звуковой модели уходит в ЕЁ поле, а не в prompt', () => {
  const sfx = resolveModel('eleven-sfx', 'audio', false)
  const input = buildAudioInput(sfx, 'короткий щелчок', [], { duration_seconds: 4 })
  assert.equal(input.text, 'короткий щелчок')
  assert.equal(input.prompt, undefined)
  assert.equal(input.duration_seconds, 4)

  const lyria = resolveModel('lyria', 'audio', false)
  const music = buildAudioInput(lyria, 'calm piano', [], {})
  assert.equal(music.prompt, 'calm piano')
})

test('звуковые эффекты идут на v2: прежний адрес fal объявил устаревшим', () => {
  // 20.10.2026 fal пометил fal-ai/elevenlabs/sound-effects «deprecated and no
  // longer supported». У v2 та же схема (промпт в text), поэтому id и ручки
  // прежние — сохранённые макросы ничего не замечают.
  const sfx = resolveModel('eleven-sfx', 'audio', false)
  assert.equal(sfx.endpoint, 'fal-ai/elevenlabs/sound-effects/v2')
  assert.equal(sfx.promptInput, 'text')
})

test('дорожка-референс подставляется в поле модели', () => {
  const separate = resolveModel('sam-audio-separate', 'audio', true)
  const input = buildAudioInput(separate, 'голос', ['https://fal/audio.mp3'], { output_format: 'mp3' })
  assert.equal(input.audio_url, 'https://fal/audio.mp3')
  assert.equal(input.output_format, 'mp3')
})

test('у звука есть своя ветка в generateByModel — иначе он уедет в видео-сборку', () => {
  const text = source('fal.ts')
  const dispatcher = text.slice(text.indexOf('export async function generateByModel'))
  assert.match(dispatcher, /model\.kind === 'audio'[\s\S]{0,200}buildAudioInput/)
  // видео-ветка идёт последней и подхватывает всё, для чего ветки нет
  assert.ok(
    dispatcher.indexOf("model.kind === 'audio'") < dispatcher.indexOf('buildVideoInput('),
    'ветка звука должна стоять ДО видео-сборки',
  )
})

test('приёмник скачанных файлов пропускает звук наравне с картинкой и видео', () => {
  const text = source('safeRemote.ts')
  const guard = text.slice(text.indexOf('const mime = responseMime(response)'), text.indexOf('const total = contentLength'))
  assert.match(guard, /audio\//)
  for (const kind of ['image/', 'video/', 'audio/']) {
    assert.ok(guard.includes(`startsWith('${kind}')`), `в проверке нет ${kind}`)
  }
})

test('простыня поставщика обрезается до человеческой фразы', async () => {
  const { trimProviderNoise } = await import('./fal.js')
  const real = "Sound effect generation failed: headers: {'date': 'Thu, 20 Aug 2026 19:03:50 GMT', 'server': 'uvicorn', 'content-length': '243'}"
  assert.equal(trimProviderNoise(real), 'Sound effect generation failed')
  assert.equal(trimProviderNoise('Unsupported language detected. Please use English.'), 'Unsupported language detected. Please use English.')
  assert.equal(trimProviderNoise('Traceback (most recent call last): ...'), 'Traceback (most recent call last): ...'.slice(0, 300))
})

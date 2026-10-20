import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { imageRefForModel } from './refImageFormat.js'

test('GIF-референс уходит модели как PNG-кадр, а не исходная анимация', async () => {
  const gif = await sharp({
    create: { width: 4, height: 3, channels: 4, background: '#ef492e' },
  }).gif().toBuffer()
  const converted = await imageRefForModel(gif, 'image/gif')
  assert.equal(converted.mime, 'image/png')
  assert.equal((await sharp(converted.data).metadata()).format, 'png')
  assert.equal((await sharp(converted.data).metadata()).width, 4)
})

test('GIF распознаётся по сигнатуре даже при ошибочном MIME', async () => {
  const gif = await sharp({
    create: { width: 2, height: 2, channels: 4, background: '#ef492e' },
  }).gif().toBuffer()
  assert.equal((await imageRefForModel(gif, 'image/png')).mime, 'image/png')
  const invalid = Buffer.from('GIF89a-not-an-image')
  await assert.rejects(imageRefForModel(invalid, 'image/gif'))
})

test('обычные PNG-референсы не перекодируются', async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: '#ef492e' },
  }).png().toBuffer()
  const converted = await imageRefForModel(png, 'image/png')
  assert.strictEqual(converted.data, png)
  assert.equal(converted.mime, 'image/png')
})

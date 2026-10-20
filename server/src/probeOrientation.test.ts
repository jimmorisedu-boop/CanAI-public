import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-probe-orientation-'))
process.env.CANAI_DATA_DIR = dataRoot
process.env.CANAI_ENV_FILE = path.join(dataRoot, 'empty.env')
process.env.CANAI_MOCK = '1'
await fs.writeFile(process.env.CANAI_ENV_FILE, '')
const { probeMediaBufferDimensions, probeLocalMediaDimensions } = await import('./storage.js')
const { prepareImageParams } = await import('./imageParams.js')
const { CATALOG } = await import('./catalog.js')
const media = path.join(dataRoot, 'media')
await fs.mkdir(media)
test.after(() => fs.rm(dataRoot, { recursive: true, force: true }))

for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`JPEG EXIF ${orientation}: probe совпадает с размерами после поворота`, async () => {
    const input = await sharp({ create: { width: 80, height: 40, channels: 3, background: 'red' } })
      .withMetadata({ orientation }).jpeg().toBuffer()
    const { info } = await sharp(input).autoOrient().raw().toBuffer({ resolveWithObject: true })
    const expected = { width: info.width, height: info.height }
    assert.deepEqual(probeMediaBufferDimensions(input), expected)
    const name = `orientation-${orientation}.jpg`
    await fs.writeFile(path.join(media, name), input)
    assert.deepEqual(probeLocalMediaDimensions(`/media/${name}?v=1`), expected)
  })
}

test('auto 2K учитывает EXIF-портрет даже при наличии правильных размеров клиента', async () => {
  const input = await sharp({ create: { width: 80, height: 40, channels: 3, background: 'red' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer()
  await fs.writeFile(path.join(media, 'portrait.jpg'), input)
  const preset = CATALOG.find((item) => item.id === 'chatgpt-image-2-edit')!
  const output = prepareImageParams(preset, { aspect_ratio: 'auto', resolution: '2K' }, [
    { kind: 'image', src: '/media/portrait.jpg', width: 40, height: 80 },
  ])
  assert.deepEqual(output.image_size, { width: 1024, height: 2048 })
})

test('Nano Banana 2 фиксирует auto по EXIF-портрету из самого файла', async () => {
  const input = await sharp({ create: { width: 80, height: 40, channels: 3, background: 'red' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer()
  await fs.writeFile(path.join(media, 'nano-portrait.jpg'), input)
  const preset = CATALOG.find((item) => item.id === 'nano-banana-edit')!
  const output = prepareImageParams(preset, { aspect_ratio: 'auto', resolution: '2K' }, [
    { kind: 'image', src: '/media/nano-portrait.jpg', width: 80, height: 40 },
  ])
  assert.equal(output.aspect_ratio, '9:16')
})

test('GPT Image 2.5 Sunburst: «авто» на 2K по вертикальному референсу даёт вертикальный кадр', async () => {
  // Жалоба 22.09.2026 пришла с сетевой доски (там вышло 2048×1536), а здесь
  // проверяем, что на локальной доске та же модель ведёт себя верно — и когда
  // пропорции пришли словом «auto», и когда ключа нет вовсе.
  const input = await sharp({ create: { width: 90, height: 160, channels: 3, background: 'red' } }).png().toBuffer()
  await fs.writeFile(path.join(media, 'sunburst-portrait.png'), input)
  const preset = CATALOG.find((item) => item.id === 'gpt-image-2.5-sunburst-edit')!
  for (const params of [
    { aspect_ratio: 'auto', resolution: '2K', quality: 'medium' },
    { resolution: '2K', quality: 'medium' },
  ]) {
    const output = prepareImageParams(preset, params, [{ kind: 'image', src: '/media/sunburst-portrait.png' }])
    const size = output.image_size as { width: number; height: number }
    assert.ok(size.height > size.width, `${JSON.stringify(params)} → ${size.width}×${size.height}`)
  }
})

test('большой EXIF-блок до JPEG SOF не скрывает размеры и ориентацию', async () => {
  const input = await sharp({ create: { width: 80, height: 40, channels: 3, background: 'red' } })
    .withMetadata({ orientation: 8 })
    .withExifMerge({ IFD0: { ImageDescription: 'synthetic-audit '.repeat(400) } })
    .jpeg().toBuffer()
  assert.ok(input.length > 4096)
  await fs.writeFile(path.join(media, 'large-exif.jpg'), input)
  assert.deepEqual(probeLocalMediaDimensions('/media/large-exif.jpg'), { width: 40, height: 80 })
})

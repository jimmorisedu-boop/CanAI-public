import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CATALOG } from './catalog.js'
import {
  findEffectiveCatalogPreset,
  prepareImageParams,
} from './imageParams.js'

const model = (id: string) => {
  const found = CATALOG.find((item) => item.id === id)
  assert.ok(found, `нет модели ${id}`)
  return found
}

test('effective preset предпочитает реальный edit endpoint исходному id', () => {
  const preset = findEffectiveCatalogPreset(
    CATALOG,
    'openai/gpt-image-2/edit',
    'chatgpt-image-2',
  )
  assert.equal(preset?.id, 'chatgpt-image-2-edit')
})

test('GPT Image 2 переводит 9:16 в официальный portrait preset', () => {
  assert.deepEqual(
    prepareImageParams(
      model('chatgpt-image-2'),
      { aspect_ratio: '9:16', quality: 'medium', output_format: 'png' },
      [],
    ),
    {
      image_size: 'portrait_16_9',
      quality: 'medium',
      output_format: 'png',
    },
  )
})

test('GPT Image 2 переводит 9:16 с 2K и 4K в допустимые custom-размеры', () => {
  const cases = [
    { resolution: '2K', width: 1152, height: 2048 },
    { resolution: '4K', width: 2160, height: 3840 },
  ]

  for (const expected of cases) {
    const actual = prepareImageParams(
      model('chatgpt-image-2-edit'),
      {
        aspect_ratio: '9:16',
        resolution: expected.resolution,
        quality: 'high',
      },
      [{ kind: 'image', src: '/media/source.png', width: 608, height: 1088 }],
    )

    assert.deepEqual(actual, {
      image_size: { width: expected.width, height: expected.height },
      quality: 'high',
    })
    assert.equal(expected.width % 16, 0)
    assert.equal(expected.height % 16, 0)
    assert.ok(expected.width * expected.height <= 8_294_400)
  }
})

test('GPT Image 2 берёт auto-пропорцию 2K из первого референса', () => {
  const actual = prepareImageParams(
    model('chatgpt-image-2-edit'),
    { aspect_ratio: 'auto', resolution: '2K', quality: 'high' },
    [{ kind: 'image', src: '/media/source.png', width: 608, height: 1088 }],
  )
  const size = actual.image_size as { width: number; height: number }

  assert.equal(size.height, 2048)
  assert.equal(size.width % 16, 0)
  assert.ok(Math.abs(size.width / size.height - 608 / 1088) < 0.01)
})

test('«Авто» на 1K отдаётся модели как auto — она сама возьмёт размер входа', () => {
  // раньше мы округляли пропорцию референса к ближайшему пресету, и портрет
  // мог превратиться в квадрат; у GPT Image 2 auto означает ровно «как на входе»
  assert.deepEqual(
    prepareImageParams(
      model('chatgpt-image-2-edit'),
      { aspect_ratio: 'auto', resolution: '1K', quality: 'high' },
      [{ kind: 'image', src: '/media/source.png', width: 608, height: 1088 }],
    ),
    { image_size: 'auto', quality: 'high' },
  )
})

test('размеры берём из ФАЙЛА, а не из присланных клиентом', () => {
  // клиент прислал квадрат (размер карточки на холсте), а файла на диске нет —
  // тогда работают присланные значения: 2K считается по ним
  const byClient = prepareImageParams(
    model('chatgpt-image-2-edit'),
    { aspect_ratio: 'auto', resolution: '2K', quality: 'high' },
    [{ kind: 'image', src: '/media/нет-такого-файла.png', width: 1000, height: 1000 }],
  )
  assert.deepEqual(byClient.image_size, { width: 2048, height: 2048 })
})

test('GPT Image 2 отклоняет неизвестное разрешение', () => {
  assert.throws(
    () => prepareImageParams(
      model('chatgpt-image-2'),
      { aspect_ratio: '1:1', resolution: '8K', quality: 'high' },
      [],
    ),
    /Unsupported GPT Image 2 resolution.*8K/i,
  )
})

test('GPT Image 2 edit без явного resolution берёт дефолт каталога (1K)', () => {
  // «Авто» убрано из разрешения — дефолт модели 1K, resolution можно не
  // передавать: adapter подставит catalog-дефолт и отдаст модели auto
  assert.deepEqual(
    prepareImageParams(
      model('chatgpt-image-2-edit'),
      { aspect_ratio: 'auto', quality: 'high' },
      [{ kind: 'image', src: '/media/source.png', width: 900, height: 1600 }],
    ),
    { image_size: 'auto', quality: 'high' },
  )
})

test('старая задача GPT с image_size не переписывается', () => {
  assert.deepEqual(
    prepareImageParams(
      model('chatgpt-image-2-edit'),
      { image_size: 'portrait_16_9', quality: 'high' },
      [],
    ),
    { image_size: 'portrait_16_9', quality: 'high' },
  )
})

test('Seedream auto и resolution превращаются в auto_2K', () => {
  assert.deepEqual(
    prepareImageParams(
      model('seedream-5-pro-edit'),
      { aspect_ratio: 'auto', resolution: '2K', enable_safety_checker: true },
      [],
    ),
    { image_size: 'auto_2K', enable_safety_checker: true },
  )
})

for (const id of ['seedream-5-pro', 'seedream-5-pro-edit']) {
  for (const aspect of ['1:1', '3:4', '4:3', '16:9', '9:16']) {
    test(`${id} ${aspect} 1K задаёт явный размер в пределах дешёвого тарифа`, () => {
      const actual = prepareImageParams(
        model(id),
        { aspect_ratio: aspect, resolution: '1K', enable_safety_checker: true },
        [],
      )
      assert.equal(typeof actual.image_size, 'object', 'named preset может вернуть 2K')
      const size = actual.image_size as { width: number; height: number }
      const [widthRatio, heightRatio] = aspect.split(':').map(Number)
      assert.ok(size.width * size.height >= 1024 * 1024)
      assert.ok(size.width * size.height <= 1536 * 1536)
      assert.equal(size.width % 16, 0)
      assert.equal(size.height % 16, 0)
      assert.ok(Math.abs(size.width / size.height - widthRatio! / heightRatio!) < 0.01)
      if (aspect === '1:1') assert.deepEqual(size, { width: 1024, height: 1024 })
      assert.equal(actual.enable_safety_checker, true)
      assert.equal('aspect_ratio' in actual, false)
      assert.equal('resolution' in actual, false)
    })
  }
}

test('Seedream auto 1K сохраняет нативный auto_1K', () => {
  assert.deepEqual(
    prepareImageParams(model('seedream-5-pro'), { aspect_ratio: 'auto', resolution: '1K' }, []),
    { image_size: 'auto_1K' },
  )
})

test('Seedream 9:16 2K получает портретный custom size допустимой площади', () => {
  const actual = prepareImageParams(
    model('seedream-5-pro'),
    { aspect_ratio: '9:16', resolution: '2K' },
    [],
  )
  const size = actual.image_size as { width: number; height: number }
  assert.ok(size.height > size.width)
  assert.ok(Math.abs(size.width / size.height - 9 / 16) < 0.01)
  assert.ok(size.width * size.height <= 2048 * 2048)
  assert.equal(size.width % 16, 0)
  assert.equal(size.height % 16, 0)
  assert.equal('aspect_ratio' in actual, false)
  assert.equal('resolution' in actual, false)
})

test('Nano Banana 2 сохраняет нативные aspect_ratio и resolution', () => {
  assert.deepEqual(
    prepareImageParams(
      model('nano-banana'),
      { aspect_ratio: '9:16', resolution: '2K', seed: 42 },
      [],
    ),
    { aspect_ratio: '9:16', resolution: '2K', seed: 42 },
  )
})

test('Nano Banana 2 фиксирует auto по пропорции первого референса', () => {
  assert.deepEqual(
    prepareImageParams(
      model('nano-banana-edit'),
      { aspect_ratio: 'auto', resolution: '2K', seed: 42 },
      [{ kind: 'image', src: '/media/source.png', width: 900, height: 1600 }],
    ),
    { aspect_ratio: '9:16', resolution: '2K', seed: 42 },
  )
})

test('неизвестная пропорция GPT не превращается молча в квадрат', () => {
  assert.throws(
    () => prepareImageParams(
      model('chatgpt-image-2'),
      { aspect_ratio: '7:5', quality: 'high' },
      [],
    ),
    /Unsupported GPT Image 2 aspect ratio.*7:5/i,
  )
})

test('runner делегирует image params адаптеру и не содержит общей needsImageSize ветки', () => {
  const source = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8')
  assert.match(source, /findEffectiveCatalogPreset\(CATALOG,\s*model\.endpoint,\s*job\.model\)/)
  assert.match(source, /prepareImageParams\(preset,\s*mergedParams,\s*prepared\.refs\)/)
  assert.doesNotMatch(source, /needsImageSize/)
})

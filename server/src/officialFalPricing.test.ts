import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CatalogLibrary } from './catalogLibrary.js'
import { CATALOG, type CatalogModel } from './catalog.js'
import { prepareFalModelSetup } from './falModelSetup.js'
import { withOfficialPricing } from './officialFalPricing.js'

// Nano Banana 2.1, подключённая через библиотеку моделей, хранила ОДНУ сумму
// «за вызов» ($0.08266, историческая оценка fal), а fal берёт по разрешению:
// $0.040 за 1K, $0.059 за 2K, $0.134 за 4K (страница модели, 20.10.2026).

const RESOLUTION = {
  name: 'resolution', label: 'Resolution', widget: 'select' as const, default: '1K',
  options: ['1K', '2K', '4K'].map((value) => ({ value, label: value })),
}

/** Ровно то, что лежит в библиотеке у пользователя (server/data/catalog-library.json). */
function storedNano(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'user-google-nano-banana-2-1',
    name: 'Nano Banana 2.1',
    kind: 'image',
    endpoint: 'google/nano-banana-2.1',
    params: [RESOLUTION, { name: 'num_images', label: 'Number of images', widget: 'slider', default: 1, min: 1, max: 1, step: 1 }],
    pricing: { unit: 'call', usd: 0.08266 },
    pricingNote: 'Fal historical estimate for one call (0.08266 USD); usage depends on parameters and tokens.',
    ...overrides,
  }
}

test('подключённая Nano Banana 2.1 показывает цену по ступеням разрешения, а не одну сумму', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-official-price-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const file = path.join(dir, 'catalog-library.json')
  const state = {
    schemaVersion: 2, revision: 7, lifecycle: {}, drafts: [], draftMeta: {},
    defaults: { image: 'chatgpt-image-2', video: 'seedance-2', audio: 'sam-audio-separate', assistant: 'gemini' },
    extensions: [storedNano()],
  }
  await fs.writeFile(file, JSON.stringify(state, null, 2))
  const library = new CatalogLibrary(file, CATALOG)
  await library.load()
  const model = library.models().find((item) => item.id === 'user-google-nano-banana-2-1')
  assert.ok(model)
  assert.deepEqual(model.pricing, {
    unit: 'image', usd: 0.04, byParam: { name: 'resolution', usd: { '1K': 0.04, '2K': 0.059, '4K': 0.134 } },
  })
  assert.match(model.pricingNote ?? '', /1K \$0\.040, 2K \$0\.059, 4K \$0\.134/u)
  // файл человека не переписан: его держит работающее приложение
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), state)
})

test('цену, вписанную человеком, и чужие ручки таблица не трогает', () => {
  const manual = storedNano({ pricing: { unit: 'image', usd: 0.05 } })
  assert.equal(withOfficialPricing(manual), manual)
  const other = storedNano({ endpoint: 'vendor/other-model' })
  assert.equal(withOfficialPricing(other), other)
  const edit = withOfficialPricing(storedNano({ endpoint: 'google/nano-banana-2.1/edit' }))
  assert.equal(edit.pricing?.perReferenceUsd, 0.002)
  assert.equal(edit.pricing?.byParam?.usd['4K'], 0.134)
})

test('мастер подключения берёт официальную таблицу и для базовой Nano Banana 2.1, раньше плоской цены API', async () => {
  const html = '<table><tr><th>Output resolution</th><th>Text-to-image</th><th>Edit with two 1K input images</th></tr>'
    + '<tr><td>1K</td><td>$0.040</td><td>$0.044</td></tr>'
    + '<tr><td>2K</td><td>$0.059</td><td>$0.063</td></tr>'
    + '<tr><td>4K</td><td>$0.134</td><td>$0.138</td></tr></table>'
  const calls: string[] = []
  const result = await prepareFalModelSetup(storedNano({ pricing: undefined }), {
    falKey: 'test-key',
    buildSamples: async () => ({ input: { prompt: 'кот', refs: [], params: {} }, samples: [] }),
    fetcher: async (url) => {
      calls.push(String(url))
      if (String(url).startsWith('https://fal.ai/models/')) {
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      // плоская цена API: ступеней разрешения в ней нет
      return new Response(JSON.stringify({ prices: [{ endpoint_id: 'google/nano-banana-2.1', unit_price: 0.083, unit: 'image', currency: 'USD' }] }))
    },
  })
  assert.equal(calls[0], 'https://fal.ai/models/google/nano-banana-2.1')
  assert.deepEqual(result.persist?.pricing?.byParam?.usd, { '1K': 0.04, '2K': 0.059, '4K': 0.134 })
})

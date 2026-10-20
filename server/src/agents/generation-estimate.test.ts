import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentArtifact } from '../../../packages/agent-protocol/index.js'
import { CATALOG, type CatalogModel } from '../../../packages/model-catalog/catalog.js'
import { estimateGenerationCost } from '../../../client/src/spaces/canvas/generationEstimate.js'
import type { CatalogModel as ClientCatalogModel } from '../../../client/src/types.js'
import { estimateMicros } from './generation-broker-helpers.js'

// Сторожа агентской оценки цены. Она отстала от кнопки «Создать» на три
// починки: прибавляла ступень к базовой цене вместо подстановки, склеивала
// ключ таблицы через «:», не знала `durationParam`, длительности строкой и
// значений по умолчанию, а новые виды цены (за знаки текста, за мегапиксель
// результата) не считала вовсе. Теперь правило общее (mediaCost.ts), а здесь
// закреплено, что агент получает ту же сумму, что видит человек.

function model(id: string): CatalogModel {
  const found = CATALOG.find((candidate) => candidate.id === id)
  assert.ok(found, `model ${id} is in the catalog`)
  return found
}

function image(width?: number, height?: number): AgentArtifact {
  return {
    artifactId: `image-${width ?? 0}x${height ?? 0}`,
    revision: 1,
    checksum: 'a'.repeat(64),
    kind: 'image',
    caption: 'reference',
    mimeType: 'image/png',
    sizeBytes: 1,
    mediaSrc: '/media/reference.png',
    provenance: 'reference',
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  }
}

const costInvalid = (error: unknown) => (error as { code?: string }).code === 'GENERATION_COST_INVALID'

test('ступень цены подставляется вместо базовой, а не прибавляется к ней', () => {
  // Nano Banana Pro 4K стоит $0.30, а не 0.15 + 0.30.
  assert.equal(estimateMicros(model('nano-banana-pro'), { resolution: '4K' }, []), 300_000)
  assert.equal(estimateMicros(model('nano-banana-pro'), { resolution: '2K' }, []), 150_000)
  // Seedream 1K дешевле базовой: подстановка, а не «база + ступень».
  assert.equal(estimateMicros(model('seedream-5-pro'), { resolution: '1K' }, []), 67_500)
})

test('таблица по нескольким ручкам ищется по ключу через «|» и по умолчаниям формы', () => {
  const gpt = model('chatgpt-image-2')
  const table = gpt.pricing!.byParams!.usd
  const params = { aspect_ratio: '16:9', resolution: '2K', quality: 'medium' }
  assert.equal(estimateMicros(gpt, params, []), Math.ceil(table['16:9|2K|medium']! * 1_000_000))
  // Не выбранное берётся из умолчаний формы (4:3, 1K) — как на кнопке.
  assert.equal(estimateMicros(gpt, { quality: 'low' }, []), Math.ceil(table['4:3|1K|low']! * 1_000_000))
})

test('посекундная цена — по своей ручке длительности, строке или умолчанию формы', () => {
  // Звуковые эффекты: ручка duration_seconds, а не duration.
  assert.equal(estimateMicros(model('eleven-sfx'), { duration_seconds: 5 }, []), 10_000)
  // Не выбрано — умолчание формы (4 с), а не запасные 22 с.
  assert.equal(estimateMicros(model('eleven-sfx'), {}, []), 8_000)
  // Seedance держит длительность строкой «4»…«15».
  const seedance = estimateMicros(model('seedance-2'), { resolution: '1080p', duration: '15' }, [])
  assert.ok(Math.abs(seedance - 0.682 * 15 * 1_000_000) <= 1, `Seedance 1080p × 15 s, got ${seedance}`)
  // Grok Video без выбора — умолчание формы (6 с), а не одна секунда.
  assert.ok(Math.abs(estimateMicros(model('grok'), {}, []) - 0.07 * 6 * 1_000_000) <= 1)
  // У модели вовсе без ручки длительности — типичные 8 с, а не одна секунда.
  assert.equal(estimateMicros(model('veo-omni-video-edit'), {}, []), 1_000_000)
})

test('озвучка — за каждые 1000 знаков промпта; без промпта цены нет', () => {
  const tts = model('eleven-tts')
  assert.equal(estimateMicros(tts, {}, [], 'x'.repeat(2_500)), 150_000)
  assert.equal(estimateMicros(tts, {}, [], 'x'.repeat(1_000)), 50_000)
  assert.equal(estimateMicros(tts, {}, [], 'короткая фраза'), 50_000)
  // Грант Creator считает до промпта: угадывать нельзя — отказ словами.
  assert.throws(() => estimateMicros(tts, {}, []), costInvalid)
})

test('апскейл — за мегапиксель результата по размеру входа; без размера цены нет', () => {
  const seedvr = model('seedvr-seamless-upscale')
  // ×2 по умолчанию: 2000×1000 → 4000×2000 = 8 Мп × $0.0025.
  assert.equal(estimateMicros(seedvr, {}, [image(2000, 1000)]), 20_000)
  // Считается по самой крупной картинке.
  assert.equal(estimateMicros(seedvr, {}, [image(100, 100), image(2000, 1000)]), 20_000)
  assert.throws(() => estimateMicros(seedvr, {}, [image()]), costInvalid)
})

// Инвариант Creator: он отдаёт в ревью оценку гранта, посчитанную без
// промпта, а запрос пересчитывает её с промптом и сверяет на равенство.
test('оценка без промпта равна оценке с промптом у всех моделей, кроме цены за знаки', () => {
  for (const candidate of CATALOG) {
    if (!candidate.pricing || candidate.pricing.perPromptChars != null || candidate.pricing.perOutputMegapixel != null) continue
    assert.equal(
      estimateMicros(candidate, {}, []),
      estimateMicros(candidate, {}, [], 'a long prompt that must not change the price'.repeat(40)),
      candidate.id,
    )
  }
})

// Окно запуска агента показывает цену клиентской оценкой (agentGenerationModel),
// а резерв делает сервер. Это одна и та же сумма — до микродоллара вверх.
test('агентская оценка совпадает с кнопкой «Создать» на каждой модели и ступени', () => {
  const prompt = 'x'.repeat(1_234)
  let checked = 0
  for (const candidate of CATALOG) {
    if (!candidate.pricing) continue
    const refs = candidate.pricing.perOutputMegapixel != null ? [image(1536, 1024)] : []
    const inputs = { promptChars: prompt.length, inputImage: { width: 1536, height: 1024 } }
    const priced = new Set([
      candidate.pricing.byParam?.name,
      ...(candidate.pricing.byParams?.names ?? []),
      candidate.pricing.durationParam ?? 'duration',
    ])
    const variants: Array<Record<string, unknown>> = [{}]
    for (const spec of candidate.params ?? []) {
      if (!priced.has(spec.name)) continue
      for (const option of spec.options ?? []) variants.push({ [spec.name]: option.value })
      if (spec.widget === 'slider' && typeof spec.max === 'number') variants.push({ [spec.name]: spec.max })
    }
    for (const params of variants) {
      const button = estimateGenerationCost({ ...candidate, refs: Boolean(candidate.refs) } as ClientCatalogModel, params, 1, refs.length, inputs)
      if (button == null) continue
      const agent = estimateMicros(candidate, params, refs, prompt)
      const label = `${candidate.id} ${JSON.stringify(params)}`
      assert.ok(agent >= button * 1_000_000 - 1e-6, `${label}: agent ${agent} below button ${button}`)
      assert.ok(agent - button * 1_000_000 <= 1, `${label}: agent ${agent} above button ${button}`)
      checked += 1
    }
  }
  assert.ok(checked > 60, `checked ${checked} price points`)
})

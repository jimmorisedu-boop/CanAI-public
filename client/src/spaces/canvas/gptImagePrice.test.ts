import assert from 'node:assert/strict'
import test from 'node:test'
import { CATALOG } from '../../../../packages/model-catalog/catalog'
import {
  GPT_IMAGE_2_QUALITY,
  GPT_IMAGE_25_QUALITY,
  GPT_IMAGE_INPUT_IMAGE_USD,
  gptImageFrame,
  gptImageOutputUsd,
} from '../../../../packages/model-catalog/gptImagePricing'
import { prepareImageParams, type IncomingRef } from '../../../../packages/model-catalog/imageParams'
import type { CatalogModel } from '../../types'
import { estimateGenerationCost } from './generationEstimate'

// ⚠️ Цена GPT Image на своей доске — это кнопка (estimateGenerationCost), и
// она же решает, спросить ли подтверждение. Считать её надо по тому кадру,
// который переводчик РЕАЛЬНО отдаёт fal, а не по строкам таблицы fal: там 2K и
// 4K — одна строка 2560×1440 и 3840×2160, а мы шлём 2048 по длинной стороне и
// до 8 294 400 точек (квадрат 2K — $0.43 против строки $0.222, квадрат 4K —
// $0.71 против $0.401), пресет 16:9 — 1088×608, а не 1920×1080.

const roundMicros = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000

function model(id: string): CatalogModel {
  const found = CATALOG.find((entry) => entry.id === id)
  assert.ok(found, `нет модели ${id}`)
  return found as unknown as CatalogModel
}

function options(current: CatalogModel, name: string): string[] {
  const values = current.params.find((param) => param.name === name)?.options?.map((option) => option.value)
  assert.ok(values?.length, `${current.id}: нет списка ${name}`)
  return values
}

/** Цена кадра, который переводчик отдаёт fal при этих ручках и референсе. */
function frameUsd(current: CatalogModel, params: Record<string, unknown>, refs: IncomingRef[], multiplier: number): number {
  const sent = prepareImageParams(current as never, params, refs)
  const [width, height] = gptImageFrame(sent.image_size as string | { width: number; height: number })
  return gptImageOutputUsd(width, height, multiplier)
}

const FAMILIES = [
  { base: 'chatgpt-image-2', edit: 'chatgpt-image-2-edit', qualities: GPT_IMAGE_2_QUALITY },
  { base: 'gpt-image-2.5-flare', edit: 'gpt-image-2.5-flare-edit', qualities: GPT_IMAGE_25_QUALITY },
  { base: 'gpt-image-2.5-sunburst', edit: 'gpt-image-2.5-sunburst-edit', qualities: GPT_IMAGE_25_QUALITY },
]

/** Пропорции референса: от крайних 1:3 и 3:1 до квадрата. */
const REF_SHAPES: Array<[number, number]> = [[1000, 3000], [1080, 1920], [3000, 4000], [2000, 2000], [4000, 3000], [1920, 1080], [3000, 1000]]

test('формула токенов повторяет счёт fal за GPT Image 2 (журнал ключа команды, high)', () => {
  // Разница в десятые доли цента — токены текста промпта.
  for (const [width, height, billed] of [
    [1088, 608, 0.1045], [1024, 768, 0.1448], [1024, 1024, 0.2108], [2048, 1536, 0.2669], [2880, 2880, 0.7117],
  ] as const) {
    const usd = gptImageOutputUsd(width, height, GPT_IMAGE_2_QUALITY.high!)
    assert.ok(Math.abs(usd - billed) < 0.0015, `${width}×${height}: формула ${usd}, fal взял ${billed}`)
  }
})

test('формула повторяет таблицу fal у GPT Image 2.5 во всех 30 клетках — множители 16/24/48/64/96', () => {
  // Таблица со страниц моделей fal (21.09.2026): это та же формула, но для
  // шести кадров fal, а не для наших.
  const table: Record<string, number[]> = {
    '1024x768': [0.00402, 0.00903, 0.03612, 0.0642, 0.14445],
    '1024x1024': [0.00588, 0.01317, 0.05268, 0.09366, 0.21072],
    '1024x1536': [0.00474, 0.01029, 0.04116, 0.07377, 0.16464],
    '1920x1080': [0.00441, 0.01029, 0.0396, 0.07041, 0.1584],
    '2560x1440': [0.00615, 0.01434, 0.05529, 0.09828, 0.2211],
    '3840x2160': [0.01113, 0.02595, 0.10008, 0.1779, 0.40026],
  }
  for (const [size, row] of Object.entries(table)) {
    const [width, height] = size.split('x').map(Number) as [number, number]
    ;(['low', 'medium', 'high', 'xhigh', 'max'] as const).forEach((quality, index) => {
      assert.equal(roundMicros(gptImageOutputUsd(width, height, GPT_IMAGE_25_QUALITY[quality]!)), row[index], `${size} ${quality}`)
    })
  }
  assert.equal(GPT_IMAGE_25_QUALITY.auto, GPT_IMAGE_25_QUALITY.high, '«авто» у качества — умолчание fal, high')
})

test('формула повторяет списания GPT Image 2.5 на сервере команды (jobs.cost_usd, 20.10.2026)', () => {
  // Создание: разница — только текст промпта.
  for (const [width, height, quality, billed] of [
    [1024, 768, 'high', 0.0366], [2048, 1152, 'medium', 0.0111], [2048, 1152, 'xhigh', 0.0754], [3840, 2160, 'xhigh', 0.1781],
  ] as const) {
    const usd = gptImageOutputUsd(width, height, GPT_IMAGE_25_QUALITY[quality]!)
    assert.ok(billed - usd >= 0 && billed - usd < 0.0015, `${width}×${height} ${quality}: формула ${usd}, fal взял ${billed}`)
  }
  // Правка с одной картинкой: входная картинка добавила ~$0.012 — её в
  // таблице fal нет, и цена правки обязана её учитывать.
  for (const [width, height, quality, billed] of [
    [2048, 2048, 'max', 0.4406], [1024, 768, 'max', 0.1563], [3840, 2160, 'high', 0.1123], [608, 1088, 'medium', 0.0185],
  ] as const) {
    const estimate = gptImageOutputUsd(width, height, GPT_IMAGE_25_QUALITY[quality]!) + GPT_IMAGE_INPUT_IMAGE_USD
    assert.ok(Math.abs(estimate - billed) < 0.0015, `${width}×${height} ${quality}: оценка ${estimate}, fal взял ${billed}`)
  }
})

test('кнопка создания равна цене кадра, который уходит в fal, на каждом сочетании формы', () => {
  for (const family of FAMILIES) {
    const base = model(family.base)
    for (const aspect of options(base, 'aspect_ratio')) {
      for (const resolution of options(base, 'resolution')) {
        for (const quality of options(base, 'quality')) {
          const params = { aspect_ratio: aspect, resolution, quality }
          const expected = roundMicros(frameUsd(base, params, [], family.qualities[quality]!))
          assert.equal(estimateGenerationCost(base, params, 1, 0), expected, `${base.id} ${aspect}|${resolution}|${quality}`)
          assert.equal(estimateGenerationCost(base, params, 3, 0), roundMicros(expected * 3), `${base.id}: три варианта`)
        }
      }
    }
  }
})

test('кнопка правки равна цене кадра плюс входные картинки; «авто» — по самому дорогому референсу', () => {
  for (const family of FAMILIES) {
    const edit = model(family.edit)
    for (const aspect of options(edit, 'aspect_ratio')) {
      for (const resolution of options(edit, 'resolution')) {
        for (const quality of options(edit, 'quality')) {
          const params = { aspect_ratio: aspect, resolution, quality }
          const multiplier = family.qualities[quality]!
          const label = `${edit.id} ${aspect}|${resolution}|${quality}`
          const shown = estimateGenerationCost(edit, params, 1, 1)!
          // Кадр при каждом возможном референсе: у явных пропорций он один и
          // тот же, у «авто» на 2K/4K — по пропорциям картинки.
          const sent = REF_SHAPES.map(([width, height]) => roundMicros(
            frameUsd(edit, params, [{ kind: 'image', width, height }], multiplier) + GPT_IMAGE_INPUT_IMAGE_USD,
          ))
          assert.ok(sent.every((usd) => usd <= shown), `${label}: кнопка ${shown} занижает ${Math.max(...sent)}`)
          assert.equal(shown, Math.max(...sent), `${label}: кнопка не равна худшему кадру`)
          if (aspect !== 'auto') assert.ok(sent.every((usd) => usd === shown), `${label}: явные пропорции — один кадр`)
          // Каждая следующая картинка — её входные токены.
          assert.equal(
            estimateGenerationCost(edit, params, 1, 3),
            roundMicros(shown + 2 * GPT_IMAGE_INPUT_IMAGE_USD),
            `${label}: три референса`,
          )
        }
      }
    }
  }
})

test('2K и 4K — не одна строка: цена зависит от пропорций', () => {
  const base = model('chatgpt-image-2')
  const at = (aspect: string, resolution: string) => estimateGenerationCost(base, { aspect_ratio: aspect, resolution, quality: 'high' }, 1)
  assert.equal(at('1:1', '2K'), 0.42816, 'квадрат 2048×2048')
  assert.equal(at('4:3', '2K'), 0.26676, '2048×1536')
  assert.equal(at('1:1', '4K'), 0.71157, 'квадрат 2880×2880')
  assert.equal(at('16:9', '4K'), 0.40026, '3840×2160')
  assert.equal(at('16:9', '1K'), 0.1035, 'пресет fal 1088×608, а не 1920×1080')
  assert.equal(at('3:4', '1K'), 0.14445, 'пресет fal 768×1024, а не 1024×1536')
})

test('запасная цена и лестница качества равны клеткам умолчаний формы', () => {
  for (const family of FAMILIES) {
    const base = model(family.base)
    const edit = model(family.edit)
    assert.equal(base.pricing?.usd, estimateGenerationCost(base, {}, 1, 0), `${base.id}: умолчания 4:3|1K|high`)
    assert.equal(edit.pricing?.usd, estimateGenerationCost(edit, {}, 1, 1), `${edit.id}: умолчания auto|1K|high`)
    assert.equal(edit.pricing?.additionalReferenceUsd, GPT_IMAGE_INPUT_IMAGE_USD)
  }
  const base = model('chatgpt-image-2')
  for (const quality of ['low', 'medium', 'high']) {
    assert.equal(base.pricing?.byParam?.usd[quality], estimateGenerationCost(base, { quality }, 1, 0), `лестница ${quality}`)
  }
})

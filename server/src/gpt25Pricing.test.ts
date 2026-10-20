import assert from 'node:assert/strict'
import test from 'node:test'
import { CATALOG, GPT_25_EDIT_PRICES, GPT_25_EXTRA_REFERENCE_USD, GPT_25_PRICES } from './catalog.js'

// ⚠️ Оценка GPT Image 2.5 считается по КАДРУ, который уходит в fal
// (packages/model-catalog/gptImagePricing.ts), формулой токенов OpenAI с
// множителями 16/24/48/64/96. Таблица fal на странице модели — та же формула,
// но для шести её кадров; прежний тест закреплял её строки (2K = 2560×1440,
// 16:9 = 1920×1080), хотя мы шлём другие кадры, — ровно тот случай, когда тест
// защищает ошибку. Полная сверка «кнопка = кадр» — в
// client/src/spaces/canvas/gptImagePrice.test.ts.

test('клетки — цена кадров переводчика, а не строк таблицы fal', () => {
  // 1K — пресеты fal: квадрат 1024², 4:3 — 1024×768 (совпадают с таблицей fal).
  assert.equal(GPT_25_PRICES['1:1|1K|low'], 0.00588)
  assert.equal(GPT_25_PRICES['1:1|1K|high'], 0.05268, 'совпало с фактическим списанием $0.0527 на сервере команды')
  assert.equal(GPT_25_PRICES['1:1|1K|max'], 0.21072)
  assert.equal(GPT_25_PRICES['4:3|1K|max'], 0.14445, '4:3 → 1024×768')
  // 3:4 и 9:16 — пресеты 768×1024 и 608×1088, а не строка 1024×1536.
  assert.equal(GPT_25_PRICES['3:4|1K|max'], 0.14445, '3:4 → 768×1024')
  assert.equal(GPT_25_PRICES['9:16|1K|max'], 0.1035, '9:16 → 608×1088')
  assert.equal(GPT_25_PRICES['16:9|1K|max'], 0.1035, '16:9 → 1088×608, а не 1920×1080')
  // 2K — 2048 по длинной стороне: квадрат вдвое дороже строки «2K» fal.
  assert.equal(GPT_25_PRICES['1:1|2K|max'], 0.42816, '2K квадрат → 2048×2048')
  assert.equal(GPT_25_PRICES['16:9|2K|medium'], 0.01101, '2K 16:9 → 2048×1152, списано $0.0111')
  // 4K — не больше 8 294 400 точек: квадрат 2880², 16:9 — 3840×2160.
  assert.equal(GPT_25_PRICES['1:1|4K|max'], 0.71157, '4K квадрат → 2880×2880')
  assert.equal(GPT_25_PRICES['16:9|4K|xhigh'], 0.1779, '4K 16:9 → 3840×2160, списано $0.1781')
})

test('«авто» у качества — умолчание fal (high), «авто» без размера — кадр 1440²', () => {
  assert.equal(GPT_25_PRICES['1:1|1K|auto'], GPT_25_PRICES['1:1|1K|high'])
  assert.equal(GPT_25_PRICES['auto|1K|max'], 0.28158)
})

test('правка: в клетке одна входная картинка — её в таблице fal нет, а fal за неё берёт', () => {
  // По журналу сервера команды каждая входная картинка добавляла ~$0.012.
  for (const key of ['1:1|1K|high', '16:9|2K|medium', '9:16|4K|xhigh']) {
    assert.equal(GPT_25_EDIT_PRICES[key], Math.round((GPT_25_PRICES[key]! + GPT_25_EXTRA_REFERENCE_USD) * 1e6) / 1e6, key)
  }
  // «Авто» у пропорций на 2K/4K берёт пропорции референса — клетка по квадрату.
  assert.equal(GPT_25_EDIT_PRICES['auto|2K|max'], GPT_25_EDIT_PRICES['1:1|2K|max'])
  assert.equal(GPT_25_EDIT_PRICES['auto|4K|max'], GPT_25_EDIT_PRICES['1:1|4K|max'])
})

test('у Flare и Sunburst — одна оценка; у правки своя таблица и доплата за картинки сверх первой', () => {
  for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-edit', 'gpt-image-2.5-sunburst-edit']) {
    const model = CATALOG.find((entry) => entry.id === id)
    const edit = id.endsWith('-edit')
    assert.ok(model?.pricing, `у ${id} есть оценка`)
    assert.deepEqual(model.pricing.byParams?.names, ['aspect_ratio', 'resolution', 'quality'])
    assert.equal(model.pricing.byParams?.usd, edit ? GPT_25_EDIT_PRICES : GPT_25_PRICES)
    // Умолчания: у создания 4:3, у правки «авто» — цена при них и есть запасная.
    assert.equal(model.pricing.usd, edit ? GPT_25_EDIT_PRICES['auto|1K|high'] : GPT_25_PRICES['4:3|1K|high'])
    assert.equal(model.pricing.additionalReferenceUsd, edit ? GPT_25_EXTRA_REFERENCE_USD : undefined)
    assert.ok(model.pricing.usd < 0.5, 'оценка, а не прежний резерв $2')
  }
})

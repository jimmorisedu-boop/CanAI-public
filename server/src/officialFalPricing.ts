import { normalizeEndpoint, type CatalogModel, type MediaPricing } from './catalog.js'

// Официальные таблицы fal для подключённых моделей с оплатой по токенам.
//
// ⚠️ У таких моделей fal не отдаёт цены «за картинку»: мастер подключения брал
// историческую оценку ОДНОЙ суммой на вызов (у Nano Banana 2.1 — $0.083), а
// fal берёт по разрешению — $0.040 за 1K, $0.059 за 2K и $0.134 за 4K (страница
// модели, сверено 20.10.2026; то же, что разбирает `parseNanoTable` в
// falModelSetup). Одна сумма завышала 1K вдвое и занижала 4K в полтора раза.
//
// Таблица накладывается на уже подключённую модель при чтении библиотеки, а не
// переписывает файл пользователя: файл держит работающее приложение. И только
// поверх оценки «за вызов» — цену, которую человек вписал сам, не трогаем.

const NANO_BANANA_21_BY_RESOLUTION = { '1K': 0.04, '2K': 0.059, '4K': 0.134 }

const NANO_BANANA_21_NOTE = 'Price from the official fal table: 1K $0.040, 2K $0.059, 4K $0.134 per image '
  + 'with a short prompt and medium thinking. fal bills by tokens: high thinking, long prompts and web search cost more.'

const OFFICIAL: Record<string, { pricing: MediaPricing; pricingNote: string }> = {
  'google/nano-banana-2.1': {
    pricing: { unit: 'image', usd: 0.04, byParam: { name: 'resolution', usd: NANO_BANANA_21_BY_RESOLUTION } },
    pricingNote: NANO_BANANA_21_NOTE,
  },
  'google/nano-banana-2.1/edit': {
    // каждая входная картинка — около 1120 токенов, ≈ $0.002
    pricing: { unit: 'image', usd: 0.04, perReferenceUsd: 0.002, byParam: { name: 'resolution', usd: NANO_BANANA_21_BY_RESOLUTION } },
    pricingNote: `${NANO_BANANA_21_NOTE} Each input image adds about $0.002.`,
  },
}

/** У ручки есть официальная таблица цен на странице модели fal. */
export function hasOfficialFalTable(endpoint: string): boolean {
  return Object.hasOwn(OFFICIAL, normalizeEndpoint(endpoint))
}

/** Подключённая модель с официальной ценой fal вместо оценки «за вызов». */
export function withOfficialPricing(model: CatalogModel): CatalogModel {
  const official = Object.hasOwn(OFFICIAL, normalizeEndpoint(model.endpoint))
    ? OFFICIAL[normalizeEndpoint(model.endpoint)]
    : undefined
  if (!official) return model
  if (model.pricing && model.pricing.unit !== 'call') return model
  const resolution = (model.params ?? []).find((param) => param.name === 'resolution')
  if (!resolution) return model
  return { ...model, pricing: structuredClone(official.pricing), pricingNote: official.pricingNote }
}

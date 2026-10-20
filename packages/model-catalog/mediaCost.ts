/**
 * Цена ОДНОГО запуска медиамодели по прайсу каталога, в долларах, без
 * округления. Правило одно на два места: кнопка «Создать» и подтверждения
 * своей доски (`client/src/spaces/canvas/generationEstimate.ts`) и оценка
 * агентской генерации (`server/src/agents/generation-broker-helpers.ts`).
 *
 * ⚠️ Двумя копиями оно уже жило: агентская отстала от кнопки на три починки
 * подряд — прибавляла цену ступени к базовой вместо подстановки (Nano Banana
 * Pro 4K: 0.15 + 0.3 вместо 0.3), склеивала ключ таблицы через «:», а не «|»,
 * не брала значения по умолчанию, не знала `durationParam` и новых видов цены.
 *
 * Не знаем того, от чего зависит цена (длина текста, размер входной картинки,
 * длительность), — null, а не догадка: занизить хуже, чем завысить.
 */

/** Только поля прайса, которые читает расчёт: подходит и каталогу, и клиенту. */
export interface MediaCostPricing {
  unit: string
  usd: number
  defaultDuration?: number
  durationParam?: string
  perPromptChars?: number
  perOutputMegapixel?: number
  perReferenceUsd?: number
  additionalReferenceUsd?: number
  byParam?: { name: string; usd: Record<string, number> }
  byParams?: { names: string[]; usd: Record<string, number> }
  /** Цена запуска целиком — у посекундных моделей сетевой доски (только клиент). */
  perLaunch?: { names: string[]; usd: Record<string, number> }
}

export interface MediaCostModel {
  pricing?: MediaCostPricing
  params?: ReadonlyArray<{ name: string; default?: unknown }>
}

/**
 * То, что знает только место запуска. Цена некоторых моделей зависит не от
 * ручек, а от входа: озвучка — от длины текста, апскейл — от размера картинки.
 */
export interface CostInputs {
  /** Сколько знаков текста уйдёт модели (промпт вместе с текстовыми референсами). */
  promptChars?: number
  /** Натуральный размер входной картинки, пиксели. */
  inputImage?: { width: number; height: number }
}

export function mediaLaunchUsd(
  model: MediaCostModel | null | undefined,
  params: Record<string, unknown>,
  referenceCount = 0,
  inputs: CostInputs = {},
): number | null {
  const pricing = model?.pricing
  if (!model || !pricing) return null
  const extraReferences = Math.max(0, referenceCount - 1)
  const referenceUsd = referenceCount * (pricing.perReferenceUsd ?? 0)
    + extraReferences * (pricing.additionalReferenceUsd ?? 0)
  // Цена запуска целиком от сервера команды: она уже за весь ролик, и на
  // секунды её не множим. Ставка за секунду там округлена вверх до цента, и
  // «ставка × секунды» расходилась с котировкой (см. cloudCatalogModel).
  const launchUsd = tableRate(model, pricing.perLaunch, params)
  if (launchUsd != null) return launchUsd + referenceUsd

  const perMegapixel = pricing.perOutputMegapixel
  if (perMegapixel != null) {
    const megapixels = upscaledMegapixels(model, params, inputs.inputImage)
    if (megapixels == null) return null
    return perMegapixel * megapixels + referenceUsd
  }
  const perChars = pricing.perPromptChars
  if (perChars != null) {
    if (inputs.promptChars == null || !Number.isFinite(inputs.promptChars)) return null
    const blocks = Math.max(1, Math.ceil(inputs.promptChars / perChars))
    return pricing.usd * blocks + referenceUsd
  }

  // Ступень ПОДСТАВЛЯЕТСЯ вместо базовой цены, а не прибавляется к ней: `usd`
  // — это цена ступени по умолчанию, запасная на случай, когда строки нет.
  let baseUsd = pricing.usd
  const matrixRate = tableRate(model, pricing.byParams, params)
  if (matrixRate != null) {
    baseUsd = matrixRate
  } else if (pricing.byParam) {
    const rateTable = pricing.byParam
    const selected = params[rateTable.name] ?? specDefault(model, rateTable.name)
    const key = selected == null ? undefined : String(selected)
    if (key !== undefined && Object.hasOwn(rateTable.usd, key)) baseUsd = rateTable.usd[key]!
  }

  const units = pricing.unit === 'second' ? durationUnits(model, params) : 1
  if (!Number.isFinite(units) || units <= 0) return null
  return baseUsd * units + referenceUsd
}

function specDefault(model: MediaCostModel, name: string): unknown {
  return model.params?.find((param) => param.name === name)?.default
}

/**
 * Цена из таблицы по выбранным значениям параметров: ключ — значения `names`
 * через «|», невыбранное — по умолчанию формы. Нет такой строки — undefined.
 */
function tableRate(
  model: MediaCostModel,
  table: { names: string[]; usd: Record<string, number> } | undefined,
  params: Record<string, unknown>,
): number | undefined {
  if (!table?.names.length) return undefined
  const key = table.names
    .map((name) => String(params[name] ?? specDefault(model, name) ?? ''))
    .join('|')
  return Object.hasOwn(table.usd, key) ? table.usd[key] : undefined
}

// Длительность для посекундных моделей. Раньше при незаполненном params.duration
// бралась 1 секунда — оценка занижалась в разы (Seedance реально запускается с
// серверным дефолтом 7с), и порог подтверждения дорогих генераций не срабатывал.
// Берём значение из params (число или строка — у Seedance список строк «4»…«15»),
// иначе дефолт спека модели, иначе `defaultDuration`, иначе типичные 8 секунд
// (модель без ручки длительности, например видео-редактирование).
function durationUnits(model: MediaCostModel, params: Record<string, unknown>): number {
  const name = model.pricing?.durationParam ?? 'duration'
  for (const candidate of [params[name], specDefault(model, name)]) {
    const n = Number(candidate)
    if (Number.isFinite(n) && n > 0) return n
  }
  return model.pricing?.defaultDuration ?? 8
}

/**
 * Мегапиксели результата апскейла (ручки SeedVR, схема fal сверена 20.10.2026):
 * «×N» умножает каждую сторону входа на N; «до разрешения» ставит КОРОТКУЮ
 * сторону в целевые пиксели (1080p → 1080), пропорции — от входа. Короткая
 * сторона — осторожный выбор: меряй fal длинную, результат вышел бы меньше.
 * Размера входа нет — null: прежняя таблица «как у кадра 16:9» занижала цену
 * у крупной картинки в режиме «×2» в десятки раз.
 */
function upscaledMegapixels(
  model: MediaCostModel,
  params: Record<string, unknown>,
  input: CostInputs['inputImage'],
): number | null {
  if (!input || !(input.width > 0) || !(input.height > 0)) return null
  const value = (name: string) => params[name] ?? specDefault(model, name)
  if (value('upscale_mode') === 'target') {
    const target = Number.parseInt(String(value('target_resolution') ?? ''), 10)
    if (!Number.isFinite(target) || target <= 0) return null
    const ratio = Math.max(input.width, input.height) / Math.min(input.width, input.height)
    return (target * target * ratio) / 1_000_000
  }
  const factor = Number(value('upscale_factor'))
  if (!Number.isFinite(factor) || factor <= 0) return null
  return (input.width * factor * input.height * factor) / 1_000_000
}

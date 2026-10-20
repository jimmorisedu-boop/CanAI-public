import { gptImageSize } from './imageParams.js'

/**
 * Цена GPT Image (2 и 2.5) у fal — по кадру, который реально уходит в запрос.
 *
 * ⚠️ fal считает эти модели по ТОКЕНАМ OpenAI (выход $30 за миллион), а на
 * странице модели публикует таблицу из шести кадров: 1024×768, 1024², 1024×1536,
 * 1920×1080, 2560×1440, 3840×2160. Наш переводчик (`gptImageSize` в
 * imageParams.ts) шлёт ДРУГИЕ кадры: пресет 16:9 у fal — 1088×608, а не
 * 1920×1080; 3:4 — 768×1024, а не 1024×1536; на 2K/4K размер считается сам —
 * 2048 по длинной стороне и не больше 8 294 400 точек. Строкой таблицы их не
 * посчитать: квадрат 2048² стоит $0.43 против строки «2K» $0.222, квадрат 4K
 * (2880²) — $0.71 против $0.401. Поэтому цену считаем ФОРМУЛОЙ токенов от
 * кадра — калькулятор OpenAI для gpt-image-2 (тот же, что у сервера команды,
 * src/gptImage2Pricing.ts, PR #17 от 20.10.2026).
 *
 * Формула сверена со счётом fal:
 * - GPT Image 2, качество high (журнал ключа команды): 1088×608 $0.1045,
 *   1024×768 $0.1448, 1024² $0.2108, 2048×1536 $0.2669, 2880² $0.7117;
 * - GPT Image 2.5: таблица fal повторяется формулой во ВСЕХ 30 клетках, а
 *   списания задач сервера команды (jobs.cost_usd, 20.10.2026) — до десятой
 *   цента. Разница — текст промпта.
 *
 * ⚠️ Множители качества у моделей РАЗНЫЕ: у GPT Image 2 low/medium/high —
 * 16/48/96, у GPT Image 2.5 low/medium/high/xhigh/max — 16/24/48/64/96. То есть
 * «high» у 2.5 вдвое дешевле «high» у 2.
 *
 * ⚠️ Входная картинка правки в таблицу fal НЕ входит, хотя fal пишет обратное:
 * у GPT Image 2.5 таблица равна одной формуле выхода, а по журналу каждая
 * входная картинка добавляет $0.012–0.013 (одна, две, три, четыре — линейно).
 */

/** Множители качества формулы OpenAI у GPT Image 2. */
export const GPT_IMAGE_2_QUALITY: Readonly<Record<string, number>> = { low: 16, medium: 48, high: 96 }
/** Множители качества у GPT Image 2.5; «авто» — умолчание fal, то есть high. */
export const GPT_IMAGE_25_QUALITY: Readonly<Record<string, number>> = {
  low: 16, medium: 24, high: 48, xhigh: 64, max: 96, auto: 48,
}

/** Выходной токен у fal: $30 за миллион. */
const OUTPUT_USD_PER_MILLION_TOKENS = 30

/**
 * Каждая входная картинка правки — её токены у fal. По журналу $0.006–0.013,
 * обычно $0.012; берём верхнюю границу, как сервер команды.
 */
export const GPT_IMAGE_INPUT_IMAGE_USD = 0.013

/** Выходные токены кадра — калькулятор OpenAI для gpt-image-2. */
export function gptImageOutputTokens(width: number, height: number, quality: number): number {
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  // Короткая сторона идёт полосами: q × short / long, половина — вверх.
  const band = Math.floor((quality * short) / long + 0.5)
  const numerator = quality * band * (2_000_000 + width * height)
  // Целочисленный «вверх»: числа здесь меньше 2^53, а деление с плавающей
  // точкой на точной границе могло бы дать лишний токен.
  const tokens = Math.floor(numerator / 4_000_000)
  return tokens * 4_000_000 < numerator ? tokens + 1 : tokens
}

export function gptImageOutputUsd(width: number, height: number, quality: number): number {
  return (gptImageOutputTokens(width, height, quality) * OUTPUT_USD_PER_MILLION_TOKENS) / 1_000_000
}

/**
 * Кадры пресетов fal. Квадрат и 4:3 — из таблицы fal, 16:9 и 9:16 — размер
 * готовых картинок (1088×608 и 608×1088, задачи сервера команды).
 */
const PRESET_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  square_hd: [1024, 1024],
  landscape_4_3: [1024, 768],
  portrait_4_3: [768, 1024],
  landscape_16_9: [1088, 608],
  portrait_16_9: [608, 1088],
}

/**
 * «Авто» (`image_size: 'auto'`): размер выбирает модель, заранее его не знает
 * никто. Берём самый крупный кадр, который «авто» выдавало (1440², правка
 * GPT Image 2 03.09.2026) — то же число, что у сервера команды. Это оценка, а
 * не потолок: у GPT Image 2.5 «авто» с портретным референсом дало 1152×2016,
 * и оно дешевле квадрата.
 */
export const GPT_IMAGE_AUTO_SIZE: readonly [number, number] = [1440, 1440]

export function gptImageFrame(imageSize: string | { width: number; height: number }): readonly [number, number] {
  if (imageSize === 'auto') return GPT_IMAGE_AUTO_SIZE
  if (typeof imageSize === 'string') {
    const preset = PRESET_SIZES[imageSize]
    if (!preset) throw new Error(`No frame size for GPT Image preset: ${imageSize}`)
    return preset
  }
  return [imageSize.width, imageSize.height]
}

/**
 * Пропорции референса, по которым «авто» на 2K/4K считает кадр: переводчик
 * принимает от 1:3 до 3:1.
 */
const REF_ASPECTS = Array.from({ length: 49 }, (_, index) => 3 ** ((index - 24) / 24))

const roundMicros = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000

export interface GptImagePriceTableOptions {
  aspects: readonly string[]
  /** Ступени формы; «auto» у разрешения — прежнее значение старых досок, это 1K. */
  resolutions: readonly string[]
  qualities: Readonly<Record<string, number>>
  /**
   * Правка по референсу: в клетке одна входная картинка, а «авто» у пропорций
   * на 2K/4K берёт пропорции референса — клетка по самому дорогому из них
   * (квадрату): картинки при расчёте цены ещё нет.
   */
  withInputImage: boolean
}

/** Таблица «пропорции|разрешение|качество» → доллары за картинку. */
export function gptImagePriceTable(options: GptImagePriceTableOptions): Record<string, number> {
  const table: Record<string, number> = {}
  for (const aspect of options.aspects) {
    for (const resolution of options.resolutions) {
      const refAspects = options.withInputImage && aspect === 'auto' ? [null, ...REF_ASPECTS] : [null]
      const frames = refAspects.map((refAspect) => gptImageFrame(gptImageSize(aspect, resolution, refAspect)))
      for (const [quality, multiplier] of Object.entries(options.qualities)) {
        const output = Math.max(...frames.map(([width, height]) => gptImageOutputUsd(width, height, multiplier)))
        table[`${aspect}|${resolution}|${quality}`] = roundMicros(
          output + (options.withInputImage ? GPT_IMAGE_INPUT_IMAGE_USD : 0),
        )
      }
    }
  }
  return table
}

// Пики звуковой волны для плашки на холсте. Считает СЕРВЕР один раз, а не
// браузер при каждом открытии доски: декодировать весь файл ради картинки
// высотой 34 пикселя — это десятки мегабайт в памяти вкладки на каждую
// дорожку. Наружу уходит короткий массив маленьких чисел, который спокойно
// живёт в project.json рядом со ссылкой.

/** Столбиков в волне. 128 хватает: на плашке шириной 320 это столбик на
 *  два-три пикселя, мельче глаз не различает, а строка в проекте короткая. */
export const PEAK_COUNT = 128

/**
 * Из сырого PCM (моно, 16 бит, little-endian) — высоты столбиков 0..100.
 *
 * Нормируем по САМОМУ громкому месту дорожки, а не по абсолютному максимуму
 * формата: тихо записанный голос иначе превратился бы в ровную полоску у
 * нижнего края, и волна перестала бы что-либо показывать.
 */
export function peaksFromPcm(pcm: Buffer, count: number = PEAK_COUNT): number[] {
  const samples = Math.floor(pcm.length / 2)
  if (samples === 0 || count <= 0) return []

  const buckets = Math.min(count, samples)
  const highest = new Array<number>(buckets).fill(0)
  let loudest = 0

  for (let index = 0; index < samples; index++) {
    const value = Math.abs(pcm.readInt16LE(index * 2))
    const bucket = Math.min(buckets - 1, Math.floor((index * buckets) / samples))
    if (value > highest[bucket]) highest[bucket] = value
    if (value > loudest) loudest = value
  }

  // Полная тишина: нормировать не на что, и делить на ноль незачем.
  if (loudest === 0) return highest
  return highest.map((value) => Math.round((value / loudest) * 100))
}

/** Пустая или бессмысленная волна — плашке лучше показать ровную линию, чем
 *  случайный мусор. Отдельная проверка нужна перед записью в проект. */
export function isUsefulPeaks(peaks: readonly number[]): boolean {
  return peaks.length > 0 && peaks.some((value) => value > 0)
}

/** Проверка приходящего с клиента массива: в проект пускаем только короткий
 *  список целых 0..100 — всё остальное раздувает доску или врёт о себе. */
export function sanitizePeaks(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PEAK_COUNT) return undefined
  const out: number[] = []
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    out.push(Math.max(0, Math.min(100, Math.round(value))))
  }
  return out
}

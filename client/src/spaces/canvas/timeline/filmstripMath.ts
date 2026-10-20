// Чистая арифметика фильмштриха: сколько ячеек, из какого времени каждая, в
// каком порядке снимать и как вписать кадр в ячейку. Браузера не нужно — всё
// проверяется в useFilmstrip.test.ts. Съёмка — filmstripJob.ts, хук —
// useFilmstrip.ts.

export const FILMSTRIP_MIN_CELLS = 6
export const FILMSTRIP_MAX_CELLS = 40
/** Высота одной ячейки в пикселях файла: хватает дорожке, а JPEG весит копейки. */
export const FILMSTRIP_CELL_HEIGHT = 76
export const FILMSTRIP_DEFAULT_ASPECT = 16 / 9

export function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

/**
 * Сколько ячеек с пропорцией кадра помещается в дорожку по ширине. Нулевой или
 * непонятный размер — 0 (мерить пока нечего), иначе зажато в 6…40: меньше
 * плёнка перестаёт быть плёнкой, больше — это сотни перемоток ради ячеек в
 * несколько пикселей.
 */
export function filmstripCellCount(trackWidth: number, trackHeight: number, aspect: number): number {
  if (!isPositive(trackWidth) || !isPositive(trackHeight) || !isPositive(aspect)) return 0
  const fit = Math.round(trackWidth / (trackHeight * aspect))
  return Math.min(FILMSTRIP_MAX_CELLS, Math.max(FILMSTRIP_MIN_CELLS, fit))
}

/**
 * Время СЕРЕДИНЫ каждой ячейки. Середина, а не левый край: кадр в ячейке
 * показывает весь её отрезок, и по краю плёнка всегда казалась бы сдвинутой
 * назад. Не дальше конца клипа (перемотка точно в конец часто отдаёт чёрный
 * кадр) и не раньше нуля.
 */
export function filmstripCellTimes(duration: number, count: number): number[] {
  if (!isPositive(duration) || !Number.isFinite(count)) return []
  const cells = Math.floor(count)
  if (cells < 1) return []
  const last = Math.max(0, duration - 0.001)
  return Array.from({ length: cells }, (_, index) => (
    Math.min(last, Math.max(0, ((index + 0.5) / cells) * duration))
  ))
}

/**
 * В каком порядке снимать ячейки: сначала через большой шаг (для 24 ячеек —
 * 0 и 16, затем 8, затем 4, 12, 20…), потом всё чаще, пока не дойдём до шага 1.
 * Каждая ячейка встречается ровно раз. Плёнка так заполняется равномерно: на
 * любом этапе пустоты рассеяны по клипу, а не собраны в хвосте.
 */
export function filmstripCaptureOrder(count: number): number[] {
  const total = Number.isFinite(count) ? Math.floor(count) : 0
  if (total < 1) return []
  let step = 1
  while (step * 2 < total) step *= 2
  const seen = new Set<number>()
  const order: number[] = []
  for (; step >= 1; step = Math.floor(step / 2)) {
    for (let index = 0; index < total; index += step) {
      if (seen.has(index)) continue
      seen.add(index)
      order.push(index)
    }
  }
  return order
}

/** Размер одной ячейки в пикселях файла: высота постоянная, ширина по пропорции. */
export function filmstripCellSize(aspect: number): { width: number; height: number } {
  const ratio = isPositive(aspect) ? aspect : FILMSTRIP_DEFAULT_ASPECT
  return { width: Math.max(8, Math.round(FILMSTRIP_CELL_HEIGHT * ratio)), height: FILMSTRIP_CELL_HEIGHT }
}

/**
 * Какой кусок кадра брать, чтобы он заполнил ячейку целиком (cover): лишнее по
 * длинной стороне срезается поровну с обеих сторон. Кадр бывает любой
 * пропорции, а ячейки одинаковые — поля вокруг вертикального клипа делали бы
 * плёнку из чёрных полос.
 */
export function filmstripCoverRect(
  sourceWidth: number,
  sourceHeight: number,
  cellWidth: number,
  cellHeight: number,
): { sx: number; sy: number; sw: number; sh: number } | null {
  if (![sourceWidth, sourceHeight, cellWidth, cellHeight].every(isPositive)) return null
  const sourceAspect = sourceWidth / sourceHeight
  const cellAspect = cellWidth / cellHeight
  if (sourceAspect > cellAspect) {
    const sw = sourceHeight * cellAspect
    return { sx: (sourceWidth - sw) / 2, sy: 0, sw, sh: sourceHeight }
  }
  const sh = sourceWidth / cellAspect
  return { sx: 0, sy: (sourceHeight - sh) / 2, sw: sourceWidth, sh }
}

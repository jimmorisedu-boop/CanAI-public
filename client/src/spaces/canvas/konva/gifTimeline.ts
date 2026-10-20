/**
 * Время внутри GIF: у каждого кадра своя длительность, поэтому «секунда N»
 * — это не кадр N × шаг, а сумма длительностей до него. Чистая арифметика —
 * её проверяют тесты без браузера (gifTimeline.test.ts).
 */

/** Полная длительность в миллисекундах. */
export function gifTotalMs(durationsMs: readonly number[]): number {
  return durationsMs.reduce((sum, ms) => sum + ms, 0)
}

/** Когда начинается кадр `index`, мс от начала. */
export function gifFrameStartMs(durationsMs: readonly number[], index: number): number {
  let start = 0
  for (let i = 0; i < index && i < durationsMs.length; i++) start += durationsMs[i]!
  return start
}

/**
 * Какой кадр виден в момент `timeMs`. Время за концом — последний кадр, а не
 * начало по кругу: перемотка в самый конец полосы обязана показывать конец.
 */
export function gifFrameAt(durationsMs: readonly number[], timeMs: number): number {
  if (durationsMs.length === 0) return 0
  if (!Number.isFinite(timeMs) || timeMs <= 0) return 0
  // Время приходит из секунд и долей полосы: 0.75 × 1.2 с даёт 899.999… мс, и
  // без округления точная граница кадра уезжала бы на кадр раньше (поймано
  // живой перемоткой). Микросекунды — точнее, чем бывает длительность кадра.
  const time = Math.round(timeMs * 1000) / 1000
  let end = 0
  for (let i = 0; i < durationsMs.length; i++) {
    end += durationsMs[i]!
    if (time < end) return i
  }
  return durationsMs.length - 1
}

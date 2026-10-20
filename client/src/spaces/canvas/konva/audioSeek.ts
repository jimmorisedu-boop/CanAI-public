// Перемотка звука на холсте: чистые правила, чтобы их можно было проверить
// без DOM и без живого <audio>.

/** Шаг стрелки. Секунда — привычный мелкий шаг, десять — «перебросить кусок».
 *  Кадров у звука нет, поэтому шаг задан в секундах, а не в них. */
export const AUDIO_STEP_S = 1
export const AUDIO_BIG_STEP_S = 10

export function audioSeekStep(shiftKey: boolean): number {
  return shiftKey ? AUDIO_BIG_STEP_S : AUDIO_STEP_S
}

/** Куда встанет курсор после стрелки. Держим в пределах дорожки: уехав за
 *  конец, звук бы просто перестал играть без объяснений. */
export function nextAudioTime(input: {
  current: number
  duration: number
  direction: -1 | 1
  shiftKey: boolean
}): number {
  const { current, duration, direction, shiftKey } = input
  if (!Number.isFinite(duration) || duration <= 0) return 0
  const next = current + direction * audioSeekStep(shiftKey)
  return Math.max(0, Math.min(duration, next))
}

/** Клик по волне: доля ширины → время. Доля приходит от фигуры, которая знает
 *  свою ширину, поэтому здесь только арифметика и границы. */
export function timeFromWaveRatio(ratio: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  if (!Number.isFinite(ratio)) return 0
  return Math.max(0, Math.min(duration, ratio * duration))
}

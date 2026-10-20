// Разбор вывода фильтра scdet: где ffmpeg заметил склейку и насколько уверенно.
// Отдельно от запуска процесса — формат вывода капризен, и проверять его надо
// на строках.

export interface ShotCandidate {
  time: number
  /** Оценка непохожести соседних кадров, 0..100. Наружу уходит как есть:
   *  ползунок чувствительности отсекает уже посчитанное, без нового прогона. */
  score: number
}

/** Ниже этого держать нечего: плавное движение камеры даёт единицы, и такие
 *  «кандидаты» только раздували бы список, который потом фильтровать. */
export const SCORE_FLOOR = 2

/** Ближе этого два срабатывания считаются одним: у настоящей склейки высокий
 *  балл держится несколько кадров подряд, и без слияния одна склейка дала бы
 *  горсть меток вплотную. */
export const MERGE_WINDOW_S = 0.4

/** Больше этого показывать бессмысленно — столько меток на дорожке уже не
 *  разглядеть, а ползунок всё равно оставит десяток. */
export const MAX_CANDIDATES = 64

/**
 * Из вывода `-vf "scdet=threshold=0,metadata=print:key=lavfi.scd.score:file=-"`.
 *
 * Идёт парами строк:
 *   frame:12   pts:12000   pts_time:0.500000
 *   lavfi.scd.score=8.123456
 */
export function parseShotScores(text: string): ShotCandidate[] {
  const found: ShotCandidate[] = []
  let time: number | null = null

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const timeMatch = /pts_time:\s*(-?[\d.]+)/.exec(trimmed)
    if (timeMatch) {
      const parsed = Number(timeMatch[1])
      time = Number.isFinite(parsed) && parsed >= 0 ? parsed : null
      continue
    }
    const scoreMatch = /lavfi\.scd\.score\s*=\s*([\d.]+)/.exec(trimmed)
    if (scoreMatch && time !== null) {
      const score = Number(scoreMatch[1])
      if (Number.isFinite(score)) found.push({ time: Math.round(time * 1000) / 1000, score })
      time = null
    }
  }
  return found
}

/**
 * Оставить только пики: из группы близких срабатываний — самое уверенное.
 *
 * Без этого одна склейка приходит горстью меток вплотную (высокий балл держится
 * несколько кадров), и дорожка превращается в частокол, по которому не понять,
 * сколько на самом деле шотов.
 */
export function peakCandidates(
  raw: readonly ShotCandidate[],
  floor: number = SCORE_FLOOR,
  window: number = MERGE_WINDOW_S,
): ShotCandidate[] {
  const strong = raw
    .filter((candidate) => candidate.score >= floor && candidate.time > 0)
    .sort((left, right) => right.score - left.score)

  const kept: ShotCandidate[] = []
  for (const candidate of strong) {
    if (kept.length >= MAX_CANDIDATES) break
    // Сортировка по убыванию балла означает, что первым в окне окажется
    // самый уверенный — остальные из той же склейки просто отсекаются.
    if (kept.some((chosen) => Math.abs(chosen.time - candidate.time) < window)) continue
    kept.push(candidate)
  }
  return kept.sort((left, right) => left.time - right.time)
}

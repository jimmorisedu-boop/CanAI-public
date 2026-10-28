// Математика таймлайна: границы стыков, сборка кусков, сведение резов.
// Вся она чистая — режим правки видео нельзя проверить без DOM и ffmpeg, а
// вот правила, по которым он считает, проверить обязательно.
//
// Резы НИКУДА НЕ ПРИТЯГИВАЮТСЯ: метка встаёт ровно туда, куда её поставили.
// Раньше здесь жил снап к опорным кадрам — он был неизбежен, пока куски
// резались копированием потока (ffmpeg умеет начинать копию только с
// опорного кадра, и просьба «с 3.4» давала кусок с 3.0). Теперь каждый рез
// перекодируется, а перекодирование начинает кусок с любого кадра, и
// притягивать стало не к чему. Отсюда же исчезла разница между «обычным» и
// «точным» резом: точный остался один.

/** Короче этого куски не делаем: клип в три кадра — почти наверняка промах,
 *  а не замысел, и разбираться с ним потом дороже, чем не дать его создать. */
export const MIN_PIECE_S = 0.4

export interface Segment {
  start: number
  end: number
}

export function clamp(value: number, low: number, high: number): number {
  if (high < low) return low
  return Math.min(high, Math.max(low, value))
}

/** Куда можно двигать стык: между соседями, с зазором на минимальный кусок. */
export function seamBounds(
  seam: number,
  others: readonly number[],
  inPoint: number,
  outPoint: number,
): { low: number; high: number } {
  let low = inPoint
  let high = outPoint
  for (const other of others) {
    if (other === seam) continue
    if (other < seam && other > low) low = other
    if (other > seam && other < high) high = other
  }
  return { low: low + MIN_PIECE_S, high: high - MIN_PIECE_S }
}

/** Резы, попавшие внутрь выбранного куска, по порядку и без повторов. */
export function activeCuts(
  cuts: readonly number[],
  inPoint: number,
  outPoint: number,
): number[] {
  const inside = cuts.filter((cut) => cut > inPoint + 0.001 && cut < outPoint - 0.001)
  return [...new Set(inside)].sort((left, right) => left - right)
}

/** Что получится по «Применить»: куски слева направо.
 *
 * Резов нет — один кусок от входа до выхода. Это и есть обрезка: отдельной
 * операции для неё не нужно, она частный случай нарезки. */
export function segmentsFrom(
  inPoint: number,
  outPoint: number,
  cuts: readonly number[],
): Segment[] {
  if (outPoint - inPoint < MIN_PIECE_S) return []
  const edges = [inPoint, ...activeCuts(cuts, inPoint, outPoint), outPoint]
  const segments: Segment[] = []
  for (let index = 0; index < edges.length - 1; index++) {
    segments.push({ start: edges[index], end: edges[index + 1] })
  }
  return segments
}

/** Кусок под курсором — тот, в чьих границах стоит время.
 *
 *  Конец последнего куска принадлежит ему же: голова, доведённая до выхода,
 *  стоит не «нигде», а в конце последнего куска, и удалять надо его. */
export function segmentAt(segments: readonly Segment[], time: number): Segment | null {
  for (const segment of segments) {
    if (time >= segment.start && time < segment.end) return segment
  }
  const last = segments[segments.length - 1]
  return last && time >= last.end ? last : null
}

/** Куски, которые пойдут в результат: помеченные к удалению отброшены.
 *
 *  ⚠️ Метка — это ВРЕМЯ НАЧАЛА куска, а не его номер. Номер сбивается от
 *  любого нового реза: поставил рез выше — и помеченным оказывается соседний
 *  кусок. Начало же у куска своё, и переносится вместе с ним (см. moveCut). */
export function keptSegments(
  segments: readonly Segment[],
  dropped: readonly number[],
): Segment[] {
  const gone = new Set(dropped)
  return segments.filter((segment) => !gone.has(segment.start))
}

/** Сколько секунд останется после удаления кусков. */
export function totalLength(segments: readonly Segment[]): number {
  return segments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0)
}

/** Можно ли поставить рез в этой точке. Слишком близко к краю или к соседу —
 *  нельзя, и об этом надо сказать, а не молча ничего не сделать. */
export function canCutAt(
  time: number,
  cuts: readonly number[],
  inPoint: number,
  outPoint: number,
): boolean {
  if (time - inPoint < MIN_PIECE_S || outPoint - time < MIN_PIECE_S) return false
  return !cuts.some((cut) => Math.abs(cut - time) < MIN_PIECE_S)
}

export interface ShotCandidate {
  time: number
  score: number
}

export interface MergedCut {
  time: number
  /** Откуда взялся: найден автоматически или поставлен руками. Нужно не для
   *  вида — от этого зависит, что делать при переносе (см. mergeCuts). */
  auto: boolean
}

/**
 * Свести автоматически найденные склейки и поставленные руками резы.
 *
 * Ползунок чувствительности отсекает УЖЕ ПОСЧИТАННОЕ, поэтому автоматические
 * резы появляются и исчезают мгновенно. Но у этого есть цена: подвинутый
 * автомат обязан перестать слушаться ползунка — иначе случайное движение
 * ручки вернуло бы его на прежнее место, и ручная правка молча пропала бы.
 * Отсюда `dismissed`: тронутое срабатывание больше не участвует, а его новое
 * положение живёт в `manual` как обычный ручной рез.
 */
export function mergeCuts(input: {
  manual: readonly number[]
  shots: readonly ShotCandidate[]
  threshold: number
  dismissed: readonly number[]
  autoOn: boolean
}): MergedCut[] {
  const dismissed = new Set(input.dismissed)
  const merged: MergedCut[] = input.manual.map((time) => ({ time, auto: false }))
  const taken = new Set(input.manual)

  if (input.autoOn) {
    for (const shot of input.shots) {
      if (shot.score < input.threshold || dismissed.has(shot.time)) continue
      // Ручной рез в той же точке главнее: он поставлен осознанно.
      if (taken.has(shot.time)) continue
      taken.add(shot.time)
      merged.push({ time: shot.time, auto: true })
    }
  }

  return merged.sort((left, right) => left.time - right.time)
}

/** English singular/plural selection for timeline counts. */
export function plural(count: number, one: string, few: string, many: string): string {
  return Math.abs(count) === 1 ? one : few || many
}

export function pluralPieces(count: number): string {
  return plural(count, 'clip', 'clips', 'clips')
}

export function pluralCuts(count: number): string {
  return plural(count, 'cut', 'cuts', 'cuts')
}

/** Следующая (`1`, ↑) или предыдущая (`-1`, ↓) точка монтажа среди `[inPoint, ...cuts, outPoint]`. */
export function adjacentCutTime(
  head: number,
  inPoint: number,
  outPoint: number,
  cuts: readonly number[],
  direction: -1 | 1,
): number {
  const points = outPoint > inPoint
    ? [inPoint, ...activeCuts(cuts, inPoint, outPoint), outPoint]
    : [inPoint]
  if (direction > 0) {
    const next = points.find((point) => point > head + 1e-4)
    return next ?? head
  }
  for (let index = points.length - 1; index >= 0; index--) {
    if (points[index] < head - 1e-4) return points[index]
  }
  return head
}

export type SegmentTrimPlan =
  | { kind: 'noop' }
  | { kind: 'tooShort' }
  | {
      kind: 'trim'
      inPoint: number
      outPoint: number
      addedCut?: number
      dropped: number[]
    }

/**
 * Обрезка слева (`Q`) или справа (`W`) у куска под курсором:
 * - у крайнего левого/правого края клипа двигает `inPoint` / `outPoint` напрямую;
 * - внутри нарезанного клипа ставит рез в `head` и помечает отрезанную часть к удалению,
 *   не задевая соседние куски.
 */
export function planSegmentTrim(input: {
  side: 'left' | 'right'
  head: number
  inPoint: number
  outPoint: number
  cuts: readonly number[]
  dropped: readonly number[]
}): SegmentTrimPlan {
  const { side, head, inPoint, outPoint, cuts, dropped } = input
  const segments = segmentsFrom(inPoint, outPoint, cuts)
  const seg = segmentAt(segments, head)
  if (!seg) return { kind: 'noop' }

  if (side === 'left') {
    if (head <= seg.start + 0.001) return { kind: 'noop' }
    if (seg.end - head < MIN_PIECE_S) return { kind: 'tooShort' }
    if (Math.abs(seg.start - inPoint) < 1e-6) {
      return {
        kind: 'trim',
        inPoint: head,
        outPoint,
        dropped: dropped.filter((start) => Math.abs(start - seg.start) > 1e-6),
      }
    }
    if (head - seg.start < MIN_PIECE_S) return { kind: 'tooShort' }
    const nextDropped = dropped.includes(seg.start) ? [...dropped] : [...dropped, seg.start]
    return {
      kind: 'trim',
      inPoint,
      outPoint,
      addedCut: head,
      dropped: nextDropped,
    }
  }

  if (head >= seg.end - 0.001) return { kind: 'noop' }
  if (head - seg.start < MIN_PIECE_S) return { kind: 'tooShort' }
  if (Math.abs(seg.end - outPoint) < 1e-6) {
    return {
      kind: 'trim',
      inPoint,
      outPoint: head,
      dropped: [...dropped],
    }
  }
  if (seg.end - head < MIN_PIECE_S) return { kind: 'tooShort' }
  const nextDropped = dropped.includes(head) ? [...dropped] : [...dropped, head]
  return {
    kind: 'trim',
    inPoint,
    outPoint,
    addedCut: head,
    dropped: nextDropped,
  }
}

export type PlayableDecision =
  | { kind: 'play' }
  | { kind: 'jump'; time: number }
  | { kind: 'stop'; time: number }

/** Живой предпросмотр монтажа: при воспроизведении перепрыгивает удалённые куски. */
export function nextPlayableTime(
  segments: readonly Segment[],
  dropped: readonly number[],
  currentTime: number,
  onStart: boolean,
): PlayableDecision {
  const kept = keptSegments(segments, dropped)
  if (kept.length === 0) {
    return { kind: 'stop', time: segments[0]?.start ?? 0 }
  }
  const last = kept[kept.length - 1]
  const endSlack = onStart ? 0.02 : 0.005
  if (currentTime >= last.end - endSlack) {
    return onStart ? { kind: 'jump', time: kept[0].start } : { kind: 'stop', time: last.end }
  }
  for (const seg of kept) {
    if (currentTime < seg.start - 0.005) {
      return { kind: 'jump', time: seg.start }
    }
    if (currentTime < seg.end - endSlack) {
      return { kind: 'play' }
    }
  }
  return onStart ? { kind: 'jump', time: kept[0].start } : { kind: 'stop', time: last.end }
}

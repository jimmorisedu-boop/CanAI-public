import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MIN_PIECE_S,
  activeCuts,
  canCutAt,
  clamp,
  keptSegments,
  mergeCuts,
  pluralPieces,
  seamBounds,
  segmentAt,
  segmentsFrom,
  totalLength,
} from './timelineModel.js'

test('стык упирается в соседей, а не в края клипа', () => {
  const bounds = seamBounds(4, [2, 4, 7], 0, 10)
  assert.equal(bounds.low, 2 + MIN_PIECE_S)
  assert.equal(bounds.high, 7 - MIN_PIECE_S)

  // Единственный стык ограничен входом и выходом
  const alone = seamBounds(5, [5], 1, 9)
  assert.equal(alone.low, 1 + MIN_PIECE_S)
  assert.equal(alone.high, 9 - MIN_PIECE_S)
})

test('обрезка — частный случай нарезки, отдельной операции не нужно', () => {
  assert.deepEqual(segmentsFrom(1, 5, []), [{ start: 1, end: 5 }])
  assert.deepEqual(segmentsFrom(0, 9, [3, 6]), [
    { start: 0, end: 3 },
    { start: 3, end: 6 },
    { start: 6, end: 9 },
  ])
})

test('резы вне выбранного куска в результат не попадают', () => {
  // Подвинул вход правее реза — рез перестал существовать, но остаётся в
  // списке: вернул ручку назад, и он на месте. Терять его нельзя.
  assert.deepEqual(activeCuts([1, 4, 8], 2, 6), [4])
  assert.deepEqual(segmentsFrom(2, 6, [1, 4, 8]), [
    { start: 2, end: 4 },
    { start: 4, end: 6 },
  ])
})

test('резы упорядочиваются и не повторяются', () => {
  assert.deepEqual(activeCuts([6, 3, 3, 4.5], 0, 10), [3, 4.5, 6])
})

test('слишком короткий выбор не даёт ни одного куска', () => {
  assert.deepEqual(segmentsFrom(2, 2.2, []), [], 'клип в три кадра — это промах, а не замысел')
  assert.deepEqual(segmentsFrom(5, 5, [4]), [])
})

test('рез нельзя поставить впритык к краю или к соседнему резу', () => {
  assert.equal(canCutAt(5, [], 0, 10), true)
  assert.equal(canCutAt(0.2, [], 0, 10), false, 'слишком близко ко входу')
  assert.equal(canCutAt(9.9, [], 0, 10), false, 'слишком близко к выходу')
  assert.equal(canCutAt(5.1, [5], 0, 10), false, 'слишком близко к соседу')
  assert.equal(canCutAt(5.5, [5], 0, 10), true)
})

test('клампы не переворачиваются на вырожденном диапазоне', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-3, 0, 10), 0)
  assert.equal(clamp(30, 0, 10), 10)
  // high < low бывает на очень коротком клипе: важно не вернуть мусор
  assert.equal(clamp(5, 8, 2), 8)
})

test('ползунок отсекает уже посчитанное, ничего не пересчитывая', () => {
  const shots = [{ time: 2, score: 40 }, { time: 5, score: 12 }, { time: 8, score: 60 }]
  const base = { manual: [], shots, dismissed: [], autoOn: true }

  assert.deepEqual(mergeCuts({ ...base, threshold: 10 }).map((cut) => cut.time), [2, 5, 8])
  assert.deepEqual(mergeCuts({ ...base, threshold: 30 }).map((cut) => cut.time), [2, 8])
  assert.deepEqual(mergeCuts({ ...base, threshold: 70 }).map((cut) => cut.time), [])
})

test('выключенный автопоиск не оставляет своих меток', () => {
  const shots = [{ time: 2, score: 90 }]
  const off = mergeCuts({ manual: [4], shots, threshold: 10, dismissed: [], autoOn: false })
  assert.deepEqual(off, [{ time: 4, auto: false }])
})

test('границы шотов никуда не притягиваются', () => {
  // Найденная склейка — точка, где сменился кадр. Пока куски резались
  // копированием потока, её тянуло к опорному кадру, и замер на настоящем
  // ролике показывал уезды 4.47→3.9 и 15.77→15.4 — полсекунды чужого шота в
  // начале куска. Теперь режем перекодированием, и склейка остаётся собой.
  const merged = mergeCuts({
    manual: [], shots: [{ time: 4.47, score: 40 }], threshold: 10, dismissed: [], autoOn: true,
  })
  assert.deepEqual(merged, [{ time: 4.47, auto: true }])
})

test('подвинутый автомат перестаёт слушаться ползунка', () => {
  // Иначе случайное движение ручки чувствительности вернуло бы рез на прежнее
  // место, и ручная правка пропала бы молча — худший вид потери работы.
  const shots = [{ time: 2, score: 40 }]
  const moved = mergeCuts({
    manual: [3], shots, threshold: 10, dismissed: [2], autoOn: true,
  })
  assert.deepEqual(moved, [{ time: 3, auto: false }])
})

test('ручной рез главнее автоматического в той же точке', () => {
  const merged = mergeCuts({
    manual: [2], shots: [{ time: 2, score: 90 }], threshold: 10, dismissed: [], autoOn: true,
  })
  assert.deepEqual(merged, [{ time: 2, auto: false }])
})

test('clip counts use English plurals', () => {
  assert.equal(pluralPieces(1), 'clip')
  assert.equal(pluralPieces(2), 'clips')
  assert.equal(pluralPieces(5), 'clips')
  assert.equal(pluralPieces(11), 'clips')
  assert.equal(pluralPieces(21), 'clips')
  assert.equal(pluralPieces(112), 'clips')
})

test('кусок под курсором ищется по границам, конец принадлежит последнему', () => {
  const segments = segmentsFrom(0, 9, [3, 6])
  assert.deepEqual(segmentAt(segments, 0), { start: 0, end: 3 })
  assert.deepEqual(segmentAt(segments, 2.99), { start: 0, end: 3 })
  // Граница принадлежит СЛЕДУЮЩЕМУ куску: курсор, доведённый до реза, стоит
  // в начале нового, а не в хвосте прежнего.
  assert.deepEqual(segmentAt(segments, 3), { start: 3, end: 6 })
  // Голова, доведённая до выхода, стоит не «нигде», а в конце последнего.
  assert.deepEqual(segmentAt(segments, 9), { start: 6, end: 9 })
  assert.equal(segmentAt([], 1), null)
})

test('удалённые куски не идут в результат, а длина считается по оставшимся', () => {
  const segments = segmentsFrom(0, 9, [3, 6])
  const kept = keptSegments(segments, [3])
  assert.deepEqual(kept, [{ start: 0, end: 3 }, { start: 6, end: 9 }])
  assert.equal(totalLength(kept), 6)
  // Длина ВСЕГО выбранного куска тут 9 — писать её значило бы обещать
  // человеку секунды, которых в результате не будет.
  assert.equal(totalLength(segments), 9)
})

test('метка удаления привязана к началу куска, а не к его номеру', () => {
  // ⚠️ Номер сбивается от любого нового реза выше по дорожке: удалённым
  // оказался бы соседний кусок. Начало же у куска своё.
  const before = segmentsFrom(0, 9, [6])
  assert.deepEqual(keptSegments(before, [6]), [{ start: 0, end: 6 }])

  const after = segmentsFrom(0, 9, [2, 6])
  assert.deepEqual(keptSegments(after, [6]), [{ start: 0, end: 2 }, { start: 2, end: 6 }])
})

test('метка, оставшаяся без своего куска, ничего не удаляет', () => {
  const segments = segmentsFrom(0, 9, [3])
  assert.deepEqual(keptSegments(segments, [5.5]), segments)
})

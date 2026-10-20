import assert from 'node:assert/strict'
import test from 'node:test'
import { composerReferenceView } from './composerReferenceView'
import type { SelectionRef } from './konva/selection'

const img = (id: string, src = `/media/${id}.png`): SelectionRef => ({ shapeId: id, kind: 'image', label: id, src })
const txt = (id: string, text = id): SelectionRef => ({ shapeId: id, kind: 'text', label: text, text })

const view = (over: Partial<Parameters<typeof composerReferenceView>[0]> = {}) =>
  composerReferenceView({
    chatOpen: false,
    selRefs: [],
    manualRefs: [],
    previousOrder: [],
    replacement: null,
    ...over,
  })

test('выделение канваса и ручные чипы складываются в один набор', () => {
  const result = view({ selRefs: [img('a')], manualRefs: [img('b')] })
  assert.deepEqual(result.composerRefs.map((r) => r.shapeId), ['a', 'b'])
})

test('в окне помощника выделение канваса не участвует — только ручные чипы', () => {
  const result = view({ chatOpen: true, selRefs: [img('a')], manualRefs: [img('b')] })
  assert.deepEqual(result.composerRefs.map((r) => r.shapeId), ['b'])
})

// Порядок медиа задаёт нумерацию @1, @2… и ОБЯЗАН совпадать с тем, как сервер
// разложит image_urls. Разъедься они — «@2» показывал бы на чужую картинку.
test('нумерация медиа идёт по порядку набора и не считает текст', () => {
  const result = view({ selRefs: [txt('t'), img('a'), img('b')] })
  assert.deepEqual(result.mediaRefs.map((r) => r.shapeId), ['a', 'b'])
  assert.deepEqual(result.textRefs.map((r) => r.shapeId), ['t'])
})

test('порядок сохраняется между пересчётами, а новое уходит в конец', () => {
  const first = view({ selRefs: [img('a'), img('b')] })
  const second = view({
    previousOrder: first.order,
    selRefs: [img('b'), img('a')],
    manualRefs: [img('c')],
  })
  assert.deepEqual(second.composerRefs.map((r) => r.shapeId), ['a', 'b', 'c'])
})

// Ради этого замена и сделана отдельным состоянием: пока выбираешь, на что
// поменять, чипы обязаны стоять на месте — иначе новое выделение выглядело бы
// как новый набор референсов.
test('во время точечной замены чипы не шевелятся от нового выделения', () => {
  const base = [img('a'), img('b')]
  const result = view({
    selRefs: [img('z')],
    replacement: { targetShapeId: 'b', baseRefs: base },
  })
  assert.deepEqual(result.composerRefs.map((r) => r.shapeId), ['a', 'b'])
  assert.equal(result.replacementTarget?.shapeId, 'b')
  assert.equal(result.replacementMediaNumber, 2, 'номер показывается человеку — он 1-based')
})

test('замена текстового референса номера не имеет', () => {
  const result = view({
    replacement: { targetShapeId: 't', baseRefs: [img('a'), txt('t')] },
  })
  assert.equal(result.replacementTarget?.shapeId, 't')
  assert.equal(result.replacementMediaNumber, null)
})

test('в окне помощника замена не заморозит набор', () => {
  const result = view({
    chatOpen: true,
    manualRefs: [img('m')],
    replacement: { targetShapeId: 'a', baseRefs: [img('a')] },
  })
  assert.deepEqual(result.composerRefs.map((r) => r.shapeId), ['m'])
})

test('режим «Изменить каждое» сохраняет два разных shapeId с одним src', () => {
  const result = view({
    preserveContentDuplicates: true,
    selRefs: [img('shape-a', '/media/shared.png'), img('shape-b', '/media/shared.png')],
  })
  assert.deepEqual(result.composerRefs.map((ref) => ref.shapeId), ['shape-a', 'shape-b'])
  assert.equal(result.mediaRefs.length, 2)
})

test('переключение вместе не теряет shape identity для возврата в каждое', () => {
  const selected = [img('shape-a', '/media/shared.png'), img('shape-b', '/media/shared.png')]
  const togetherDisplay = view({ preserveContentDuplicates: true, selRefs: selected })
  const eachDisplay = view({
    preserveContentDuplicates: true,
    previousOrder: togetherDisplay.order,
    selRefs: selected,
  })
  assert.deepEqual(togetherDisplay.composerRefs.map((ref) => ref.shapeId), ['shape-a', 'shape-b'])
  assert.deepEqual(eachDisplay.composerRefs.map((ref) => ref.shapeId), ['shape-a', 'shape-b'])
})

test('совместный режим сохраняет историческое удаление одинакового src', () => {
  const result = view({
    selRefs: [img('shape-a', '/media/shared.png'), img('shape-b', '/media/shared.png')],
  })
  assert.deepEqual(result.composerRefs.map((ref) => ref.shapeId), ['shape-a'])
})

test('ключ состава меняется при смене содержимого, а не только состава', () => {
  const before = view({ selRefs: [img('a')] })
  const after = view({
    previousOrder: before.order,
    selRefs: [{ ...img('a'), src: '/media/a.png?v=2' }],
  })
  assert.notEqual(before.composerRefsKey, after.composerRefsKey)
  // а вот набор медиа тот же — перерисовка тегов @n не нужна
  assert.equal(before.mediaIdsKey, after.mediaIdsKey)
})

test('ключ медиа разделён символом, который не встречается в id', () => {
  const result = view({ selRefs: [img('a'), img('b')] })
  assert.equal(result.mediaIdsKey, `a${String.fromCharCode(0)}b`)
})

// ⚠️ Порядок референсов — не косметика. Промпт помощника говорит «перенеси
// черты с изображения 1 на изображение 2», и перестановка даёт ОБРАТНЫЙ
// результат за те же деньги (жалоба 26.08.2026).
//
// Ловушка в том, что в окне помощника чипы показывают ручной набор — порядок,
// в котором объекты туда бросили, — а запоминаемый порядок всё это время
// считается ещё и по выделению канваса. Эти два порядка расходятся молча.
test('в помощнике виден один порядок, а запоминается другой — на этом и ломалось', () => {
  const canvasOrder = view({ selRefs: [img('b'), img('a')] })
  // Объекты бросили в помощника в обратном порядке — их и видно.
  const inChat = view({
    chatOpen: true,
    selRefs: [img('b'), img('a')],
    manualRefs: [img('a'), img('b')],
    previousOrder: canvasOrder.order,
  })
  assert.deepEqual(inChat.composerRefs.map((ref) => ref.shapeId), ['a', 'b'], 'видно порядок броска')
  assert.deepEqual(inChat.order, ['b', 'a'], 'а помнится порядок выделения — вот оно, расхождение')
})

// Поэтому «В строку» обязана НАЗНАЧИТЬ порядок подсказки, а не наследовать
// память бара: набор пришёл от помощника, и нумерация @1/@2 в его тексте
// считана именно с него.
test('порядок подсказки переживает возврат в промпт-бар', () => {
  const fromAssistant = [img('a'), img('b')]
  const applied = view({
    chatOpen: false,
    selRefs: [],
    manualRefs: fromAssistant,
    previousOrder: fromAssistant.map((ref) => ref.shapeId),
  })
  assert.deepEqual(applied.composerRefs.map((ref) => ref.shapeId), ['a', 'b'])

  // А с унаследованной памятью — переворачивался бы, как и жаловались.
  const stale = view({ chatOpen: false, selRefs: [], manualRefs: fromAssistant, previousOrder: ['b', 'a'] })
  assert.deepEqual(stale.composerRefs.map((ref) => ref.shapeId), ['b', 'a'])
})


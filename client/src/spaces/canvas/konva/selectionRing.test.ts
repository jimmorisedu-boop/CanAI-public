import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  SELECTION_GAP_PX,
  selectionPadding,
  selectionRing,
} from './selectionRing'

// ⚠️ Решение пользователя 30.09.2026 из трёх вариантов со снимками:
// выделение — скруглённое кольцо с зазором, как на планшете, а не квадрат
// Konva («квадратное выделение выглядит странно»). У нескольких — кольцо у
// каждого и тонкая приглушённая общая рамка.

const source = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8')

test('зазор кольца — одни и те же экранные пиксели при любом масштабе', () => {
  for (const scale of [0.1, 0.5, 1, 2, 8]) {
    const ring = selectionRing({ w: 440, h: 330, radius: 4 / scale }, scale)!
    assert.ok(Math.abs(-ring.x * scale - SELECTION_GAP_PX) < 1e-9, `×${scale}: зазор слева`)
    assert.ok(Math.abs((ring.w - 440) / 2 * scale - SELECTION_GAP_PX) < 1e-9, `×${scale}: зазор справа`)
  }
})

test('кольцо концентрично объекту: его радиус — скругление плюс зазор', () => {
  const ring = selectionRing({ w: 300, h: 100, radius: 10 }, 1)!
  assert.deepEqual(ring, { x: -3, y: -3, w: 306, h: 106, radius: 13 })
  // Объект со сдвигом внутри своей группы — кольцо сдвигается вместе с ним.
  const shifted = selectionRing({ x: 5, y: 7, w: 10, h: 10, radius: 0 }, 1)!
  assert.equal(shifted.x, 2)
  assert.equal(shifted.y, 4)
})

test('бессмысленный масштаб или размер кольца не рисуют', () => {
  assert.equal(selectionRing({ w: 100, h: 100, radius: 4 }, 0), null)
  assert.equal(selectionRing({ w: 100, h: 100, radius: 4 }, Number.NaN), null)
  assert.equal(selectionRing({ w: 0, h: 100, radius: 4 }, 1), null)
})

test('ручки одного объекта — на углах кольца, общая рамка группы — снаружи колец', () => {
  assert.equal(selectionPadding(1), SELECTION_GAP_PX)
  assert.ok(selectionPadding(2) > SELECTION_GAP_PX, 'рамка группы не должна резать кольца крайних объектов')
})

test('квадратная рамка Konva рисуется только у группы, ручки круглые', async () => {
  const text = await source('KonvaCanvas.tsx')
  const layer = text.slice(text.indexOf('{/* слой трансформера'), text.indexOf('</Layer>', text.indexOf('{/* слой трансформера')))
  assert.ok(layer.indexOf('<SelectionRings transformer={trRef} />') >= 0, 'кольца живут в слое трансформера')
  assert.ok(layer.indexOf('<SelectionRings') < layer.indexOf('<Transformer'), 'кольца — под ручками')
  assert.match(layer, /borderEnabled=\{transformedCount > 1\}/)
  assert.match(layer, /padding=\{selectionPadding\(transformedCount\)\}/)
  assert.match(layer, /anchorCornerRadius=\{9 \/ 2\}/)
})

test('каждый объект сообщает выделению своё скругление — то же, что рисует', async () => {
  const bodies: Array<[string, RegExp, RegExp]> = [
    ['ImageItem.tsx', /selectionFrame=\{\{ w: item\.w, h: item\.h, radius \}\}/, /cornerRadius=\{radius\}/],
    ['VideoItem.tsx', /selectionFrame=\{\{ w: item\.w, h: item\.h, radius \}\}/, /cornerRadius=\{radius\}/],
    ['GifItem.tsx', /selectionFrame=\{\{ w: item\.w, h: item\.h, radius \}\}/, /cornerRadius=\{radius\}/],
    ['TextItem.tsx', /selectionFrame=\{\{ w, h, radius: TEXT_CARD_RADIUS \}\}/, /cornerRadius=\{TEXT_CARD_RADIUS\}/],
    ['AudioItem.tsx', /selectionFrame=\{\{ w, h, radius: AUDIO_CARD_RADIUS \}\}/, /cornerRadius=\{AUDIO_CARD_RADIUS\}/],
    ['LinkItem.tsx', /selectionFrame=\{\{ w: item\.w, h: item\.h, radius: LINK_CARD_RADIUS \}\}/, /cornerRadius=\{LINK_CARD_RADIUS\}/],
    ['PendingItem.tsx', /selectionFrame=\{\{ w: p\.w, h: p\.h, radius: loading && preview \? mediaRadius : PENDING_CARD_RADIUS \}\}/, /cornerRadius=\{PENDING_CARD_RADIUS\}/],
  ]
  for (const [name, frame, body] of bodies) {
    const text = await source(name)
    assert.match(text, frame, `${name}: выделение не знает скругления объекта`)
    assert.match(text, body, `${name}: у тела объекта другое скругление, чем у кольца`)
  }
})

test('рамка карточки при выделении не краснеет — выделение показывает кольцо', async () => {
  for (const name of ['LinkItem.tsx', 'AudioItem.tsx']) {
    assert.doesNotMatch(await source(name), /stroke=\{selected \?/, `${name}: вышла бы двойная красная линия`)
  }
})

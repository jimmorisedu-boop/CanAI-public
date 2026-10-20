import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { MEDIA_CORNER_PX, mediaCornerRadius } from './canvasLayout'

// ⚠️ Жалоба 21.09.2026 со снимком «обводка криво закруглена»: рамка у
// картинки была скруглена, а сам кадр — нет, и его квадратный угол торчал из-за
// дуги. При приближении это видно сразу. То же было у превью в карточке ссылки.
//
// ⚠️ Жалоба 30.09.2026 со снимками «скругления у контента и выделенного
// контента выглядят странно»: скругление и рамка медиа были в единицах доски.
// При ×8 кадр терял 32 px угла, рамка становилась полосой в 8 px, а рамка
// выделения мерила объект вместе с ней и вставала снаружи — в углу выходило
// несколько вложенных контуров. Прежний тест требовал число 4 в единицах
// доски, то есть закреплял именно это; переписан вместе с поведением.

const source = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8')

/** Свойства JSX-элемента: от открывающего тега до его конца. */
function elementBlocks(text: string, tag: string): string[] {
  const blocks: string[] = []
  let from = text.indexOf(`<${tag}`)
  while (from >= 0) {
    const end = text.indexOf('/>', from)
    blocks.push(text.slice(from, end < 0 ? undefined : end))
    from = text.indexOf(`<${tag}`, from + 1)
  }
  return blocks
}

test('скругление медиа на экране одно при любом масштабе', () => {
  assert.equal(MEDIA_CORNER_PX, 4)
  for (const scale of [0.25, 0.5, 1, 2, 8, 24]) {
    const onScreen = mediaCornerRadius(scale, 440, 440) * scale
    assert.ok(Math.abs(onScreen - MEDIA_CORNER_PX) < 1e-9, `×${scale}: ${onScreen} px на экране`)
  }
})

test('при сильном отдалении угол не превращает кадр в кружок', () => {
  // Картинка 440 при ×0.02 — меньше 9 px на экране.
  assert.equal(mediaCornerRadius(0.02, 440, 440), 440 / 6)
  // Потолок считается по меньшей стороне.
  assert.equal(mediaCornerRadius(0.01, 1000, 60), 10)
})

test('бессмысленный масштаб или размер не ломают отрисовку', () => {
  assert.equal(mediaCornerRadius(0, 440, 440), 0)
  assert.equal(mediaCornerRadius(Number.NaN, 440, 440), 0)
  assert.equal(mediaCornerRadius(1, 0, 440), 0)
})

test('кадр, рамка и полосы у кромки скруглены одним числом', async () => {
  for (const name of ['ImageItem.tsx', 'VideoItem.tsx', 'GifItem.tsx']) {
    const text = await source(name)
    const computed = text.match(/const radius = mediaCornerRadius\(viewScale, item\.w, item\.h\)/g) ?? []
    assert.equal(computed.length, 1, `${name}: радиус считается один раз, из огрублённого масштаба`)
    const frames = elementBlocks(text, 'KonvaImage')
    assert.ok(frames.length > 0, `${name}: кадр найден`)
    for (const frame of frames) {
      assert.match(frame, /cornerRadius=\{radius\}/, `${name}: кадр без общего скругления торчит из-за рамки`)
    }
    const outline = elementBlocks(text, 'Rect').find((block) => block.includes('stroke={tc.itemBorder}'))
    assert.ok(outline, `${name}: рамка найдена`)
    assert.match(outline!, /cornerRadius=\{radius\}/, `${name}: рамка и кадр — одно число`)
    assert.match(outline!, /strokeScaleEnabled=\{false\}/, `${name}: рамка — линия на экране, а не полоса доски`)
    for (const strip of elementBlocks(text, 'LeftAccentStrip')) {
      assert.match(strip, /radius=\{radius\}/, `${name}: полоса «сгенерировано» скруглена как кадр`)
    }
    for (const bar of elementBlocks(text, 'MediaProgressBar')) {
      assert.match(bar, /cornerRadius=\{radius\}/, `${name}: полоса перемотки скруглена как кадр`)
    }
  }
})

test('полоса «сгенерировано» — 4 px на экране, а не в единицах доски', async () => {
  const text = await source('ImageItem.tsx')
  const strip = text.slice(text.indexOf('export function LeftAccentStrip'), text.indexOf('export const ImageItem'))
  assert.match(strip, /const worldWidth = 4 \/ scale/)
})

test('рамка выделения ложится на край объекта, а не снаружи его обводки', async () => {
  const transformers = elementBlocks(await source('KonvaCanvas.tsx'), 'Transformer')
  assert.equal(transformers.length, 1)
  assert.match(transformers[0]!, /\bignoreStroke\b/, 'без ignoreStroke Konva мерит объект вместе с толщиной рамки')
})

test('рамки карточек — линия на экране при любом масштабе', async () => {
  const cards: Array<[string, string]> = [
    ['TextItem.tsx', 'stroke={tc.textBorder}'],
    ['LinkItem.tsx', 'stroke={colors.itemBorder}'],
    ['AudioItem.tsx', 'stroke={tc.textBorder}'],
    ['PendingItem.tsx', 'tc.pendingStroke'],
  ]
  for (const [name, marker] of cards) {
    const outlines = elementBlocks(await source(name), 'Rect').filter((block) => block.includes(marker))
    assert.ok(outlines.length > 0, `${name}: рамка найдена`)
    for (const outline of outlines) {
      assert.match(outline, /strokeScaleEnabled=\{false\}/, `${name}: рамка толстеет при приближении`)
    }
  }
})

test('превью карточки ссылки обрезано по скруглению карточки', async () => {
  const text = await source('LinkItem.tsx')
  assert.ok(!/clipWidth=/.test(text), 'прямоугольная обрезка оставляет квадратные углы')
  assert.match(text, /clipFunc=\{clipPreviewCorners\(/)
  assert.match(text, /cornerRadius=\{LINK_CARD_RADIUS\}/, 'у карточки и превью одно скругление')
})

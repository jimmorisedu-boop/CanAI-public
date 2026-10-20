import assert from 'node:assert/strict'
import test from 'node:test'
import { stepTextTransform, type TextTransformState } from './textTransform'

class FakeNode {
  constructor(private sx: number, private sy: number) {}
  scaleX(next?: number) { if (next !== undefined) this.sx = next; return this.sx }
  scaleY(next?: number) { if (next !== undefined) this.sy = next; return this.sy }
}

const initial: TextTransformState = { w: 120, h: 80, fontSize: 16 }

test('угловое увеличение растит шрифт, даже если Konva уже сбросила одну ось', () => {
  const result = (stepTextTransform as unknown as (...args: unknown[]) => TextTransformState)(
    initial,
    new FakeNode(1.5, 1),
    'Текст',
    'bottom-right',
  )
  assert.equal(result.fontSize, 24)
})

test('боковая ручка меняет перенос строк, но не размер шрифта', () => {
  const result = (stepTextTransform as unknown as (...args: unknown[]) => TextTransformState)(
    initial,
    new FakeNode(1.5, 1),
    'Текст',
    'middle-right',
  )
  assert.equal(result.fontSize, 16)
})

test('угловое увеличение продолжает растить шрифт после 200px вместе с рамкой', () => {
  const result = stepTextTransform(
    { w: 1200, h: 800, fontSize: 180 },
    new FakeNode(2, 2),
    'Крупный текст',
    'bottom-right',
  )

  assert.deepEqual(result, { w: 2400, h: 1600, fontSize: 360 })
})

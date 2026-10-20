import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCardLayout } from './pendingCardLayout'

// Карточки бывают любых пропорций: заглушка повторяет размер будущего
// результата. Проверяем инвариант, который и сломался вживую — текст ошибки
// на четыре строки наезжал на кнопки.
const sizes = [
  { w: 440, h: 440, scale: 1.3 },
  { w: 800, h: 450, scale: 1.3 },
  { w: 300, h: 520, scale: 1 },
  { w: 220, h: 160, scale: 0.73 },
  { w: 160, h: 90, scale: 0.7 },
]

test('текст ошибки никогда не залезает на кнопки', () => {
  for (const size of sizes) {
    const l = errorCardLayout(size)
    assert.ok(
      l.detailY + l.detailH <= l.buttonsY,
      `${size.w}×${size.h}: текст доходит до ${l.detailY + l.detailH}, кнопки с ${l.buttonsY}`,
    )
  }
})

test('кнопки всегда внутри карточки', () => {
  for (const size of sizes) {
    const l = errorCardLayout(size)
    assert.ok(l.buttonsY >= 0, `${size.w}×${size.h}: кнопки выше верхнего края`)
    assert.ok(
      l.buttonsY + l.btnH <= size.h,
      `${size.w}×${size.h}: кнопки вылезают за низ (${l.buttonsY + l.btnH} > ${size.h})`,
    )
    // две кнопки и зазор между ними помещаются по ширине
    assert.ok(
      l.btnW * 2 + l.gap <= size.w,
      `${size.w}×${size.h}: две кнопки шире карточки`,
    )
  }
})

test('на совсем низкой карточке заголовок уступает место кнопкам', () => {
  const tall = errorCardLayout({ w: 300, h: 520, scale: 1 })
  assert.equal(tall.showTitle, true)
  // 40px по высоте: помещаются только кнопки
  const tiny = errorCardLayout({ w: 160, h: 40, scale: 0.7 })
  assert.equal(tiny.showTitle, false)
  assert.equal(tiny.detailH, 0, 'текста не остаётся — только кнопки')
  assert.ok(tiny.buttonsY + tiny.btnH <= 40, 'кнопки всё равно внутри карточки')
})

test('на просторной карточке под текст ошибки остаётся место', () => {
  const l = errorCardLayout({ w: 440, h: 440, scale: 1.3 })
  assert.ok(l.detailH > 100, `под текст отведено всего ${l.detailH}px`)
  assert.ok(l.showTitle)
})

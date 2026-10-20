import assert from 'node:assert/strict'
import test from 'node:test'
import { cardActionLabelY, OPTICAL_CENTRE_SHIFT } from './cardActionButtonLayout.js'

/**
 * ⚠️ Наивный центр — это ловушка, в которую здесь уже попадали: и
 * `verticalAlign="middle"`, и `(height - fontSize) / 2` ставят подпись выше
 * середины кнопки, потому что Konva центрирует кегельную площадку вместе с
 * местом под хвосты букв. Тест закрепляет именно поправку.
 */
test('подпись кнопки опускается на замеренную оптическую поправку', () => {
  const naive = (height: number, fontSize: number) => height / 2 - fontSize / 2
  for (const [height, fontSize] of [[26, 11], [34, 12], [40, 14]] as const) {
    const y = cardActionLabelY(height, fontSize)
    assert.ok(y > naive(height, fontSize), 'подпись должна стоять ниже наивного центра')
    assert.equal(
      Number((y - naive(height, fontSize)).toFixed(4)),
      Number((OPTICAL_CENTRE_SHIFT * fontSize).toFixed(4)),
    )
  }
})

test('поправка задана долей кегля, а не пикселями', () => {
  // Кнопка растёт вместе с карточкой, поэтому сдвиг обязан расти с кеглем:
  // фиксированный пиксель на крупной карточке снова уводил бы подпись вверх.
  const small = cardActionLabelY(26, 11) - (26 / 2 - 11 / 2)
  const large = cardActionLabelY(60, 24) - (60 / 2 - 24 / 2)
  assert.ok(large > small * 2, 'сдвиг пропорционален кеглю')
})

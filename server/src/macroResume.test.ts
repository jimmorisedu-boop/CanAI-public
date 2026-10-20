import assert from 'node:assert/strict'
import test from 'node:test'
import { hasInlineRefs } from './macroRuns.js'

// Продолжение прогона после перезапуска приложения держится на одном правиле:
// шаг перезапускается, только если у него нет ни сохранённого результата, ни
// живой задачи. Здесь проверяется граница, за которой продолжать НЕЛЬЗЯ.

test('обычный прогон продолжаемый', () => {
  assert.equal(hasInlineRefs([{ kind: 'image', src: '/media/a.png' }]), false)
  assert.equal(hasInlineRefs([]), false)
})

test('встроенная копия картинки делает прогон непродолжаемым', () => {
  // Кадр, снятый из видео прямо в браузере, приходит строкой data:. В состояние
  // прогона такую не записать (это мегабайты и нарушение инварианта «без
  // base64»), а без неё незапущенный шаг получил бы не те входы — и выдал бы
  // оплаченный, но неправильный результат. Честнее прерваться.
  assert.equal(hasInlineRefs([{ kind: 'image', src: 'data:image/png;base64,AAAA' }]), true)
})

test('встроенная копия ищется и в разложенных по связям входах', () => {
  assert.equal(
    hasInlineRefs([], {
      refs: [],
      refsByEdge: { 'e1': [{ kind: 'image', src: 'data:image/jpeg;base64,AAAA' }] },
      assetsBySlot: {},
    }),
    true,
  )
  assert.equal(
    hasInlineRefs([], {
      refs: [{ kind: 'image', src: 'data:image/png;base64,AA' }],
      refsByEdge: {},
      assetsBySlot: {},
    }),
    true,
  )
  assert.equal(
    hasInlineRefs([], {
      refs: [{ kind: 'image', src: '/media/a.png' }],
      refsByEdge: { 'e1': [{ kind: 'text', text: 'подпись' }] },
      assetsBySlot: {},
    }),
    false,
  )
})

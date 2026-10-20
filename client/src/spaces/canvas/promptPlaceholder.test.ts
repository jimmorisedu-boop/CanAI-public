// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { promptPlaceholder } from './promptPlaceholder'

const hint = (over: Partial<Parameters<typeof promptPlaceholder>[0]> = {}) =>
  promptPlaceholder({
    chatOpen: false,
    sketchTarget: null,
    textRefCount: 0,
    mediaRefCount: 0,
    ...over,
  })

test('обычное состояние объясняет, что Enter запускает генерацию', () => {
  assert.match(hint(), /generate/)
  assert.match(hint(), /Shift\+Enter/)
})


test('окно помощника перебивает скетч и референсы', () => {
  assert.match(hint({ chatOpen: true, sketchTarget: 's', mediaRefCount: 2 }), /Message assistant/)
})

test('скетч перебивает референсы: генерация пойдёт по склейке', () => {
  assert.match(hint({ sketchTarget: 's', mediaRefCount: 2, textRefCount: 2 }), /sketched image/)
})

// Текст-референс может сам стать промптом, и человеку важно узнать это ДО
// того, как он решит, что кнопка не работает без набранного текста.
test('текстовый референс объясняет, что писать не обязательно', () => {
  assert.match(hint({ textRefCount: 1, mediaRefCount: 5 }), /leave this empty/)
})

test('медиа-референсы подсказывают про @', () => {
  assert.match(hint({ mediaRefCount: 1 }), /@/)
})

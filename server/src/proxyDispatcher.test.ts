import assert from 'node:assert/strict'
import test from 'node:test'
import { applyProxyDispatcher } from './proxyDispatcher.js'

// ⚠️ `fetch` в Node прокси САМ НЕ УМЕЕТ — переменные HTTPS_PROXY/HTTP_PROXY он
// не читает. Из-за этого получалось наполовину рабочее состояние: WebSocket
// доски прокси уважал, а вход в команду, список моделей, запуск генерации и
// загрузка файлов уходили напрямую. За VPN это выглядит как «доска то
// работает, то нет» без всякой системы (вопрос пользователя 03.09.2026).

test('без прокси глобальный транспорт не подменяется', () => {
  assert.equal(applyProxyDispatcher({}), null)
  assert.equal(applyProxyDispatcher({ HTTPS_PROXY: '' }), null)
})

test('заданный прокси включается и сообщается вызывающему', () => {
  const proxy = applyProxyDispatcher({ HTTPS_PROXY: 'http://127.0.0.1:10809' })
  // ⚠️ Адрес возвращается нормализованным (со слэшем) — это тот же прокси.
  assert.equal(proxy, 'http://127.0.0.1:10809/')
})

// NO_PROXY должен уважаться той же настройкой — иначе домашняя сеть и планшет
// поехали бы через чужой туннель.
test('исключения NO_PROXY учитываются', () => {
  assert.equal(
    applyProxyDispatcher({ HTTPS_PROXY: 'http://127.0.0.1:10809', NO_PROXY: 'example.invalid' }),
    null,
  )
})

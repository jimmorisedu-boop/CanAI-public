// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { readFileSync } from 'node:fs'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'

// ⚠️ Пояснение тарифа («оплата по фактическому расходу fal», «себестоимость
// маршрута без наценки») выводилось абзацем посреди промпт-бара — без единого
// правила в стилях, браузерным кеглем, — и человек видел вместо цены длинное
// сообщение (жалоба 21.09.2026 со снимками сетевой доски). Место пояснения —
// подсказка над ценой, и она одна на компьютер и планшет.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('промпт-бар не выводит пояснение тарифа абзацем', () => {
  const source = read('./PromptBar.tsx')
  assert.doesNotMatch(source, /pricingNote && <p/)
  assert.match(source, /title=\{priceBadgeTitle\(displayModel\)\}/)
})

test('на планшете та же подсказка над ценой, а не строка в заголовке полки', () => {
  const source = read('../../tablet/TabletPrompt.tsx')
  assert.match(source, /title=\{priceBadgeTitle\(displayModel\)\}/)
  assert.doesNotMatch(source, /tablet-pricing-note-short/)
})

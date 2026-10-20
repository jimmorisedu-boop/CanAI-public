// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { readFileSync } from 'node:fs'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'

// ⚠️ Ролик на холсте не имеет права держать соединение с сервером открытым.
// К одному адресу браузер держит не больше шести соединений, и с
// preload='auto' семь крупных роликов в кадре занимали все: запись доски,
// проверка связи, загрузки и картинки вставали в очередь навсегда — «Сохранение…»
// висит, «0 КБ из 16 МБ», «ничего не грузит и не делает» (21.09.2026). Замер в
// Chrome на 20 роликах по 49 МБ: auto — 9 запросов висят и /api/status не
// отвечает 20 секунд; metadata — висящих 0, ответ за 3 мс, кадры на месте.
// Воспроизвести соединения браузера здесь нечем, поэтому сверяем сам хук.

const source = readFileSync(new URL('./media.ts', import.meta.url), 'utf8')
const hook = source.slice(source.indexOf('export function useVideoEl'), source.indexOf('return video', source.indexOf('export function useVideoEl')))

test('ролик на холсте просит у браузера только начало файла', () => {
  assert.ok(hook.length > 0, 'хук useVideoEl не найден')
  assert.match(hook, /el\.preload = 'metadata'/)
  assert.doesNotMatch(hook, /preload = 'auto'/, 'auto держит соединение, пока ролик на экране')
})

test('ушедший с экрана ролик отдаёт соединение сразу', () => {
  // Культинг размонтирует фигуру за краем экрана — поток обязан закрыться с ней.
  assert.match(hook, /el\.removeAttribute\('src'\)/)
  assert.match(hook, /el\.load\(\)/)
})

test('готовый paused decoder возвращается из маленького пула, но незавершённый поток не прячется', () => {
  assert.match(source, /VIDEO_ELEMENT_POOL_LIMIT = 8/)
  assert.match(hook, /releaseVideo\(src, el\)/)
  assert.match(hook, /el\.readyState < 2/)
})

// @ts-expect-error Node test runtime
import test from 'node:test'
// @ts-expect-error Node test runtime
import assert from 'node:assert/strict'
import { assistantInputHeight, isReadingLatest } from './assistantReading'
import { assistantPromptVariants } from './assistantPromptVariants'
import { minutesSince } from './taskTime'

test('старые варианты вставляются отдельно без перевода и пояснений', () => {
  const result = assistantPromptVariants('### Вариант 1\n> **Prompt:** A portrait. *(Перевод: Портрет.)*\n---\n### Вариант 2\n> **Prompt:** A landscape. *(Перевод: Пейзаж.)*')
  assert.deepEqual(result.map((item) => item.prompt), ['A portrait.', 'A landscape.'])
  assert.deepEqual(assistantPromptVariants('Пришлите изображение.'), [])
})

test('неизвестное время задачи не становится временем Unix epoch', () => {
  assert.equal(minutesSince(0), 'time unknown')
  assert.equal(minutesSince(Number.NaN), 'time unknown')
  assert.equal(minutesSince(Date.now()), 'just now')
})

test('увеличение панели отдаёт большую часть нового места истории', () => {
  const small = assistantInputHeight(240)
  const large = assistantInputHeight(480)
  assert.ok(large - small < (480 - 240) / 2)
  assert.ok(small >= 44)
  assert.ok(large <= 160)
})
test('автопрокрутка разрешена только у нижнего края, включая короткий ответ', () => {
  assert.equal(isReadingLatest({ scrollTop: 100, clientHeight: 200, scrollHeight: 800 }), false)
  assert.equal(isReadingLatest({ scrollTop: 580, clientHeight: 200, scrollHeight: 800 }), true)
  assert.equal(isReadingLatest({ scrollTop: 0, clientHeight: 200, scrollHeight: 100 }), true)
})

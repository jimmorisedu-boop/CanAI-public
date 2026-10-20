import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeJsonStringBody, findEnvelope, salvageReply } from './promptChatEnvelope.js'
import { parsePromptChatResponse } from './promptChatResponse.js'

// ⚠️ Каждый случай здесь — настоящая форма ответа модели, на которой человек
// видел в ленте машинный JSON вместо ответа (жалобы 09.09.2026 и 20.09.2026,
// оба раза со снимком). Заставить модель молчать вокруг конверта нечем: у
// нашего маршрута LLM режима строгого JSON нет.

const FENCE = '`'.repeat(3)

function envelope(reply: string, prompts: unknown[] = []): string {
  return JSON.stringify({ reply, prompts })
}

test('конверт находится, когда модель написала вокруг него по-человечески', () => {
  const raw = `Конечно!\n${FENCE}json\n${envelope('Вот как это сделать')}\n${FENCE}`
  assert.equal(parsePromptChatResponse(raw).reply, 'Вот как это сделать')
})

test('конверт находится, когда после него дописали фразу', () => {
  const raw = `${envelope('Готово')}\n\nНадеюсь, помог.`
  assert.equal(parsePromptChatResponse(raw).reply, 'Готово')
})

test('кнопки не теряются, когда конверт лежал внутри текста', () => {
  const prompts = [{ title: 'Портрет', prompt: 'подробный промпт про портрет' }]
  const raw = `Держи:\n${FENCE}json\n${envelope('Вот два варианта', prompts)}\n${FENCE}\nУдачи!`
  const parsed = parsePromptChatResponse(raw)
  assert.equal(parsed.prompts.length, 1)
  assert.equal(parsed.prompts[0].title, 'Портрет')
})

test('фигурные скобки внутри промпта не сбивают границы конверта', () => {
  // Границы считаем скобками с учётом строк: жадный разбор отхватил бы лишнее.
  const raw = `Вот:\n${envelope('Пример записи {"кадр":"крупный"} внутри ответа')}`
  assert.equal(
    parsePromptChatResponse(raw).reply,
    'Пример записи {"кадр":"крупный"} внутри ответа',
  )
})

test('посторонний JSON перед конвертом не принимается за ответ', () => {
  const raw = `Схема такая: {"kind":"image","size":1024}\n${envelope('А вот и ответ')}`
  assert.equal(parsePromptChatResponse(raw).reply, 'А вот и ответ')
})

test('оборванный ответ показывается текстом, а не машинным обрезком', () => {
  // Разговор упёрся в потолок токенов: JSON не закрыт, но ответ оплачен.
  const raw = '{"reply":"Понял: нужно убрать фон и'
  const parsed = parsePromptChatResponse(raw)
  assert.equal(parsed.reply, 'Понял: нужно убрать фон и')
  assert.ok(!parsed.reply.includes('"reply"'), 'машинный ключ в ленту не попадает')
})

test('в оборванном ответе разворачиваются переводы строк и кавычки', () => {
  const raw = '{"reply":"Первая строка\\nи \\"вторая\\" — обрыв'
  assert.equal(salvageReply(raw), 'Первая строка\nи "вторая" — обрыв')
})

test('обычный текст со словом reply не считают оборванным конвертом', () => {
  // ⚠️ Признак узкий нарочно: ошибись разбор, человек увидел бы обрезок ответа.
  const raw = 'Поле reply в ответе модели — это просто текст.'
  assert.equal(salvageReply(raw), null)
  assert.equal(parsePromptChatResponse(raw).reply, raw)
})

test('обычный ответ без конверта остаётся собой', () => {
  assert.equal(findEnvelope('Привет! Чем помочь?'), null)
  assert.equal(parsePromptChatResponse('Привет! Чем помочь?').reply, 'Привет! Чем помочь?')
})

test('незакрытый экранирующий знак в конце просто отбрасывается', () => {
  assert.equal(decodeJsonStringBody('конец обрыва\\'), 'конец обрыва')
  assert.equal(decodeJsonStringBody('\\u0410\\u0411'), 'АБ')
})

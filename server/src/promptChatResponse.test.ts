import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePromptChatResponse } from './promptChatResponse.js'
import { SALVAGE_MAX } from './promptChatSalvage.js'

test('разбирает structured и fenced JSON на сервере', () => {
  const raw = JSON.stringify({
    reply: 'Готово',
    prompts: [{ title: 'Постер', prompt: 'Сделай постер' }],
    referenceNotes: ['Первый референс задаёт цвет'],
  })
  assert.deepEqual(parsePromptChatResponse(`\`\`\`json\n${raw}\n\`\`\``, true), {
    reply: 'Готово',
    prompts: [{ title: 'Постер', prompt: 'Сделай постер' }],
    referenceNotes: ['Первый референс задаёт цвет'],
  })
})

// ⚠️ Тест переписан вместе с поведением: раньше он закреплял ровно тот баг,
// из-за которого на «сколько будет два плюс два» приходила карточка
// «Готовый промпт». Промпты предлагаются только когда о них просят.
test('обычный текст остаётся ответом и не выдаётся за готовый промпт', () => {
  assert.deepEqual(parsePromptChatResponse('Сделай лаконичный постер'), {
    reply: 'Сделай лаконичный постер',
    prompts: [],
    referenceNotes: [],
  })
})

test('пустой список промптов — это ответ модели, а не пробел для заполнения', () => {
  const parsed = parsePromptChatResponse(JSON.stringify({ reply: 'Два плюс два будет четыре.', prompts: [] }))
  assert.equal(parsed.reply, 'Два плюс два будет четыре.')
  assert.deepEqual(parsed.prompts, [])
})

test('когда промпты просили — они доходят до ленты', () => {
  const parsed = parsePromptChatResponse(JSON.stringify({
    reply: 'Вот варианты',
    prompts: [{ title: 'Постер', prompt: 'минималистичный постер, много воздуха' }],
  }))
  assert.equal(parsed.prompts.length, 1)
  assert.equal(parsed.prompts[0].title, 'Постер')
})

test('не принимает referenceNotes без вложений или с inline-data', () => {
  const base = {
    reply: 'Ответ',
    prompts: [],
    referenceNotes: ['data:image/png;base64,AAAA'],
  }
  assert.deepEqual(parsePromptChatResponse(JSON.stringify(base), true).referenceNotes, [])
  assert.deepEqual(
    parsePromptChatResponse(JSON.stringify({ ...base, referenceNotes: ['Полезная заметка'] }), false).referenceNotes,
    [],
  )
})

/**
 * ⚠️ Прежний потолок промптов был 4, и этот тест его закреплял — ровно тот
 * случай, когда тест защищает ошибку: на просьбу «напиши 5 промптов» пятый
 * молча пропадал по дороге, и карточки не сходились с тем, что человек
 * просил. Правило теперь простое: сколько попросили — столько и показываем.
 * Разумный предел остаётся, чтобы лента не превращалась в простыню карточек,
 * но он ВЫШЕ любой осмысленной просьбы.
 */
test('показывает столько промптов, сколько попросили, и режет заметки', () => {
  const parsed = parsePromptChatResponse(JSON.stringify({
    reply: 'Ответ',
    prompts: Array.from({ length: 6 }, (_, index) => ({ title: `P${index}`, prompt: `Текст ${index}` })),
    referenceNotes: Array.from({ length: 10 }, (_, index) => `Заметка ${index}${'x'.repeat(300)}`),
  }), true)
  assert.equal(parsed.prompts.length, 6)
  assert.equal(parsed.referenceNotes.length, 8)
  assert.ok(parsed.referenceNotes.every((note) => note.length <= 200))
})

test('потолок промптов остаётся, но он выше любой осмысленной просьбы', () => {
  const parsed = parsePromptChatResponse(JSON.stringify({
    reply: 'Ответ',
    prompts: Array.from({ length: 30 }, (_, index) => ({ title: `P${index}`, prompt: `Текст ${index}` })),
  }))
  assert.equal(parsed.prompts.length, SALVAGE_MAX)
})

/**
 * ⚠️ Ответ опознаётся по ОДНОМУ признаку — строке `reply`. Раньше требовался
 * ещё и массив `prompts`, и это противоречило собственной инструкции: мы просим
 * модель не предлагать промпты, пока о них не попросили, — она слушается и ключ
 * не пишет вовсе. Разбор объявлял такой ответ чужим и показывал человеку СЫРОЙ
 * JSON прямо в ленте (жалоба 09.09.2026 «в помощнике интерфейс изменился
 * вдруг», на снимке видно «{"reply":"Понял: нужно убрать…»).
 */
test('ответ без списка промптов остаётся ответом, а не сырым JSON', () => {
  const parsed = parsePromptChatResponse('{"reply":"Понял: уберу шумы с текста"}')
  assert.equal(parsed.reply, 'Понял: уберу шумы с текста')
  assert.deepEqual(parsed.prompts, [])
  assert.ok(!parsed.reply.includes('{'), 'человеку не показывают конверт')

  // И в огранке ```json — тоже.
  const fenced = parsePromptChatResponse('```json\n{"reply":"Готово"}\n```')
  assert.equal(fenced.reply, 'Готово')
})

/** А вот чужой JSON без `reply` — по-прежнему просто текст. */
test('посторонний JSON не выдаём за ответ помощника', () => {
  const parsed = parsePromptChatResponse('{"items":[1,2,3]}')
  assert.equal(parsed.reply, '{"items":[1,2,3]}')
  assert.deepEqual(parsed.prompts, [])
})

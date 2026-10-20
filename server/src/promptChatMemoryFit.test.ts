import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_ENTRIES, MAX_ENTRY_CHARS, MAX_MEMORY_CHARS, fitEntry, fitMemory } from './promptChatMemoryFit.js'
import { parseCompactionResponse } from './promptChatCompaction.js'
import type { PromptChatMemory } from './promptChatTypes.js'

const empty: PromptChatMemory = {
  goal: '', facts: [], decisions: [], constraints: [],
  preferences: [], referenceNotes: [], openQuestions: [], chronology: '',
}

test('длинная строка подрезается, а не отменяет всё', () => {
  const long = 'ф'.repeat(500)
  const fitted = fitEntry(long)
  assert.equal(fitted.length, MAX_ENTRY_CHARS)
  assert.ok(fitted.endsWith('…'), 'обрыв должен быть виден')
  assert.equal(fitEntry('короткая'), 'короткая')
})

/**
 * ⚠️ Это и есть та самая жалоба. В журнале тестировщика (20.09.2026) одно
 * сообщение не может доставиться 62 раза за десять дней: «facts должен быть
 * строкой не длиннее 200 символов». Пересжатие истории — отдельный ПЛАТНЫЙ
 * запрос, и он выбрасывался целиком из-за одной длинной строки; счётчик
 * попыток живёт в памяти, поэтому каждый перезапуск начинал заново.
 */
test('оплаченная выжимка доезжает, даже если модель написала длинно', () => {
  const memory = parseCompactionResponse(JSON.stringify({
    goal: 'цель',
    facts: ['ф'.repeat(400), 'короткий факт'],
    decisions: [{ text: 'р'.repeat(300), reason: 'потому что' }],
    constraints: [], preferences: [], referenceNotes: [], openQuestions: [],
    chronology: 'ход разговора',
  }))
  assert.equal(memory.facts.length, 2)
  assert.equal(memory.facts[0].length, MAX_ENTRY_CHARS)
  assert.equal(memory.facts[1], 'короткий факт')
  assert.equal(memory.decisions[0].text.length, MAX_ENTRY_CHARS)
})

test('лишние записи снимаются с хвоста самого длинного списка', () => {
  const fitted = fitMemory({
    ...empty,
    facts: Array.from({ length: 100 }, (_, i) => `факт ${i}`),
    constraints: ['одно ограничение'],
  })
  const total = fitted.facts.length + fitted.decisions.length + fitted.constraints.length
    + fitted.preferences.length + fitted.referenceNotes.length + fitted.openQuestions.length
  assert.ok(total <= MAX_ENTRIES, `записей ${total}`)
  // ⚠️ Важное модель кладёт первым — обрываем хвост, а не начало.
  assert.equal(fitted.facts[0], 'факт 0')
  assert.equal(fitted.constraints[0], 'одно ограничение', 'короткий список не страдает за длинный')
})

test('память целиком укладывается в предел', () => {
  const fitted = fitMemory({
    ...empty,
    goal: 'цель',
    facts: Array.from({ length: 79 }, () => 'ф'.repeat(MAX_ENTRY_CHARS)),
    chronology: 'х'.repeat(20_000),
  })
  assert.ok(JSON.stringify(fitted).length <= MAX_MEMORY_CHARS, JSON.stringify(fitted).length.toString())
})

/**
 * ⚠️ Размер подгоняем, а СТРУКТУРУ по-прежнему проверяем строго: не тот тип —
 * это сломанный ответ, и принимать его нельзя.
 */
test('сломанную форму ответа по-прежнему не принимаем', () => {
  assert.throws(() => parseCompactionResponse('не json'), /only JSON/u)
  assert.throws(() => parseCompactionResponse(JSON.stringify({ goal: 5 })), /goal must be string/u)
  assert.throws(
    () => parseCompactionResponse(JSON.stringify({ goal: '', chronology: '', facts: 'не массив' })),
    /facts must be array/u,
  )
  // ⚠️ Негодное РЕШЕНИЕ внутри массива теперь пропускается, а не хоронит всю
  // выжимку (см. следующий тест). Здесь проверяем только КОНТЕЙНЕРЫ.
  assert.throws(
    () => parseCompactionResponse(JSON.stringify({
      goal: '', chronology: '', facts: [], constraints: [], preferences: [],
      referenceNotes: [], openQuestions: [], decisions: 'не массив',
    })),
    /decisions must be array/u,
  )
})

/**
 * ⚠️ Форму КОНТЕЙНЕРА проверяем строго, а негодную ЗАПИСЬ внутри пропускаем.
 * После починки размеров у тестировщика та же доставка застряла снова — уже на
 * «facts должен быть строкой»: в массиве среди строк попался не текст. Хоронить
 * из-за одной плохой записи всю оплаченную выжимку нельзя.
 */
test('негодная запись пропускается, а выжимка доезжает', () => {
  const memory = parseCompactionResponse(JSON.stringify({
    goal: 'цель',
    facts: ['годный факт', { текст: 'объект вместо строки' }, null, 42, 'второй годный'],
    decisions: [{ text: 'решение', reason: 'причина' }, { text: 5, reason: 'кривое' }, null],
    constraints: [], preferences: [], referenceNotes: [], openQuestions: [],
    chronology: 'ход разговора',
  }))
  assert.deepEqual(memory.facts, ['годный факт', 'второй годный'])
  assert.equal(memory.decisions.length, 1)
  assert.equal(memory.decisions[0].text, 'решение')
})

/** ⚠️ А сломанный КОНТЕЙНЕР — по-прежнему отказ: из него нечего собирать. */
test('не массив вместо списка — по-прежнему отказ', () => {
  assert.throws(
    () => parseCompactionResponse(JSON.stringify({ goal: '', chronology: '', facts: 'строка вместо массива' })),
    /facts must be array/u,
  )
})

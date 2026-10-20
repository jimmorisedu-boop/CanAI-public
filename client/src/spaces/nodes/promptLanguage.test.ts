import assert from 'node:assert/strict'
import test from 'node:test'
import { englishPromptWarning, looksNonEnglish } from './promptLanguage'

test('предупреждаем только там, где ограничение есть', () => {
  const lyria = { englishPromptOnly: true, name: 'Lyria 2 — музыка' }
  const обычная = { name: 'Grok Image' }
  assert.match(englishPromptWarning(lyria, 'спокойное пианино') ?? '', /only in English/)
  assert.equal(englishPromptWarning(lyria, 'calm solo piano'), null)
  assert.equal(englishPromptWarning(обычная, 'спокойное пианино'), null)
  assert.equal(englishPromptWarning(null, 'спокойное пианино'), null)
})

test('пустой промпт не повод пугать', () => {
  const lyria = { englishPromptOnly: true, name: 'Lyria' }
  assert.equal(englishPromptWarning(lyria, ''), null)
  assert.equal(englishPromptWarning(lyria, '   '), null)
})

test('кириллица ловится и в смешанном тексте', () => {
  assert.equal(looksNonEnglish('lofi гитара'), true)
  assert.equal(looksNonEnglish('ЁЖИК'), true)
  assert.equal(looksNonEnglish('lofi guitar, 90 bpm'), false)
})

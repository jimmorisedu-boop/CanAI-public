import assert from 'node:assert/strict'
import test from 'node:test'
import { refsForAssistantMessage } from './assistantAsk.js'
import type { PromptChatMessage } from './promptChatTypes.js'

// ⚠️ Кнопка «В строку» живёт в сообщении ПОМОЩНИКА, а вложения замораживаются
// в сообщение ПОЛЬЗОВАТЕЛЯ (см. askAssistant). Пока карточка промпта брала
// вложения у себя, она получала пустой список — и «В строку» молча не
// переносила ни одного референса. Человек видел либо своё старое выделение
// (в другом порядке — отсюда «поменялись местами»), либо ничего, если
// выделение уже снял (жалоба 27.08.2026).

const attach = (shapeId: string) => ({
  shapeId, kind: 'image' as const, label: shapeId, src: `/media/${shapeId}.png`,
})

const user = (id: string, shapeIds: string[]): PromptChatMessage => ({
  id, role: 'user', text: 'вопрос', createdAt: 1, attachments: shapeIds.map(attach),
})

const assistant = (id: string, requestMessageId?: string): PromptChatMessage => ({
  id, role: 'assistant', text: '', createdAt: 2, reply: 'ответ', requestMessageId,
})

test('референсы берутся у вопроса, на который отвечают', () => {
  const messages = [user('q1', ['a', 'b']), assistant('a1', 'q1')]
  const refs = refsForAssistantMessage(messages, messages[1]!)
  assert.deepEqual(refs.map((r) => r.shapeId), ['a', 'b'], 'до починки здесь был пустой список')
})

test('порядок вложений вопроса сохраняется', () => {
  const messages = [user('q1', ['второй', 'первый']), assistant('a1', 'q1')]
  assert.deepEqual(
    refsForAssistantMessage(messages, messages[1]!).map((r) => r.shapeId),
    ['второй', 'первый'],
    'нумерация @1/@2 в промпте считана с этого порядка — менять его нельзя',
  )
})

test('берётся ИМЕННО свой вопрос, а не последний в ленте', () => {
  const messages = [
    user('q1', ['ранний']), assistant('a1', 'q1'),
    user('q2', ['поздний']), assistant('a2', 'q2'),
  ]
  assert.deepEqual(refsForAssistantMessage(messages, messages[1]!).map((r) => r.shapeId), ['ранний'])
  assert.deepEqual(refsForAssistantMessage(messages, messages[3]!).map((r) => r.shapeId), ['поздний'])
})

// Старые истории писались без связи ответа с вопросом — там берём ближайший
// вопрос выше, иначе кнопка перестала бы работать на всём, что уже накоплено.
test('без requestMessageId берётся ближайший вопрос выше', () => {
  const messages = [
    user('q1', ['ранний']), assistant('a1'),
    user('q2', ['поздний']), assistant('a2'),
  ]
  assert.deepEqual(refsForAssistantMessage(messages, messages[3]!).map((r) => r.shapeId), ['поздний'])
})

test('служебное вложение ответа не заменяет все референсы вопроса после поштучного добавления', () => {
  const withLastRef: PromptChatMessage = {
    ...assistant('a1', 'q1'),
    attachments: [attach('второй')],
  }
  const messages = [user('q1', ['первый', 'второй']), withLastRef]
  assert.deepEqual(
    refsForAssistantMessage(messages, withLastRef).map((r) => r.shapeId),
    ['первый', 'второй'],
  )
})

test('собственные вложения ответа остаются запасным путём для истории без вопроса', () => {
  const own: PromptChatMessage = { ...assistant('a1', 'missing'), attachments: [attach('свой')] }
  assert.deepEqual(refsForAssistantMessage([own], own).map((r) => r.shapeId), ['свой'])
})

test('вопроса без вложений и пустой ленты хватает, чтобы не упасть', () => {
  assert.deepEqual(refsForAssistantMessage([], assistant('a1', 'q1')), [])
  const messages = [user('q1', []), assistant('a1', 'q1')]
  assert.deepEqual(refsForAssistantMessage(messages, messages[1]!), [])
})

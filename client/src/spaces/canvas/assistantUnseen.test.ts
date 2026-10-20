import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assistantSignal,
  assistantSignalLabel,
  latestAssistantId,
} from './assistantUnseen'
import type { PromptChatMessage } from './promptChatTypes'

function assistant(
  id: string,
  status: PromptChatMessage['status'],
  extra: Partial<PromptChatMessage> = {},
): PromptChatMessage {
  return { id, role: 'assistant', text: '', createdAt: 1, status, ...extra }
}

test('пока помощник думает, вкладка показывает «думает»', () => {
  const messages = [assistant('a', 'running')]
  assert.equal(assistantSignal(messages, null, false), 'working')
  assert.equal(assistantSignalLabel('working'), 'thinks')
})

test('готовый ответ подсвечивает вкладку, пока его не открыли', () => {
  const messages = [assistant('a', 'done', { reply: 'Вот промпт' })]
  assert.equal(assistantSignal(messages, null, false), 'ready')
  // открыли вкладку — сигнал гаснет
  assert.equal(assistantSignal(messages, null, true), 'none')
  // закрыли, отметив просмотренным — снова тихо
  assert.equal(assistantSignal(messages, 'a', false), 'none')
})

test('следующий ответ снова зажигает сигнал, даже если прошлый был просмотрен', () => {
  const messages = [
    assistant('a', 'done', { reply: 'первый' }),
    assistant('b', 'done', { reply: 'второй' }),
  ]
  assert.equal(assistantSignal(messages, 'a', false), 'ready')
  assert.equal(assistantSignal(messages, 'b', false), 'none')
})

test('сорвавшийся ответ помечается ошибкой, а не тишиной', () => {
  assert.equal(assistantSignal([assistant('a', 'error', { error: 'нет связи' })], null, false), 'failed')
  assert.equal(assistantSignal([assistant('a', 'cancelled')], null, false), 'failed')
  assert.equal(assistantSignalLabel('failed'), 'error')
})

test('работающий помощник виден даже с открытой вкладкой', () => {
  // «думает» — это не непрочитанное уведомление, а состояние процесса
  assert.equal(assistantSignal([assistant('a', 'running')], 'a', true), 'working')
})

test('пустой ответ и отсутствие ответов сигнала не дают', () => {
  assert.equal(assistantSignal([], null, false), 'none')
  assert.equal(assistantSignal([assistant('a', 'done')], null, false), 'none')
  assert.equal(assistantSignalLabel('none'), null)
})

test('последний ответ помощника определяется для отметки «просмотрено»', () => {
  assert.equal(latestAssistantId([]), null)
  assert.equal(
    latestAssistantId([
      assistant('a', 'done'),
      { id: 'u', role: 'user', text: 'вопрос', createdAt: 2 },
      assistant('b', 'done'),
    ]),
    'b',
  )
})

test('ещё не готовый ответ просмотренным не считается', () => {
  // иначе отметка в момент отправки погасила бы будущий сигнал «ответил»:
  // id у активного сообщения и у готового ответа один и тот же
  assert.equal(latestAssistantId([assistant('a', 'running')]), null)
  assert.equal(latestAssistantId([assistant('a', 'submitting')]), null)
  assert.equal(latestAssistantId([assistant('a', 'queued')]), null)

  // полный сценарий: спросил при открытой вкладке → ушёл в промпт → ответ пришёл
  const working = [assistant('a', 'running')]
  const seen = latestAssistantId(working) // null, потому что ответа ещё нет
  const answered = [assistant('a', 'done', { reply: 'готово' })]
  assert.equal(assistantSignal(answered, seen, false), 'ready')
})

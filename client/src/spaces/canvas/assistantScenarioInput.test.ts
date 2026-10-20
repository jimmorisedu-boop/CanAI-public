// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { assistantScenarioInput } from './assistantScenarioInput'
import type { SelectionRef } from './konva/selection'
import type { PromptChatMessage } from './promptChatTypes'

const img = (id: string): SelectionRef => ({
  shapeId: id,
  kind: 'image',
  label: id,
  src: `/media/${id}.png`,
})

const message = (
  role: 'user' | 'assistant',
  text: string,
  attachments?: PromptChatMessage['attachments'],
): PromptChatMessage => ({
  id: `${role}-${text}`,
  role,
  text,
  createdAt: 1,
  attachments,
})

test('напечатанный текст идёт референсом и записывается входом сценария', () => {
  const result = assistantScenarioInput({
    typedPrompt: '  сделай серию  ',
    composerRefs: [img('a')],
    messages: [],
  })
  assert.deepEqual(result.record, { text: 'сделай серию', refs: [img('a')] })
  assert.deepEqual(result.runRefs.map((ref) => ref.shapeId), ['a', 'prompt-input-text'])
  assert.equal(result.clearComposer, true)
})

// Кнопка на пустом поле обязана иметь материал: иначе цепочка запускается ни
// на чём и первый же шаг просит LLM обработать пустоту.
test('пустое поле подхватывает последнее сообщение пользователя', () => {
  const result = assistantScenarioInput({
    typedPrompt: '',
    composerRefs: [],
    messages: [
      message('user', 'первое'),
      message('assistant', 'ответ'),
      message('user', 'последнее'),
      message('assistant', 'ещё ответ'),
    ],
  })
  assert.equal(result.record, null, 'записывать нечего — материал уже в ленте')
  assert.deepEqual(result.runRefs.map((ref) => ref.text), ['последнее'])
  assert.equal(result.clearComposer, false)
})

test('вложения последнего сообщения едут вместе с его текстом', () => {
  const result = assistantScenarioInput({
    typedPrompt: '',
    composerRefs: [],
    messages: [
      message('user', 'вот картинки', [
        { shapeId: 'p1', kind: 'image', label: 'раз', src: '/media/1.png' },
        { shapeId: 'p2', kind: 'image', label: 'два', src: '/media/2.png' },
      ]),
    ],
  })
  assert.deepEqual(result.runRefs.map((ref) => ref.shapeId), [
    'last-user-msg-text',
    'p1',
    'p2',
  ])
})

test('пустой разговор и пустое поле дают только чипы', () => {
  const result = assistantScenarioInput({
    typedPrompt: '',
    composerRefs: [img('a')],
    messages: [message('assistant', 'привет')],
  })
  assert.deepEqual(result.runRefs.map((ref) => ref.shapeId), ['a'])
})

// Референсы замораживаются копией: последующее изменение выделения на канвасе
// не должно менять уже запущенный прогон.
test('референсы копируются, а не переиспользуются', () => {
  const source = img('a')
  const result = assistantScenarioInput({
    typedPrompt: 'к',
    composerRefs: [source],
    messages: [],
  })
  assert.notEqual(result.record?.refs[0], source)
  assert.deepEqual(result.record?.refs[0], source)
})

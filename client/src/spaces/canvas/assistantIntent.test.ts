import assert from 'node:assert/strict'
import test from 'node:test'
import { detectGenerationIntent } from './assistantIntent'
import type { PromptChatMessage } from './promptChatTypes'

test('detectGenerationIntent: detects direct image generation order', () => {
  const messages: PromptChatMessage[] = [
    { id: '1', role: 'user', text: 'сделай 10 фото киберпанк города', createdAt: 100 },
    {
      id: '2',
      role: 'assistant',
      text: '',
      reply: 'Запускаю генерацию!',
      prompts: [
        { title: 'Вариант 1', prompt: 'киберпанк 1' },
        { title: 'Вариант 2', prompt: 'киберпанк 2' },
      ],
      createdAt: 200,
    },
  ]

  const result = detectGenerationIntent(messages, 1)
  assert.equal(result.isGenerationOrder, true)
  assert.equal(result.mediaKind, 'image')
  assert.equal(result.requestedCount, 10)
})

test('detectGenerationIntent: ignores purely prompt-writing requests', () => {
  const messages: PromptChatMessage[] = [
    { id: '1', role: 'user', text: 'напиши мне 5 промптов для фото кота', createdAt: 100 },
    {
      id: '2',
      role: 'assistant',
      text: '',
      reply: 'Вот варианты:',
      prompts: [{ title: 'Кот 1', prompt: 'кот' }],
      createdAt: 200,
    },
  ]

  const result = detectGenerationIntent(messages, 1)
  assert.equal(result.isGenerationOrder, false)
})

test('detectGenerationIntent: detects generation order across clarification turns', () => {
  const messages: PromptChatMessage[] = [
    { id: '1', role: 'user', text: 'сделай 4 видео морского заката', createdAt: 100 },
    {
      id: '2',
      role: 'assistant',
      text: '',
      reply: 'В каком стиле и пропорциях?',
      prompts: [], // уточнил, промпты ещё не дал
      createdAt: 200,
    },
    { id: '3', role: 'user', text: '16:9, реализм', createdAt: 300 },
    {
      id: '4',
      role: 'assistant',
      text: '',
      reply: 'Отлично, создаю 4 видео на холсте!',
      prompts: [
        { title: 'Закат 1', prompt: 'закат 1' },
        { title: 'Закат 2', prompt: 'закат 2' },
      ],
      createdAt: 400,
    },
  ]

  const turn2Result = detectGenerationIntent(messages, 1)
  assert.equal(turn2Result.isGenerationOrder, false, 'Turn 2 had empty prompts, so no execution')

  const turn4Result = detectGenerationIntent(messages, 3)
  assert.equal(turn4Result.isGenerationOrder, true, 'Turn 4 fulfills original generation order')
  assert.equal(turn4Result.mediaKind, 'video')
  assert.equal(turn4Result.requestedCount, 4)
})

test('detectGenerationIntent: старый приказ в истории не даёт разрешения на новый запуск', () => {
  const messages: PromptChatMessage[] = [
    { id: '1', role: 'user', text: 'сделай 4 фото льва', createdAt: 100 },
    {
      id: '2',
      role: 'assistant',
      text: '',
      reply: 'Готово, 4 фото льва!',
      prompts: Array.from({ length: 4 }, (_, i) => ({ title: `Лев ${i + 1}`, prompt: `лев ${i + 1}` })),
      createdAt: 200,
    },
    { id: '3', role: 'user', text: 'а почему лев смотрит в камеру?', createdAt: 300 },
    {
      id: '4',
      role: 'assistant',
      text: '',
      reply: 'Обычно лев смотрит в камеру, когда…',
      // помощник что-то досочинил в качестве ответа, но это НЕ новый заказ на генерацию
      prompts: [{ title: 'Вариант', prompt: 'льв смотрит в камеру' }],
      createdAt: 400,
    },
  ]

  const result = detectGenerationIntent(messages, 3)
  assert.equal(
    result.isGenerationOrder,
    false,
    'Старый приказ «сделай 4 фото» не должен разрешать автоматический запуск нового процесса',
  )
})

test('detectGenerationIntent: новый явный заказ в новом витке запускается, а старый не подмешивается', () => {
  const messages: PromptChatMessage[] = [
    { id: '1', role: 'user', text: 'сделай 4 фото льва', createdAt: 100 },
    {
      id: '2',
      role: 'assistant',
      text: '',
      reply: 'Готово, 4 фото льва!',
      prompts: Array.from({ length: 4 }, (_, i) => ({ title: `Лев ${i + 1}`, prompt: `лев ${i + 1}` })),
      createdAt: 200,
    },
    { id: '3', role: 'user', text: 'создай 6 видео заката', createdAt: 300 },
    {
      id: '4',
      role: 'assistant',
      text: '',
      reply: 'Запускаю 6 видео заката!',
      prompts: Array.from({ length: 6 }, (_, i) => ({ title: `Закат ${i + 1}`, prompt: `закат ${i + 1}` })),
      createdAt: 400,
    },
  ]

  const result = detectGenerationIntent(messages, 3)
  assert.equal(result.isGenerationOrder, true, 'Новый виток явно просит генерацию')
  assert.equal(result.mediaKind, 'video', 'Тип берётся из нового запроса, а не из старого (фото)')
  assert.equal(result.requestedCount, 6, 'Количество берётся из нового запроса, а не из старого (4)')
})

test('detectGenerationIntent: English prompt-writing requests do not start generation', () => {
  for (const text of [
    'Make a prompt for a lake photo',
    'Create an image prompt',
    'Generate a prompt',
    'Generate 3 video prompts',
    'Create a video prompt',
  ]) {
    const result = detectGenerationIntent([
      { id: '1', role: 'user', text, createdAt: 100 },
      { id: '2', role: 'assistant', text: '', reply: 'Here is a prompt.', prompts: [{ title: 'Prompt', prompt: 'lake' }], createdAt: 200 },
    ], 1)
    assert.equal(result.isGenerationOrder, false, text)
  }
})

test('detectGenerationIntent: Russian prompt counts stay text-only while media counts generate', () => {
  const promptOnly = detectGenerationIntent([
    { id: '1', role: 'user', text: 'Сделай 3 промпта для видео', createdAt: 100 },
    { id: '2', role: 'assistant', text: '', reply: 'Вот три промпта.', prompts: [{ title: 'Промпт', prompt: 'lake' }], createdAt: 200 },
  ], 1)
  assert.equal(promptOnly.isGenerationOrder, false)

  const media = detectGenerationIntent([
    { id: '1', role: 'user', text: 'Сделай 3 видео', createdAt: 100 },
    { id: '2', role: 'assistant', text: '', reply: 'Запускаю.', prompts: [{ title: 'Видео', prompt: 'lake' }], createdAt: 200 },
  ], 1)
  assert.equal(media.isGenerationOrder, true)
  assert.equal(media.requestedCount, 3)
})

test('detectGenerationIntent: English media generation and prompt references stay distinct', () => {
  const generation = detectGenerationIntent([
    { id: '1', role: 'user', text: 'Create an image from this prompt', createdAt: 100 },
    { id: '2', role: 'assistant', text: '', reply: 'Generating.', prompts: [{ title: 'Image', prompt: 'lake' }], createdAt: 200 },
  ], 1)
  assert.equal(generation.isGenerationOrder, true)

  const edit = detectGenerationIntent([
    { id: '1', role: 'user', text: 'Edit my prompt and instructions', attachments: [{ kind: 'image', shapeId: 'ref-1', label: 'ref' }], createdAt: 100 },
    { id: '2', role: 'assistant', text: '', reply: 'Updated.', prompts: [{ title: 'Prompt', prompt: 'lake' }], createdAt: 200 },
  ], 1)
  assert.equal(edit.isGenerationOrder, false)

  const change = detectGenerationIntent([
    { id: '1', role: 'user', text: 'Change my prompt settings', attachments: [{ kind: 'image', shapeId: 'ref-2', label: 'ref' }], createdAt: 100 },
    { id: '2', role: 'assistant', text: '', reply: 'Updated.', prompts: [{ title: 'Prompt', prompt: 'lake' }], createdAt: 200 },
  ], 1)
  assert.equal(change.isGenerationOrder, false)
})

test('detectGenerationIntent: draw and change cover English media actions', () => {
  const draw = detectGenerationIntent([
    { id: '1', role: 'user', text: 'Draw a lake at sunset', createdAt: 100 },
    { id: '2', role: 'assistant', text: '', reply: 'Generating.', prompts: [{ title: 'Image', prompt: 'lake' }], createdAt: 200 },
  ], 1)
  assert.equal(draw.isGenerationOrder, true)

  const mediaChange = detectGenerationIntent([
    { id: '1', role: 'user', text: 'Change this photo to a warm palette', attachments: [{ kind: 'image', shapeId: 'ref-1', label: 'ref' }], createdAt: 100 },
    { id: '2', role: 'assistant', text: '', reply: 'Generating.', prompts: [{ title: 'Image', prompt: 'lake' }], createdAt: 200 },
  ], 1)
  assert.equal(mediaChange.isGenerationOrder, true)
})

test('detectGenerationIntent: English plural counts are preserved', () => {
  const result = detectGenerationIntent([
    { id: '1', role: 'user', text: 'Generate 3 photos of a lake', createdAt: 100 },
    { id: '2', role: 'assistant', text: '', reply: 'Generating.', prompts: [{ title: 'Photo', prompt: 'lake' }], createdAt: 200 },
  ], 1)
  assert.equal(result.requestedCount, 3)
})

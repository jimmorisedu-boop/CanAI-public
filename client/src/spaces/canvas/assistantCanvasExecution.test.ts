import assert from 'node:assert/strict'
import test from 'node:test'
import { detectGenerationIntent } from './assistantIntent'
import { claimAssistantDispatch, collectHistoricalAssistantMessageIds } from './AssistantShelf'
import type { PromptChatMessage } from './promptChatTypes'
import { assistantAggregateEstimatedCost, planAssistantCanvasLaunch } from './assistantCanvasLaunch'
import { dockState, imageRef, videoRef, LOCAL_DOCK_MODELS } from './localDockCatalogTestKit'
import { refsForAssistantMessage } from './assistantAsk'
import { shouldAskLocalCostConfirmation } from './generationEstimate'

test('detectGenerationIntent: identifies "сделай 10 фото" and extracts mediaKind image and count 10', () => {
  const messages: PromptChatMessage[] = [
    { id: 'u1', role: 'user', text: 'сделай 10 фото в стиле киберпанк', createdAt: 1000 },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      reply: 'Готово! Сгенерировал промпты для холста.',
      prompts: Array.from({ length: 10 }, (_, i) => ({
        title: `Фото ${i + 1}`,
        prompt: `Киберпанк фото ${i + 1}`,
      })),
      createdAt: 2000,
    },
  ]

  const intent = detectGenerationIntent(messages, 1)
  assert.equal(intent.isGenerationOrder, true)
  assert.equal(intent.mediaKind, 'image')
  assert.equal(intent.requestedCount, 10)
})

test('detectGenerationIntent: identifies "сделай 5 видео" and extracts mediaKind video and count 5', () => {
  const messages: PromptChatMessage[] = [
    { id: 'u1', role: 'user', text: 'сделай 5 видео полета над горами', createdAt: 1000 },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      reply: 'Подготовил видео-промпты.',
      prompts: Array.from({ length: 5 }, (_, i) => ({
        title: `Видео ${i + 1}`,
        prompt: `Полет над горами ${i + 1}`,
      })),
      createdAt: 2000,
    },
  ]

  const intent = detectGenerationIntent(messages, 1)
  assert.equal(intent.isGenerationOrder, true)
  assert.equal(intent.mediaKind, 'video')
  assert.equal(intent.requestedCount, 5)
})

test('detectGenerationIntent: does not auto-dispatch when user only asks for prompt text', () => {
  const messages: PromptChatMessage[] = [
    { id: 'u1', role: 'user', text: 'напиши мне 3 промпта для неонового города', createdAt: 1000 },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      reply: 'Вот 3 варианта промптов:',
      prompts: [
        { title: '1', prompt: 'город 1' },
        { title: '2', prompt: 'город 2' },
        { title: '3', prompt: 'город 3' },
      ],
      createdAt: 2000,
    },
  ]

  const intent = detectGenerationIntent(messages, 1)
  assert.equal(intent.isGenerationOrder, false)
})

test('detectGenerationIntent: handles clarifying conversation before generating', () => {
  const messages: PromptChatMessage[] = [
    { id: 'u1', role: 'user', text: 'сделай 8 фото кота', createdAt: 1000 },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      reply: 'В каком стиле: реализм или мультяшный?',
      prompts: [], // нет промптов — только вопрос
      createdAt: 2000,
    },
    { id: 'u2', role: 'user', text: 'реализм, крупный план', createdAt: 3000 },
    {
      id: 'a2',
      role: 'assistant',
      text: '',
      reply: 'Отлично, создаю 8 фото кота на холсте!',
      prompts: Array.from({ length: 8 }, (_, i) => ({
        title: `Кот ${i + 1}`,
        prompt: `Кот крупный план ${i + 1}`,
      })),
      createdAt: 4000,
    },
  ]

  // На первом шаге помощник только спросил — запускать ничего нельзя
  const firstTurn = detectGenerationIntent(messages, 1)
  assert.equal(firstTurn.isGenerationOrder, false)

  // На втором шаге пользователь ответил, и помощник предоставил промпты — запуск!
  const secondTurn = detectGenerationIntent(messages, 3)
  assert.equal(secondTurn.isGenerationOrder, true)
  assert.equal(secondTurn.mediaKind, 'image')
  assert.equal(secondTurn.requestedCount, 8)
})

test('collectHistoricalAssistantMessageIds: collects done and error assistant messages, ignores in-progress and user', () => {
  const messages: PromptChatMessage[] = [
    { id: 'u1', role: 'user', text: 'сделай 4 фото', createdAt: 1000 },
    { id: 'a1', role: 'assistant', text: '', status: 'done', prompts: [{ title: '1', prompt: 'p1' }], createdAt: 2000 },
    { id: 'u2', role: 'user', text: 'ещё 2', createdAt: 3000 },
    { id: 'a2', role: 'assistant', text: '', status: 'running', prompts: [], createdAt: 4000 },
    { id: 'a3', role: 'assistant', text: '', status: 'error', error: 'failed', createdAt: 5000 },
    { id: 'legacy', role: 'assistant', text: '', prompts: [{ title: 'old', prompt: 'old' }], createdAt: 6000 },
    { id: 'cancelled', role: 'assistant', text: '', status: 'cancelled', prompts: [{ title: 'old', prompt: 'old' }], createdAt: 7000 },
  ]

  const historical = collectHistoricalAssistantMessageIds(messages)
  assert.equal(historical.has('a1'), true, 'done assistant message is historical')
  assert.equal(historical.has('a3'), true, 'error assistant message is historical')
  assert.equal(historical.has('a2'), false, 'running assistant message is NOT historical')
  assert.equal(historical.has('legacy'), true, 'legacy turns without status are historical')
  assert.equal(historical.has('cancelled'), true, 'cancelled turns are terminal history')
  assert.equal(historical.has('u1'), false, 'user message is not assistant message')
})

test('assistant response launch is claimed once while the first request is pending', () => {
  const inFlight = new Set<string>()
  const dispatched: Record<string, string[]> = {}

  assert.equal(claimAssistantDispatch('answer', inFlight, dispatched), true)
  assert.equal(claimAssistantDispatch('answer', inFlight, dispatched), false)

  inFlight.delete('answer')
  dispatched.answer = ['slot-1']
  assert.equal(claimAssistantDispatch('answer', inFlight, dispatched), false)
})

test('ответ на редактирование запускается с исходником даже после смены выделения', () => {
  const original = imageRef('original')
  const user: PromptChatMessage = {
    id: 'request', role: 'user', text: 'Измени выделенное фото: сделай фон голубым', createdAt: 1,
    attachments: [{ shapeId: original.shapeId, kind: 'image', label: original.label, src: original.src, width: original.w, height: original.h }],
  }
  const answer: PromptChatMessage = {
    id: 'answer', role: 'assistant', text: '', createdAt: 2, requestMessageId: user.id,
    prompts: [{ title: 'Голубой фон', prompt: 'Измени фон @1 на голубой, сохрани персонажа.' }],
  }
  assert.deepEqual(detectGenerationIntent([user, answer], 1), { isGenerationOrder: true, mediaKind: 'image', requestedCount: undefined })
  const refs = refsForAssistantMessage([user, answer], answer)
  const launch = planAssistantCanvasLaunch({
    ...dockState({ modelId: 'nano-banana', refs, prompt: answer.prompts![0].prompt, params: { resolution: '2K' } }),
    kind: 'image', items: [],
  })
  assert.equal(launch.batch.admission.error, null)
  const plan = launch.batch.requests[0].plan
  assert.equal(plan.model?.id, 'nano-banana-edit', 'источник переключает ручную модель на её edit-вариант')
  assert.equal(plan.params.resolution, '2K', 'ручные параметры доходят до запуска')
  assert.equal(plan.jobs, 1)
  assert.equal(plan.refsToSend[0].src, original.src)
  refs[0].src = '/media/other-selection.png'
  assert.equal(plan.refsToSend[0].src, original.src, 'вход зафиксирован, новое выделение не меняет его')
})

test('помощник сохраняет видео-референс и выбирает video-edit вариант', () => {
  const launch = planAssistantCanvasLaunch({
    ...dockState({ modelId: 'grok', refs: [videoRef('clip')], prompt: 'Отредактируй видео: добавь закат', params: {} }),
    kind: 'video', items: [],
  })
  assert.equal(launch.batch.admission.error, null)
  assert.equal(launch.batch.requests[0].plan.model?.id, 'grok-video-edit')
  assert.equal(launch.batch.requests[0].plan.refsToSend[0].kind, 'video')
})

test('помощник сохраняет значения параметров при автоматическом выборе модели', () => {
  const launch = planAssistantCanvasLaunch({
    ...dockState({ modelId: null, params: { aspect_ratio: '16:9' } }),
    kind: 'image', items: [],
  })
  assert.equal(launch.batch.admission.error, null)
  assert.equal(launch.batch.requests[0]?.plan.params.aspect_ratio, '16:9')
})

test('выключенная память доски не подменяет Auto моделью из статистики', () => {
  const preferred = {
    ...LOCAL_DOCK_MODELS.find(model => model.id === 'nano-banana-edit')!,
    id: 'preferred-memory',
  }
  const fallback = {
    ...LOCAL_DOCK_MODELS.find(model => model.id === 'grok-image-edit')!,
    id: 'fallback-default',
  }
  const state = {
    ...dockState({
      modelId: null,
      models: [preferred, fallback],
      defaults: { ...dockState().defaults, image: fallback.id },
      refs: [imageRef('source')],
      items: [{ id: 'old', kind: 'image' as const, x: 0, y: 0, w: 100, h: 100, modelId: preferred.id, prompt: 'old' }],
    }),
    kind: 'image' as const,
  }
  const withMemory = planAssistantCanvasLaunch({ ...state, boardMemoryEnabled: true })
  const withoutMemory = planAssistantCanvasLaunch({ ...state, boardMemoryEnabled: false })
  assert.equal(withMemory.batch.requests[0]?.plan.model?.id, preferred.id)
  assert.equal(withoutMemory.batch.requests[0]?.plan.model?.id, fallback.id)
})

test('устаревший ручной выбор модели не подменяется автоматическим', () => {
  const launch = planAssistantCanvasLaunch({
    ...dockState({ modelId: 'removed-model', params: {} }),
    kind: 'image', items: [],
  })
  assert.match(launch.batch.admission.error ?? '', /not in the current catalog/u)
})

test('авто не удерживает модель памяти, которая не принимает frozen reference', () => {
  const preferred = {
    ...LOCAL_DOCK_MODELS.find(model => model.id === 'chatgpt-image-2')!,
    id: 'preferred-no-ref', name: 'Модель без референса', pairId: undefined, refs: false,
  }
  const compatible = {
    ...preferred,
    id: 'compatible-ref', name: 'Модель с референсом', refs: true, maxImageRefs: 4,
  }
  const launch = planAssistantCanvasLaunch({
    ...dockState({
      modelId: null,
      models: [preferred, compatible],
      defaults: { image: compatible.id, video: 'seedance-2', audio: 'sam-audio-separate', assistant: 'gemini' },
      refs: [imageRef('source')],
      items: [{ id: 'old', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: preferred.id, prompt: 'old' }],
    }),
    kind: 'image', items: [{ id: 'old', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: preferred.id, prompt: 'old' }],
  })
  assert.equal(launch.batch.admission.error, null)
  assert.equal(launch.batch.requests[0]?.plan.model?.id, compatible.id)
})

test('агрегированная оценка помощника поднимает общий порог для серии из десяти', () => {
  const launches = Array.from({ length: 10 }, () => ({ batch: { totalCost: 0.2 } }))
  const total = assistantAggregateEstimatedCost(launches)
  assert.equal(total, 2)
  assert.equal(shouldAskLocalCostConfirmation('local', true, 0.2, 1), false)
  assert.equal(shouldAskLocalCostConfirmation('local', true, total, 1), true)
  assert.equal(assistantAggregateEstimatedCost([{ batch: { totalCost: null } }]), null)
})

test('редактирование настроек и просьба только написать промпт не запускают медиа даже с вложением', () => {
  for (const text of [
    'Измени настройки помощника',
    'Отредактируй этот промпт',
    'Напиши промпт для редактирования фото',
    'Напиши промпт: измени фон на голубой',
    'Сделай промпт для обложки',
    'Создай готовый промпт для обложки',
  ]) {
    const messages: PromptChatMessage[] = [
      { id: 'u', role: 'user', text, createdAt: 1, attachments: [{ shapeId: 'source', kind: 'image', label: 'Исходник', src: '/media/source.png' }] },
      { id: 'a', role: 'assistant', text: '', createdAt: 2, prompts: [{ title: 'Черновик', prompt: 'Текст' }] },
    ]
    assert.equal(detectGenerationIntent(messages, 1).isGenerationOrder, false)
  }
})

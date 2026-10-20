// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import {
  applyPreparedPrompt,
  dockHelperEligibility,
  dockHelperHint,
  helperEstimateUsd,
  helperInstruction,
  helperLaunchConfirmation,
  helperSampleRefs,
  preparedPromptProblem,
} from './dockHelper'
import type { ActionDockBatchPlanningResult } from './actionDockBatchPlanning'
import type { SelectionRef } from './konva/selection'
import type { CatalogModel } from '../../types'

const imgRef = (id: string): SelectionRef => ({
  kind: 'image',
  shapeId: id,
  src: `/media/${id}.png`,
  width: 500,
  height: 500,
})

const textRef = (id: string, text: string): SelectionRef => ({
  kind: 'text',
  shapeId: id,
  text,
})

const videoRef = (id: string): SelectionRef => ({
  kind: 'video',
  shapeId: id,
  src: `/media/${id}.mp4`,
})

test('dockHelperEligibility: Универсальный, неизвестный, аудио или облачный планшет без картинок', () => {
  // Универсальный или null
  assert.deepEqual(dockHelperEligibility({
    kind: 'image',
    assistantId: null,
    imageRefsCount: 0,
  }), { eligible: false, reason: 'universal' })

  assert.deepEqual(dockHelperEligibility({
    kind: 'image',
    assistantId: '',
    imageRefsCount: 2,
  }), { eligible: false, reason: 'universal' })

  // Неизвестный выбор (ещё не загрузился)
  assert.deepEqual(dockHelperEligibility({
    kind: 'image',
    assistantId: 'helper-1',
    assistantKnown: false,
    imageRefsCount: 1,
  }), { eligible: false, reason: 'assistant-unknown' })

  // Аудио не поддерживается
  assert.deepEqual(dockHelperEligibility({
    kind: 'audio',
    assistantId: 'helper-1',
    imageRefsCount: 1,
  }), { eligible: false, reason: 'audio-unsupported' })

  // Транспорт не поддерживает подготовку
  assert.deepEqual(dockHelperEligibility({
    kind: 'image',
    assistantId: 'helper-1',
    imageRefsCount: 1,
    hasPreparationCapability: false,
  }), { eligible: false, reason: 'capability-unavailable' })

  // Автономный облачный планшет требует хотя бы 1 картинку
  assert.deepEqual(dockHelperEligibility({
    kind: 'image',
    assistantId: 'helper-1',
    isStandaloneCloudTablet: true,
    imageRefsCount: 0,
  }), { eligible: false, reason: 'images-required-cloud-tablet' })

  // На обычном десктопе/локальном планшете 0 картинок РАЗРЕШЕНО (текст-в-картинку или текст-в-видео)
  assert.deepEqual(dockHelperEligibility({
    kind: 'image',
    assistantId: 'helper-1',
    isStandaloneCloudTablet: false,
    imageRefsCount: 0,
  }), { eligible: true, reason: 'eligible' })

  // Видео с картинками и без картинок разрешено
  assert.deepEqual(dockHelperEligibility({
    kind: 'video',
    assistantId: 'helper-1',
    imageRefsCount: 1,
  }), { eligible: true, reason: 'eligible' })
})

test('dockHelperHint: тексты подсказки в разных режимах и статусах', () => {
  assert.equal(dockHelperHint('discuss', { eligible: true, reason: 'eligible' }), 'Text only · no actions')
  assert.equal(dockHelperHint('agents', { eligible: true, reason: 'eligible' }), '')

  assert.equal(dockHelperHint('make', { eligible: false, reason: 'universal' }), 'Creates a result after running')
  assert.equal(
    dockHelperHint('make', { eligible: false, reason: 'images-required-cloud-tablet' }),
    'Without an assistant: you need reference pictures',
  )
  assert.equal(
    dockHelperHint('make', { eligible: false, reason: 'audio-unsupported' }),
    'Without an assistant: only pictures and videos',
  )
  assert.equal(
    dockHelperHint('make', { eligible: true, reason: 'eligible' }, 0.01),
    'Assistant · ≈ $0.01',
  )
})

test('helperSampleRefs: выборка 4 для each и 16 для together, фильтрация не-картинок', () => {
  const refs: SelectionRef[] = [
    imgRef('img1'),
    videoRef('vid1'),
    imgRef('img2'),
    textRef('txt1', 'текст'),
    imgRef('img3'),
    imgRef('img4'),
    imgRef('img5'),
  ]

  const eachSample = helperSampleRefs(refs, 'each')
  assert.equal(eachSample.length, 4)
  assert.deepEqual(eachSample.map((r) => r.shapeId), ['img1', 'img2', 'img3', 'img4'])

  const togetherSample = helperSampleRefs(refs, 'together')
  assert.equal(togetherSample.length, 5)
  assert.deepEqual(togetherSample.map((r) => r.shapeId), ['img1', 'img2', 'img3', 'img4', 'img5'])
})

test('helperInstruction: объединяет промпт и текстовые референсы', () => {
  assert.equal(helperInstruction('сделай красивее', []), 'сделай красивее')
  assert.equal(
    helperInstruction('', [{ text: 'первый контекст' }, { text: 'второй контекст' }]),
    'первый контекст\n\nвторой контекст',
  )
  assert.equal(
    helperInstruction('замени фон', [{ text: 'контекст из карточки' }]),
    'замени фон\n\nконтекст из карточки',
  )
})

test('helperEstimateUsd: плоская оценка модели из каталога', () => {
  const model: CatalogModel = {
    id: 'text-gemini',
    name: 'Gemini',
    kind: 'text',
    params: [],
    pricing: {
      usd: 0.009,
      unit: 'prompt',
    },
  } as unknown as CatalogModel

  assert.equal(helperEstimateUsd(model), 0.009)
  assert.equal(helperEstimateUsd(null), 0.01)
})

test('preparedPromptProblem: проверки пустоты и тегов @n', () => {
  assert.equal(preparedPromptProblem('', 'each', 2), 'Assistant returned an empty request')
  assert.equal(preparedPromptProblem('   ', 'together', 2), 'Assistant returned an empty request')

  // В «каждое» @1,@2 недопустимо
  assert.match(
    preparedPromptProblem('измени @1 и добавь @2', 'each', 3) ?? '',
    /In Edit Each mode, specify one source \(@1\) rather than multiple references/u,
  )
  // В «каждое» с одним источником @1 корректно
  assert.equal(preparedPromptProblem('измени @1', 'each', 3), null)

  // Во «вместе» ссылка на несуществующий @n недопустима
  assert.equal(
    preparedPromptProblem('объедини @1 и @5', 'together', 3),
    'The assistant referred to a non-existent reference @5',
  )
  assert.equal(preparedPromptProblem('объедини @1 и @2', 'together', 3), null)
})

test('applyPreparedPrompt: обновляет текст, очищает text refs из refsToSend, сохраняет параметры и цену', () => {
  const dummyModel = { id: 'm1', name: 'Model 1' } as CatalogModel
  const initialBatch: ActionDockBatchPlanningResult = {
    admission: { mode: 'together', groups: [], imageCount: 1, jobs: 2, error: null },
    jobs: 2,
    totalCost: 0.08,
    requests: [
      {
        group: { refs: [imgRef('img1'), textRef('txt1', 'контекст')] },
        baseModel: dummyModel,
        estimatedCost: 0.08,
        refs: [imgRef('img1'), textRef('txt1', 'контекст')],
        plan: {
          text: 'старый текст',
          refsToSend: [imgRef('img1'), textRef('txt1', 'контекст')],
          hasImageRefs: true,
          hasVideoRefs: false,
          model: dummyModel,
          params: { quality: 'high', seed: 42 },
          jobs: 2,
          anchorIds: ['a1'],
          aspect: 1,
        },
      },
    ],
  }

  const result = applyPreparedPrompt(initialBatch, 'новый подготовленный текст')

  assert.equal(result.requests[0].plan.text, 'новый подготовленный текст')
  // Текстовый референс убран из refsToSend
  assert.deepEqual(result.requests[0].plan.refsToSend, [imgRef('img1')])
  // Все остальные поля не изменились
  assert.equal(result.requests[0].plan.model, dummyModel)
  assert.deepEqual(result.requests[0].plan.params, { quality: 'high', seed: 42 })
  assert.equal(result.requests[0].plan.jobs, 2)
  assert.deepEqual(result.requests[0].plan.anchorIds, ['a1'])
  assert.equal(result.requests[0].plan.aspect, 1)
  assert.equal(result.totalCost, 0.08)
})

test('helperLaunchConfirmation: порог считается по сумме, строка «Помощник» в окне есть', () => {
  const dialog = helperLaunchConfirmation('GPT Image 2', 'Копирайтер', 0.01, 0.04, 2)
  assert.equal(dialog.title, 'Run for $0.05?')
  assert.equal(dialog.confirmLabel, 'Run for $0.05')
  assert.deepEqual(dialog.rows, [
    ['Model', 'GPT Image 2'],
    ['Tasks', '2'],
    ['Assistant', '«Копирайтер» · ≈ $0.01'],
  ])
})

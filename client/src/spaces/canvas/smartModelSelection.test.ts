import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogModel } from '../../types'
import { LOCAL_DOCK_DEFAULTS, LOCAL_DOCK_MODELS } from './localDockCatalogTestKit'
import { baseModels } from './genOptions'
import {
  AUTO_MODEL_ID,
  baseModelOf,
  isAutoModelId,
  selectableModelId,
  selectSmartModel,
  smartRefsFor,
} from './smartModelSelection'

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'base', name: 'Base', kind: 'image', endpoint: 'test/base', refs: false,
    params: [], pricing: { unit: 'image', usd: 0.05 }, ...overrides,
  }
}

const local = (kind: 'image' | 'video' | 'audio', refs: Array<{ kind: 'image' | 'video' | 'audio' | 'text' }>, modelId: string | null = AUTO_MODEL_ID) => (
  selectSmartModel({ models: LOCAL_DOCK_MODELS, defaults: LOCAL_DOCK_DEFAULTS, kind, refs, modelId })
)

test('auto selects the catalog default when it accepts the complete ref set and exposes its real price', () => {
  const result = selectSmartModel({
    models: [
      model({ id: 'cheap', name: 'Cheap', pricing: { unit: 'image', usd: 0.01 } }),
      model({ id: 'preferred', name: 'Preferred', pricing: { unit: 'image', usd: 0.12 } }),
    ],
    kind: 'image',
    defaults: { image: 'preferred', video: null, audio: null, assistant: null },
    modelId: AUTO_MODEL_ID,
  })
  assert.equal(result.mode, 'auto')
  assert.equal(result.model?.id, 'preferred')
  assert.equal(result.model?.pricing?.usd, 0.12)
  assert.equal(result.error, null)
})

test('auto resolves a ref pair and skips candidates that cannot accept the group', () => {
  const result = selectSmartModel({
    models: [
      model({ id: 'first', pairId: 'first-edit' }),
      model({ id: 'first-edit', name: 'First Edit', refs: true, maxImageRefs: 1, pricing: { unit: 'image', usd: 0.1 } }),
      model({ id: 'second', pairId: 'second-edit' }),
      model({ id: 'second-edit', name: 'Second Edit', refs: true, maxImageRefs: 4, pricing: { unit: 'image', usd: 0.2 } }),
    ],
    kind: 'image',
    refs: [{ kind: 'image' }, { kind: 'image' }],
    modelId: AUTO_MODEL_ID,
  })
  assert.equal(result.model?.id, 'second-edit')
  assert.equal(result.model?.pricing?.usd, 0.2)
  assert.equal(result.error, null)
})

test('auto respects modalities, lifecycle, executor and audio visual-ref requirements', () => {
  const result = selectSmartModel({
    models: [
      model({ id: 'archived', lifecycle: 'archived', maxImageRefs: 5 }),
      model({ id: 'new-client', minExecutorVersion: 999, maxImageRefs: 5 }),
      model({ id: 'wrong-modality', inputModalities: ['image'], maxAudioRefs: 1 }),
      model({ id: 'audio-without-visual', audioInputField: 'audio_url', maxAudioRefs: 1, audioRequiresVisualRef: true }),
      model({ id: 'usable', inputModalities: ['image', 'audio'], maxImageRefs: 1, maxAudioRefs: 1, maxTotalRefs: 2 }),
    ].map((item) => ({ ...item, kind: 'image' as const })),
    kind: 'image',
    refs: [{ kind: 'audio' }, { kind: 'image' }],
    modelId: AUTO_MODEL_ID,
  })
  assert.equal(result.model?.id, 'usable')
  assert.equal(result.error, null)
})

test('manual archived or disabled base cannot revive through an active ref pair', () => {
  for (const lifecycle of ['archived', 'disabled'] as const) {
    const result = selectSmartModel({
      models: [
        model({ id: 'base', lifecycle, pairId: 'base-edit' }),
        model({ id: 'base-edit', name: 'Base edit', refs: true, maxImageRefs: 4 }),
      ],
      kind: 'image',
      refs: [{ kind: 'image' }],
      modelId: 'base',
    })
    assert.equal(result.mode, 'manual')
    assert.equal(result.model?.id, 'base')
    assert.match(result.error ?? '', new RegExp(lifecycle === 'archived' ? 'archived' : 'disabled', 'u'))
  }
})

test('the only candidate reports its own video, image, and audio min/max ref limits', () => {
  // Модель одна — её причина и есть ответ: «Авто» выбирать не из чего.
  const videoTooMany = selectSmartModel({
    models: [model({ id: 'video', name: 'Только одно видео', kind: 'video', refs: true, videoInputField: 'video_urls', inputModalities: ['video'], minVideoRefs: 1, maxVideoRefs: 1 })],
    kind: 'video',
    refs: [{ kind: 'video' }, { kind: 'video' }],
    modelId: AUTO_MODEL_ID,
  })
  assert.equal(videoTooMany.model, null)
  assert.equal(videoTooMany.error, 'Model “Только одно видео” accepts no more than 1 video (selected: 2).')

  // Прежний текст — «минимум 2 изображений-референса» — был собран без
  // склонения. Теперь число согласовано: «не меньше 2 картинок».
  const imageTooFew = selectSmartModel({
    models: [model({ id: 'image', name: 'Две картинки', refs: true, imageInputField: 'image_urls', inputModalities: ['image'], minImageRefs: 2, maxImageRefs: 3 })],
    kind: 'image',
    refs: [{ kind: 'image' }],
    modelId: AUTO_MODEL_ID,
  })
  assert.equal(imageTooFew.model, null)
  assert.equal(imageTooFew.error, 'Model “Две картинки” needs at least 2 images (selected: 1).')

  const audioTooMany = selectSmartModel({
    models: [model({ id: 'audio', name: 'Одна дорожка', kind: 'audio', audioInputField: 'audio_urls', inputModalities: ['audio'], minAudioRefs: 1, maxAudioRefs: 1 })],
    kind: 'audio',
    refs: [{ kind: 'audio' }, { kind: 'audio' }],
    modelId: AUTO_MODEL_ID,
  })
  assert.equal(audioTooMany.model, null)
  assert.equal(audioTooMany.error, 'Model “Одна дорожка” accepts no more than 1 audio (selected: 2).')
})

test('auto respects the normalized unavailable catalog marker', () => {
  const result = selectSmartModel({
    models: [
      model({ id: 'unavailable', unavailable: true } as Partial<CatalogModel> & { unavailable: boolean }),
      model({ id: 'ready' }),
    ],
    kind: 'image',
    modelId: AUTO_MODEL_ID,
  })
  assert.equal(result.model?.id, 'ready')
  assert.equal(result.error, null)
})

test('manual selection wins and an invalid manual model never silently falls back', () => {
  const models = [
    model({ id: 'manual', name: 'Manual', maxImageRefs: 1 }),
    model({ id: 'fallback', name: 'Fallback', maxImageRefs: 4 }),
  ]
  const result = selectSmartModel({ models, kind: 'image', refs: [{ kind: 'image' }, { kind: 'image' }], modelId: 'manual' })
  assert.equal(result.mode, 'manual')
  assert.equal(result.model?.id, 'manual')
  assert.match(result.error ?? '', /accepts no more than 1 image/u)
  assert.notEqual(result.model?.id, 'fallback')
})

test('auto sentinel is UI-only and no model id is produced for an empty catalog', () => {
  assert.equal(isAutoModelId(null), true)
  assert.equal(isAutoModelId(AUTO_MODEL_ID), true)
  const result = selectSmartModel({ models: [], kind: 'image', modelId: AUTO_MODEL_ID })
  assert.equal(result.model, null)
  assert.equal(result.panelModel, null)
  assert.equal(result.error, 'No available model for type “Image” is in the catalog.')
})

// ── что подбор считает референсами ──────────────────────────────────────────

test('ролик считается картинкой, пока генерируем не видео, и видео — когда генерируем видео', () => {
  const refs = [{ kind: 'video' as const }, { kind: 'image' as const }, { kind: 'text' as const }, { kind: 'audio' as const }]
  assert.deepEqual(smartRefsFor('image', refs).map((ref) => ref.kind), ['image', 'image', 'text', 'audio'])
  assert.deepEqual(smartRefsFor('audio', refs).map((ref) => ref.kind), ['image', 'image', 'text', 'audio'])
  assert.deepEqual(smartRefsFor('video', refs).map((ref) => ref.kind), ['video', 'image', 'text', 'audio'])
})

test('в режиме скетча подбор видит ровно одну картинку, сколько бы чипов ни было', () => {
  const refs = [{ kind: 'image' as const }, { kind: 'image' as const }, { kind: 'video' as const }, { kind: 'text' as const }]
  for (const kind of ['image', 'video'] as const) {
    assert.deepEqual(smartRefsFor(kind, refs, 'sketch-target'), [{ kind: 'image' }])
  }
  assert.deepEqual(smartRefsFor('image', [], 'sketch-target'), [{ kind: 'image' }])
})

// Жалоба-регрессия: тип «Картинка», в чипах ролик. Приложение шлёт его кадром,
// а подбор считал его видео — и ни одна модель картинок набор не брала.
test('картинка по видео-референсу: выбирается вариант по референсам', () => {
  const auto = local('image', smartRefsFor('image', [{ kind: 'video' }]))
  assert.equal(auto.error, null)
  assert.equal(auto.model?.id, 'chatgpt-image-2-edit')
  assert.equal(auto.baseModel?.id, 'chatgpt-image-2')

  const mixed = local('image', smartRefsFor('image', [{ kind: 'image' }, { kind: 'video' }]))
  assert.equal(mixed.error, null)
  assert.equal(mixed.model?.id, 'chatgpt-image-2-edit')

  const manual = local('image', smartRefsFor('image', [{ kind: 'video' }]), 'nano-banana')
  assert.equal(manual.error, null)
  assert.equal(manual.model?.id, 'nano-banana-edit')
})

test('видео по видео-референсу по-прежнему берёт модель, которая принимает ролик', () => {
  const auto = local('video', smartRefsFor('video', [{ kind: 'video' }]))
  assert.equal(auto.error, null)
  assert.equal(auto.model?.id, 'seedance-2-refs')
  assert.equal(auto.baseModel?.id, 'seedance-2')
})

test('ручной Grok Video со скетчем допускается, хотя выделено несколько объектов', () => {
  const chips = [{ kind: 'image' as const }, { kind: 'image' as const }, { kind: 'image' as const }]
  // без скетча три картинки эта модель не берёт
  assert.match(local('video', smartRefsFor('video', chips), 'grok').error ?? '', /accepts no more than 1 image \(selected: 3\)/u)
  const sketch = local('video', smartRefsFor('video', chips, 'sketch-target'), 'grok')
  assert.equal(sketch.error, null)
  assert.equal(sketch.model?.id, 'grok-i2v')
})

// ── базовая модель: что хранит карточка и что возвращается в док ────────────

test('подбор возвращает и запускаемую модель, и её базу из списка', () => {
  const cases: Array<['image' | 'video', 'image' | 'video', string, string]> = [
    ['image', 'image', 'chatgpt-image-2-edit', 'chatgpt-image-2'],
    ['video', 'image', 'seedance-2-i2v', 'seedance-2'],
    ['video', 'video', 'seedance-2-refs', 'seedance-2'],
  ]
  for (const [kind, refKind, effective, base] of cases) {
    const result = local(kind, [{ kind: refKind }])
    assert.equal(result.model?.id, effective)
    assert.equal(result.baseModel?.id, base)
    // базу можно выбрать в списке, вариант — нельзя
    const listed = baseModels(LOCAL_DOCK_MODELS, kind).map((item) => item.id)
    assert.ok(listed.includes(base), `${base} должен быть в списке`)
    assert.ok(!listed.includes(effective), `${effective} в списке быть не должно`)
  }
})

test('сохранённый номер варианта переводится в базу, которую можно выбрать', () => {
  assert.equal(selectableModelId(LOCAL_DOCK_MODELS, 'chatgpt-image-2-edit'), 'chatgpt-image-2')
  assert.equal(selectableModelId(LOCAL_DOCK_MODELS, 'seedance-2-i2v'), 'seedance-2')
  assert.equal(selectableModelId(LOCAL_DOCK_MODELS, 'seedance-2-refs'), 'seedance-2')
  assert.equal(selectableModelId(LOCAL_DOCK_MODELS, 'grok-video-edit'), 'grok')
  // база и самостоятельная модель остаются собой
  assert.equal(selectableModelId(LOCAL_DOCK_MODELS, 'chatgpt-image-2'), 'chatgpt-image-2')
  assert.equal(selectableModelId(LOCAL_DOCK_MODELS, 'grok-video-1-5'), 'grok-video-1-5')
  assert.equal(selectableModelId(LOCAL_DOCK_MODELS, 'нет-такой'), null)
  assert.equal(selectableModelId(LOCAL_DOCK_MODELS, AUTO_MODEL_ID), null)
  assert.equal(selectableModelId(LOCAL_DOCK_MODELS, null), null)
  const edit = LOCAL_DOCK_MODELS.find((item) => item.id === 'chatgpt-image-2-edit')!
  assert.equal(baseModelOf(LOCAL_DOCK_MODELS, edit).id, 'chatgpt-image-2')
})

test('ручной номер варианта без референсов не запускает ручку правки', () => {
  // Так выглядел двойной клик по результату: в док попадал «…-edit», и
  // «Создать» слал ручку правки без входной картинки.
  const result = local('image', [], 'chatgpt-image-2-edit')
  assert.equal(result.error, null)
  assert.equal(result.model?.id, 'chatgpt-image-2')
  assert.equal(result.baseModel?.id, 'chatgpt-image-2')
})

// ── отказ «Авто» ────────────────────────────────────────────────────────────

test('отказ «Авто» называет выбранный набор, а не последнюю из перебранных моделей', () => {
  const images = local('image', Array.from({ length: 17 }, () => ({ kind: 'image' as const })))
  assert.equal(images.model, null)
  assert.equal(
    images.error,
    'No model for type “Image” supports this set: 17 images. Remove some references or choose a model manually.',
  )
  for (const candidate of LOCAL_DOCK_MODELS) {
    assert.ok(!(images.error ?? '').includes(`«${candidate.name}»`), `в отказе названа модель ${candidate.name}`)
  }

  const mixed = local('video', [{ kind: 'video' }, { kind: 'video' }, { kind: 'video' }, { kind: 'video' }, { kind: 'audio' }])
  assert.equal(mixed.model, null)
  assert.match(mixed.error ?? '', /No model for type “Video” supports this set: 4 video and 1 audio\./u)
})

test('при отказе «Авто» на виду остаются параметры модели по умолчанию', () => {
  const result = local('image', Array.from({ length: 17 }, () => ({ kind: 'image' as const })))
  assert.equal(result.model, null)
  assert.equal(result.baseModel, null)
  // умолчание своей доски — GPT Image 2; с картинками это его вариант правки
  assert.equal(result.panelModel?.id, 'chatgpt-image-2-edit')
  assert.ok((result.panelModel?.params.length ?? 0) > 0)
})

test('единственная модель типа отвечает своей причиной: чего ей не хватает', () => {
  // На холсте звук делает одна модель, и ей нужна выделенная дорожка.
  const result = local('audio', [])
  assert.equal(result.model, null)
  assert.equal(result.error, 'Model “SAM Audio — extract track” needs a reference: audio.')
})

test('foreign type uses the English label', () => {
  const result = local('video', [], 'chatgpt-image-2')
  assert.equal(result.error, 'Model “GPT Image 2” is not suitable for type “Video”.')
})

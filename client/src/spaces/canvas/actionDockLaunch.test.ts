import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogModel } from '../../types'
import {
  dockAttemptConsentInput,
  dockConsentInput,
  dockLaunchMode,
  dockLeadRefs,
  planDockLaunch,
  type DockLaunchState,
} from './actionDockLaunch'
import { generationConsentScope } from './agents/agentGenerationConsentModel'
import {
  LOCAL_DOCK_DEFAULTS,
  LOCAL_DOCK_MODELS,
  dockState,
  imageRef,
  textRef,
  videoRef,
} from './localDockCatalogTestKit'
import { baseModels } from './genOptions'
import type { CanvasItem } from './konva/types'
import { AUTO_MODEL_ID, selectableModelId, selectSmartModel } from './smartModelSelection'

// План запуска дока на НАСТОЯЩЕМ каталоге своей доски: что показано — то и
// запускается, а на карточку идёт модель, которую можно выбрать в списке.

const sketchItem = (id: string): CanvasItem => ({
  id, kind: 'image', x: 0, y: 0, w: 300, h: 450, src: `/media/${id}.png`, naturalWidth: 1024, naturalHeight: 1536,
} as CanvasItem)

// ── ролик как референс картинки ─────────────────────────────────────────────

test('картинка по видео-референсу запускается: ролик уходит кадром', () => {
  for (const modelId of [AUTO_MODEL_ID, 'chatgpt-image-2', 'nano-banana']) {
    for (const batchMode of ['each', 'together'] as const) {
      const plan = planDockLaunch(dockState({ modelId, batchMode, refs: [videoRef('clip')] }))
      assert.equal(plan.batch.admission.error, null, `${modelId} · ${batchMode}`)
      assert.equal(plan.batch.jobs, 1)
      const expected = modelId === 'nano-banana' ? 'nano-banana-edit' : 'chatgpt-image-2-edit'
      assert.equal(plan.batch.requests[0]?.plan.model?.id, expected)
    }
  }
})

test('картинка и ролик вместе уходят одним запросом с двумя картинками на входе', () => {
  // «Изменить каждое» стоит по умолчанию, и раньше здесь был отказ без выхода.
  const plan = planDockLaunch(dockState({ refs: [imageRef('photo'), videoRef('clip')] }))
  assert.equal(plan.batch.admission.error, null)
  assert.equal(plan.batch.jobs, 1)
  assert.equal(plan.batch.requests[0]?.plan.model?.id, 'chatgpt-image-2-edit')
  assert.deepEqual(plan.batch.requests[0]?.plan.refsToSend.map((ref) => ref.kind), ['image', 'video'])
})

test('видео по ролику по-прежнему берёт модель с видео-референсом', () => {
  const plan = planDockLaunch(dockState({ kind: 'video', refs: [videoRef('clip')] }))
  assert.equal(plan.batch.admission.error, null)
  assert.equal(plan.batch.requests[0]?.plan.model?.id, 'seedance-2-refs')
})

// ── скетч ───────────────────────────────────────────────────────────────────

test('скетч: модель видит одну картинку, сколько бы объектов ни было выделено', () => {
  const cases: Array<[DockLaunchState['kind'], string, number, string]> = [
    ['video', 'grok', 1, 'grok-i2v'],
    ['video', 'grok-video-1-5', 1, 'grok-video-1-5'],
    ['video', 'minimax-h3', 2, 'minimax-h3-i2v'],
    ['image', 'grok-image', 3, 'grok-image-edit'],
    ['video', 'grok', 4, 'grok-i2v'],
  ]
  for (const [kind, modelId, chips, expected] of cases) {
    const refs = Array.from({ length: chips }, (_, index) => imageRef(index === 0 ? 'target' : `extra-${index}`))
    const plan = planDockLaunch(dockState({ kind, modelId, refs, sketchTarget: 'target', itemById: sketchItem }))
    assert.equal(plan.batch.admission.error, null, `${modelId} · чипов ${chips}`)
    assert.equal(plan.batch.jobs, 1)
    assert.equal(plan.batch.requests[0]?.plan.model?.id, expected)
  }
})

test('скетч всегда один запрос: предпросмотр не делит набор по картинкам', () => {
  const refs = [imageRef('target'), imageRef('second')]
  // «Изменить каждое» выбрано, но в скетче уходит одна склейка
  const state = dockState({ batchMode: 'each', refs, sketchTarget: 'target', itemById: sketchItem })
  assert.equal(dockLaunchMode(state), 'together')
  const plan = planDockLaunch(state)
  assert.equal(plan.mode, 'together')
  assert.equal(plan.batch.requests.length, 1)
  assert.equal(plan.batch.jobs, 1)
  // цена — одного запроса с одной картинкой, а не двух
  const single = planDockLaunch(dockState({ batchMode: 'together', refs: [imageRef('target')] }))
  assert.equal(plan.batch.totalCost, single.batch.totalCost)
})

// ── согласие: предпросмотр и запуск ─────────────────────────────────────────

/**
 * Так PromptBar строит состояние запуска из состояния предпросмотра: те же
 * поля, замороженные копиями. Область согласия обязана совпасть до символа —
 * иначе галочка, поставленная по предпросмотру, запуском не признаётся.
 */
function frozenForLaunch(state: DockLaunchState): DockLaunchState {
  return {
    ...state,
    refs: state.refs.map((ref) => ({ ...ref })),
    params: structuredClone(state.params),
  }
}

test('область согласия предпросмотра равна области запуска, включая скетч', () => {
  const cases: Array<Partial<DockLaunchState>> = [
    { refs: [imageRef('a'), imageRef('b')], batchMode: 'each', count: 2 },
    { refs: [imageRef('a'), imageRef('b')], batchMode: 'together' },
    { refs: [imageRef('a'), textRef('note', 'свет слева')], prompt: '' },
    { kind: 'video', refs: [videoRef('clip')] },
    { refs: [imageRef('target'), imageRef('b')], batchMode: 'each', sketchTarget: 'target', itemById: sketchItem },
    { refs: [], sketchTarget: 'target', itemById: sketchItem },
  ]
  for (const over of cases) {
    const preview = dockState(over)
    const launch = frozenForLaunch(preview)
    const previewInput = dockConsentInput(preview, planDockLaunch(preview))
    const launchInput = dockConsentInput(launch, planDockLaunch(launch))
    assert.equal(generationConsentScope(previewInput), generationConsentScope(launchInput))
    assert.deepEqual(previewInput, launchInput)
  }
})

test('в скетче область согласия описывает один общий локальный запрос', () => {
  const state = dockState({
    refs: [imageRef('target'), imageRef('b')], batchMode: 'each', sketchTarget: 'target', itemById: sketchItem,
  })
  const input = dockConsentInput(state, planDockLaunch(state))
  assert.equal(input.mode, 'together')
  assert.equal(input.attempts, 1)
  assert.equal(input.mediaTransferRequired, false)
})

test('локальная картинка не требует передачи материалов для скетча', () => {
  const state = dockState({ refs: [], sketchTarget: 'target', itemById: sketchItem })
  assert.equal(dockConsentInput(state, planDockLaunch(state)).mediaTransferRequired, false)
  const textOnly = dockState({ refs: [textRef('note', 'свет')] })
  assert.equal(dockConsentInput(textOnly, planDockLaunch(textOnly)).mediaTransferRequired, false)
})

test('в согласии лежит запускаемая локальная модель, а не значение «Авто»', () => {
  const state = dockState({ refs: [imageRef('a')] })
  const plan = planDockLaunch(state)
  const input = dockConsentInput(state, plan)
  assert.equal(input.modelId, 'chatgpt-image-2-edit')
  assert.equal(input.catalogRevision, plan.selection.model?.contractRevision)
  const request = plan.batch.requests[0]!
  const attempt = dockAttemptConsentInput({
    projectRef: state.projectRef,
    kind: state.kind,
    mode: plan.mode,
    request,
    genRefs: [{ kind: 'image', src: '/media/a.png' }],
    mediaTransferConsent: false,
  })
  assert.equal(attempt.modelId, 'chatgpt-image-2-edit')
  assert.equal(attempt.attempts, 1)
  assert.equal(attempt.mediaTransferRequired, true)
  assert.notEqual(input.modelId, AUTO_MODEL_ID)
})

// ── что хранит карточка ─────────────────────────────────────────────────────

test('номер модели на карточке можно выбрать в списке', () => {
  const cases: Array<[DockLaunchState['kind'], DockLaunchState['refs'], string, string]> = [
    ['image', [imageRef('a')], 'chatgpt-image-2-edit', 'chatgpt-image-2'],
    ['video', [imageRef('a')], 'seedance-2-i2v', 'seedance-2'],
    ['video', [videoRef('clip')], 'seedance-2-refs', 'seedance-2'],
  ]
  for (const [kind, refs, launched, stored] of cases) {
    const request = planDockLaunch(dockState({ kind, refs })).batch.requests[0]!
    // в запрос уходит вариант «по референсам»…
    assert.equal(request.plan.model?.id, launched)
    // …а на карточку — его база: её и покажет список, когда модель вернут в док
    assert.equal(request.baseModel?.id, stored)
    assert.ok(baseModels(LOCAL_DOCK_MODELS, kind).some((model) => model.id === stored))
    // двойной клик по результату без референсов запускает базу, а не правку
    const again = planDockLaunch(dockState({ kind, modelId: request.baseModel!.id, refs: [] }))
    assert.equal(again.batch.admission.error, null)
    assert.equal(again.batch.requests[0]?.plan.model?.id, stored)
  }
})

test('объект, уже сохранённый с номером варианта, возвращает в док базовую модель', () => {
  const restored = selectableModelId(LOCAL_DOCK_MODELS, 'chatgpt-image-2-edit')
  assert.equal(restored, 'chatgpt-image-2')
  const plan = planDockLaunch(dockState({ modelId: restored, refs: [] }))
  assert.equal(plan.batch.requests[0]?.plan.model?.id, 'chatgpt-image-2')
  assert.ok((plan.batch.totalCost ?? 0) > 0)
})

// ── «Изменить каждое»: хук и план об одной модели ───────────────────────────

test('в «Изменить каждое» параметры сверяются под моделью плана, а не всего набора', () => {
  const cases: Array<[Partial<typeof LOCAL_DOCK_DEFAULTS>, number]> = [
    [{}, 2],
    [{}, 17],
    [{ image: 'grok-image' }, 4],
    [{ image: 'seedream-5-pro' }, 12],
  ]
  for (const [defaultsOver, imageCount] of cases) {
    const defaults = { ...LOCAL_DOCK_DEFAULTS, ...defaultsOver }
    const refs = Array.from({ length: imageCount }, (_, index) => imageRef(`i${index + 1}`))
    const state = dockState({ defaults, refs, batchMode: 'each' })
    const plan = planDockLaunch(state)
    // так хук выбора модели получает свои референсы (useModelSelection)
    const hook = selectSmartModel({
      models: state.models, defaults, kind: state.kind, modelId: state.modelId, refs: dockLeadRefs(state, state.kind),
    })
    assert.equal(plan.batch.admission.error, null)
    assert.equal(plan.batch.jobs, imageCount)
    assert.equal(hook.model?.id, plan.batch.requests[0]?.plan.model?.id, `умолчание ${defaults.image}, картинок ${imageCount}`)
    assert.equal(plan.selection.model?.id, plan.batch.requests[0]?.plan.model?.id)
    // каждая группа — один исходник, поэтому модель у всех запросов одна
    assert.equal(new Set(plan.batch.requests.map((request) => request.plan.model?.id)).size, 1)
  }
})

test('в общем запросе хук видит весь набор, а при смене типа — набор нового типа', () => {
  const refs = [imageRef('a'), imageRef('b'), videoRef('clip')]
  const together = dockState({ batchMode: 'together', refs })
  assert.deepEqual(dockLeadRefs(together, 'image').map((ref) => ref.kind), ['image', 'image', 'image'])
  // тип ещё «картинка», но подбор под видео обязан увидеть ролик роликом
  assert.deepEqual(dockLeadRefs(together, 'video').map((ref) => ref.kind), ['image', 'image', 'video'])
})

// ── отказ подбора ───────────────────────────────────────────────────────────

test('отказ «Авто»: плана и цены нет, причина названа, ручки умолчания на месте', () => {
  const refs = Array.from({ length: 17 }, (_, index) => imageRef(`i${index + 1}`))
  const plan = planDockLaunch(dockState({ batchMode: 'together', refs }))
  assert.equal(plan.batch.requests.length, 0)
  assert.equal(plan.batch.totalCost, null)
  assert.match(plan.batch.admission.error ?? '', /No model for type “Image” supports this set: 17 images/u)
  assert.equal(plan.selection.error, plan.batch.admission.error)
  assert.equal(plan.selection.panelModel?.id, 'chatgpt-image-2-edit')
})

test('ручная модель без пары отказывает словами, а не подменяется', () => {
  const lonely: CatalogModel = { id: 'lonely', name: 'Без референсов', kind: 'image', refs: false, params: [] }
  const plan = planDockLaunch(dockState({
    models: [lonely, ...LOCAL_DOCK_MODELS], modelId: 'lonely', refs: [imageRef('a')],
  }))
  assert.equal(plan.batch.requests.length, 0)
  assert.equal(plan.batch.admission.error, 'Model “Без референсов” does not accept images as a reference.')
})

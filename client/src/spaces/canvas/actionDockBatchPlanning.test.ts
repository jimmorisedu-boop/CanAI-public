import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogModel } from '../../types'
import type { SelectionRef } from './konva/selection'
import type { CanvasItem } from './konva/types'
import { planActionDockBatch, type DockModelSelection } from './actionDockBatchPlanning'
import { selectSmartModel, smartRefsFor } from './smartModelSelection'
import { LOCAL_DOCK_DEFAULTS, LOCAL_DOCK_MODELS } from './localDockCatalogTestKit'
import { estimateGenerationCost } from './generationEstimate'

const model: CatalogModel = {
  id: 'image-ref-model',
  name: 'Image ref model',
  kind: 'image',
  refs: true,
  maxImageRefs: 2,
  params: [],
}

function image(shapeId: string, src = '/media/shared.png', w = 100, h = 100): SelectionRef {
  return { shapeId, kind: 'image', label: shapeId, src, w, h }
}

function text(shapeId: string, value: string): SelectionRef {
  return { shapeId, kind: 'text', label: value, text: value }
}

function item(shapeId: string, w: number, h: number): CanvasItem {
  return {
    id: shapeId,
    kind: 'image',
    x: 0,
    y: 0,
    w,
    h,
    src: '/media/shared.png',
    naturalWidth: w,
    naturalHeight: h,
  } as CanvasItem
}

const accept = (picked: CatalogModel = model) => (): DockModelSelection => ({ model: picked, error: null })

/** Настоящий подбор: ручной выбор единственной модели каталога. */
const manual = (picked: CatalogModel, kind: 'image' | 'video' = 'image', sketchTarget: string | null = null) => (
  (refs: readonly SelectionRef[]) => selectSmartModel({
    models: [picked], kind, modelId: picked.id, refs: smartRefsFor(kind, refs, sketchTarget),
  })
)

function plan(over: Partial<Parameters<typeof planActionDockBatch>[0]> = {}) {
  return planActionDockBatch({
    kind: 'image',
    mode: 'each',
    refs: [image('one'), image('two')],
    prompt: 'сделай обложку',
    count: 2,
    params: {},
    sketchTarget: null,
    itemById: () => undefined,
    selectModel: accept(),
    ...over,
  })
}

test('каждый источник получает собственный anchor, Auto aspect и все варианты', () => {
  const result = plan({
    refs: [image('portrait', '/media/shared.png', 100, 200), image('landscape', '/media/shared.png', 200, 100)],
    itemById: (id) => id === 'portrait' ? item(id, 100, 200) : item(id, 200, 100),
  })

  assert.equal(result.admission.error, null)
  assert.equal(result.requests.length, 2)
  assert.equal(result.jobs, 4)
  assert.deepEqual(result.requests.map((request) => request.plan.anchorIds), [['portrait'], ['landscape']])
  assert.deepEqual(result.requests.map((request) => request.plan.aspect), [0.5, 2])
  assert.deepEqual(result.requests.map((request) => request.refs.map((ref) => ref.shapeId)), [['portrait'], ['landscape']])
})

test('план замораживает shape identity и src до последующей подготовки', () => {
  const source = image('source', '/media/before.png')
  const result = plan({ refs: [source], count: 1 })
  source.shapeId = 'changed-after-plan'
  source.src = '/media/after.png'

  assert.equal(result.requests[0]?.refs[0]?.shapeId, 'source')
  assert.equal(result.requests[0]?.refs[0]?.src, '/media/before.png')
})

test('пустой typed prompt переносит текстовый референс в prompt ровно один раз', () => {
  const result = plan({
    refs: [image('source'), text('note', 'тёплый свет')],
    prompt: '',
    count: 1,
  })
  const request = result.requests[0]
  assert.equal(request?.plan.text, 'тёплый свет')
  assert.deepEqual(request?.plan.refsToSend.map((ref) => ref.kind), ['image'])
})

test('together сохраняет один combined request и не разделяет count по источникам', () => {
  const result = plan({ mode: 'together', count: 3 })
  assert.equal(result.requests.length, 1)
  assert.equal(result.jobs, 3)
  assert.deepEqual(result.requests[0]?.refs.map((ref) => ref.shapeId), ['one', 'two'])
})

test('together сохраняет shape identity для переключения назад, но шлёт один logical src', () => {
  const oneRef = { ...model, maxImageRefs: 1 }
  const result = plan({
    mode: 'together',
    refs: [image('shape-a'), image('shape-b')],
    // Настоящий подбор: две карточки с одним файлом — один референс, и модель
    // с пределом в одну картинку такой набор обязана принять.
    selectModel: manual(oneRef),
  })
  const request = result.requests[0]
  assert.equal(result.admission.error, null)
  assert.deepEqual(request?.refs.map((ref) => ref.shapeId), ['shape-a', 'shape-b'])
  assert.deepEqual(request?.plan.refsToSend.map((ref) => ref.shapeId), ['shape-a'])
  assert.deepEqual(request?.plan.anchorIds, ['shape-a', 'shape-b'])
})

test('количество вариантов нормализуется единообразно для receipt и LaunchPlan', () => {
  const result = plan({ count: 9 })
  assert.equal(result.jobs, 8)
  assert.deepEqual(result.requests.map((request) => request.plan.jobs), [4, 4])
})

test('each mode resolves the model against each group refs, not the aggregate selection', () => {
  const seen: string[][] = []
  const groupModel = { ...model, maxImageRefs: 1 }
  const result = plan({
    refs: [image('left', '/media/left.png'), image('right', '/media/right.png')],
    count: 1,
    selectModel: (refs) => {
      seen.push(refs.map((ref) => ref.shapeId))
      return refs.filter((ref) => ref.kind === 'image').length > 1
        ? { model: null, error: 'весь набор эта модель не берёт' }
        : { model: groupModel, error: null }
    },
  })

  assert.equal(result.admission.error, null)
  assert.equal(result.jobs, 2)
  assert.deepEqual(result.requests.map((request) => request.refs.map((ref) => ref.shapeId)), [['left'], ['right']])
  // Подбор спрашивают ровно один раз на запрос и только про его собственный
  // набор: весь набор разом в «Изменить каждое» никуда не уходит.
  assert.deepEqual(seen, [['left'], ['right']])
})

// Переехало из actionDockBatch.test.ts: пределы модели теперь проверяет подбор,
// и правило осталось тем же — отказ раньше, чем допущен хоть один запрос.
test('model limits fail before any group is admitted', () => {
  const limited = plan({
    mode: 'together',
    refs: [image('a', '/media/a.png'), image('b', '/media/b.png'), image('c', '/media/c.png')],
    count: 1,
    selectModel: manual({ ...model, maxImageRefs: 2 }),
  })
  assert.equal(limited.jobs, 0)
  assert.equal(limited.requests.length, 0)
  assert.equal(limited.totalCost, null)
  assert.match(limited.admission.error ?? '', /accepts no more than 2 images \(selected: 3\)/u)

  const noRefs = plan({
    mode: 'together',
    refs: [image('a', '/media/a.png')],
    selectModel: manual({ ...model, refs: false, maxImageRefs: undefined }),
  })
  assert.equal(noRefs.jobs, 0)
  assert.match(noRefs.admission.error ?? '', /does not accept images as a reference/u)
})

test('отказ одной группы отменяет весь запуск, а не часть', () => {
  const result = plan({
    refs: [image('ok', '/media/ok.png'), image('bad', '/media/bad.png')],
    selectModel: (refs) => refs.some((ref) => ref.shapeId === 'bad')
      ? { model, error: 'этот исходник модель не берёт' }
      : { model, error: null },
  })
  assert.equal(result.admission.error, 'этот исходник модель не берёт')
  assert.equal(result.requests.length, 0)
  assert.equal(result.jobs, 0)
})

test('медиа-референс без файла отказывает раньше подбора модели', () => {
  const result = plan({
    refs: [{ shapeId: 'broken', kind: 'image', label: 'broken' }],
    selectModel: () => ({ model, error: 'до подбора дойти не должно' }),
  })
  assert.match(result.admission.error ?? '', /Select it again/u)
})

test('запрос несёт базовую модель и свою оценку', () => {
  const base: CatalogModel = { id: 'base', name: 'Base', kind: 'image', refs: false, pairId: 'base-edit', params: [] }
  const edit: CatalogModel = {
    id: 'base-edit', name: 'Base — по референсам', kind: 'image', refs: true, params: [],
    pricing: { unit: 'image', usd: 0.1 },
  }
  const result = plan({
    count: 2,
    selectModel: () => ({ model: edit, baseModel: base, error: null }),
  })
  assert.deepEqual(result.requests.map((request) => request.plan.model?.id), ['base-edit', 'base-edit'])
  assert.deepEqual(result.requests.map((request) => request.baseModel?.id), ['base', 'base'])
  assert.deepEqual(result.requests.map((request) => request.estimatedCost), [0.2, 0.2])
  assert.equal(result.totalCost, 0.4)
})

test('Seedance 2.0 с тремя картинками: в запуск, цену и ручки уходит вариант «по референсам»', () => {
  // Аудит моделей 19.10.2026, находка 4: прежде запуск не проходил вовсе —
  // «кадры» берут не больше двух картинок.
  const refs = [image('a', '/media/a.png'), image('b', '/media/b.png'), image('c', '/media/c.png')]
  const result = plan({
    kind: 'video',
    mode: 'together',
    refs,
    count: 1,
    params: { resolution: '720p', duration: '8' },
    selectModel: (picked) => selectSmartModel({
      models: LOCAL_DOCK_MODELS, defaults: LOCAL_DOCK_DEFAULTS, kind: 'video', modelId: 'seedance-2',
      refs: smartRefsFor('video', picked),
    }),
  })
  assert.equal(result.admission.error, null)
  const request = result.requests[0]!
  assert.equal(request.plan.model?.id, 'seedance-2-refs')
  assert.equal(request.baseModel?.id, 'seedance-2')
  assert.equal(request.plan.refsToSend.length, 3)
  // Цена — по той модели, что запустится. У fal оба варианта стоят одинаково
  // (0,014 $ за 1000 токенов, сверено 20.10.2026): 720p × 8 с.
  assert.equal(request.estimatedCost, estimateGenerationCost(request.plan.model, request.plan.params, 1, 3))
  assert.equal(request.estimatedCost, 2.4272)
})

test('скетч оценивается как один референс: уходит одна склейка', () => {
  const priced: CatalogModel = {
    ...model,
    maxImageRefs: 1,
    pricing: { unit: 'image', usd: 0.1, perReferenceUsd: 0.05 },
  }
  const refs = [image('target', '/media/target.png'), image('extra', '/media/extra.png')]
  const sketch = plan({
    mode: 'together',
    refs,
    count: 1,
    sketchTarget: 'target',
    itemById: (id) => item(id, 100, 200),
    selectModel: manual(priced, 'image', 'target'),
  })
  // выделено два объекта, но модель с пределом в одну картинку проходит,
  // и цена считает одну картинку
  assert.equal(sketch.admission.error, null)
  assert.equal(sketch.jobs, 1)
  assert.equal(sketch.totalCost, 0.15)
  assert.deepEqual(sketch.requests[0]?.plan.anchorIds, ['target'])
})

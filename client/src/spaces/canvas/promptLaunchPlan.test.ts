// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import type { CatalogModel } from '../../types'
import type { SelectionRef } from './konva/selection'
import type { CanvasItem } from './konva/types'
import { planGeneration, type LaunchPlanInput } from './promptLaunchPlan'

const model: CatalogModel = {
  id: 'pic',
  name: 'Картинка',
  kind: 'image',
  refs: false,
  params: [
    {
      name: 'aspect_ratio',
      label: 'Пропорции',
      widget: 'select',
      default: 'auto',
      options: ['auto', '1:1', '9:16'].map((value) => ({ value, label: value })),
    },
  ],
}

const img = (id: string, over: Partial<SelectionRef> = {}): SelectionRef => ({
  shapeId: id,
  kind: 'image',
  label: id,
  src: `/media/${id}.png`,
  ...over,
})
const txt = (id: string, text: string): SelectionRef => ({ shapeId: id, kind: 'text', label: text, text })

const item = (over: Partial<CanvasItem> = {}): CanvasItem => ({
  id: 'a',
  kind: 'image',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  ...over,
})

const plan = (over: Partial<LaunchPlanInput> = {}) =>
  planGeneration({
    kind: 'image',
    resolveModel: () => model,
    params: {},
    count: 1,
    refs: [],
    sketchTarget: null,
    typedPrompt: '',
    itemById: () => undefined,
    ...over,
  })

test('сетевые пропорции aspect задают и запрос, и форму заглушки', () => {
  const cloudModel: CatalogModel = {
    ...model,
    params: model.params.map((spec) => ({ ...spec, name: 'aspect' })),
  }
  for (const refs of [[], [img('a')]]) {
    const result = plan({
      resolveModel: () => cloudModel, typedPrompt: 'Портрет',
      params: { aspect: '9:16' }, refs, itemById: () => item(),
    })
    assert.equal(result.params.aspect, '9:16')
    assert.equal(result.aspect, 9 / 16)
  }
  assert.equal(plan({ resolveModel: () => cloudModel, params: { aspect: 'auto' },
    refs: [img('a')], itemById: () => item({ naturalWidth: 600, naturalHeight: 800 }),
  }).aspect, 3 / 4)
  const defaultPortrait = { ...cloudModel, params: cloudModel.params.map((spec) => ({ ...spec, default: '9:16' })) }
  assert.equal(plan({ resolveModel: () => defaultPortrait }).aspect, 9 / 16)
})

test('виртуальное «Авто» выбирает поддерживаемые пропорции по натуральному размеру фото', () => {
  const cloudModel: CatalogModel = {
    ...model,
    id: 'grok-image-hq',
    params: [{
      name: 'aspect', label: 'Пропорции', widget: 'select', default: '1:1',
      options: ['1:1', '3:4', '2:3', '16:9'].map(value => ({ value, label: value })),
    }],
  }
  const result = plan({
    resolveModel: () => cloudModel,
    typedPrompt: 'Портрет', params: { aspect: 'auto' }, refs: [img('a')],
    itemById: () => item({ w: 400, h: 400, naturalWidth: 1000, naturalHeight: 1500 }),
  })
  assert.equal(result.params.aspect, '2:3', 'сервер не получит отсутствующее в схеме auto')
  assert.equal(result.aspect, 2 / 3, 'заглушка совпадает с выбранной разрешённой пропорцией')
})

test('заглушка звука — плашка, а не квадрат', () => {
  // У звука пропорций нет, но заглушка обязана быть похожей на результат:
  // квадрат встал бы совсем не там, куда указывало ожидание, и готовый
  // объект прыгнул бы на другое место.
  const audio = plan({ kind: 'audio', typedPrompt: 'мягкий эмбиент' })
  assert.ok(audio.aspect > 3, `плашка вытянута по горизонтали, а не ${audio.aspect}`)
  // и счётчик «×N» к звуку не применяется — как и к видео
  assert.equal(audio.jobs, 1)
})

test('напечатанный промпт побеждает текстовый референс', () => {
  const result = plan({ typedPrompt: 'кот', refs: [txt('t', 'собака')] })
  assert.equal(result.text, 'кот')
})

// Сервер дописывает текст-референсы в конец промпта (withTextSuffix). Если
// текст УЖЕ стал промптом, отправить его ещё и референсом — значит задвоить
// фразу в том, за что заплачено.
test('ставший промптом текст не уходит ещё и референсом', () => {
  const result = plan({ typedPrompt: '', refs: [txt('t', 'нарисуй кота'), img('a')] })
  assert.equal(result.text, 'нарисуй кота')
  assert.deepEqual(result.refsToSend.map((ref) => ref.shapeId), ['a'])
})

test('при напечатанном промпте текстовый референс остаётся референсом', () => {
  const result = plan({ typedPrompt: 'в стиле нуар', refs: [txt('t', 'подсказка'), img('a')] })
  assert.deepEqual(result.refsToSend.map((ref) => ref.shapeId), ['t', 'a'])
})

test('пустой запуск виден по пустому тексту', () => {
  assert.equal(plan({ typedPrompt: '   ' }).text, '')
})

// Без hasMediaRefs «Авто» подменяется первой не-авто опцией, и портретный
// референс уезжает в квадрат — и в отправке, и в цене.
test('с медиа-референсом «Авто» доживает до отправки', () => {
  const withRef = plan({ typedPrompt: 'кот', refs: [img('a')] })
  assert.equal(withRef.params.aspect_ratio, 'auto')
  const withoutRef = plan({ typedPrompt: 'кот' })
  assert.notEqual(withoutRef.params.aspect_ratio, 'auto')
})

test('десктопный промпт отправляет «Авто» без референса', () => {
  const result = plan({
    typedPrompt: 'кот',
    params: { aspect_ratio: 'auto' },
    allowAutoWithoutRefs: true,
  })
  assert.equal(result.params.aspect_ratio, 'auto')
})

test('пропорции заглушки берутся по НАТУРАЛЬНЫМ размерам, а не по растянутым на холсте', () => {
  const result = plan({
    typedPrompt: 'кот',
    refs: [img('a')],
    // на холсте квадрат, а картинка портретная
    itemById: () => item({ w: 400, h: 400, naturalWidth: 900, naturalHeight: 1600 }),
  })
  assert.equal(result.aspect, 900 / 1600)
})

test('у ассета с полки размеры свои — на холсте его нет', () => {
  const result = plan({
    typedPrompt: 'кот',
    refs: [img('asset:2', { w: 1600, h: 900 })],
    itemById: () => undefined,
  })
  assert.equal(result.aspect, 1600 / 900)
})

test('заглушка не цепляется к ассету с полки — его нет на холсте', () => {
  const result = plan({ typedPrompt: 'кот', refs: [img('asset:2'), img('b')] })
  assert.deepEqual(result.anchorIds, ['b'])
})

test('в режиме скетча якорь и пропорции берутся у самой картинки', () => {
  const result = plan({
    typedPrompt: 'правь',
    sketchTarget: 's',
    itemById: () => item({ id: 's', w: 300, h: 150 }),
  })
  assert.deepEqual(result.anchorIds, ['s'])
  assert.equal(result.aspect, 2)
  assert.equal(result.hasImageRefs, true, 'скетч — это медиа-референс')
})

// Видео-референс поднимает видео-редактирующую модель ТОЛЬКО когда сами
// генерируем видео: для картинки то же видео уйдёт кадром (toGenRefs) и
// остаётся обычным image-референсом.
test('выбору модели сообщают, какие референсы на руках', () => {
  const seen: Array<[boolean, boolean]> = []
  const capture = (over: Partial<LaunchPlanInput>) =>
    plan({ typedPrompt: 'к', resolveModel: (i, v) => (seen.push([i, v]), model), ...over })

  capture({ refs: [img('v', { kind: 'video' })], kind: 'video' })
  capture({ refs: [img('v', { kind: 'video' })], kind: 'image' })
  capture({ refs: [] })

  assert.deepEqual(seen, [
    [true, true],
    [true, false],
    [false, false],
  ])
})

test('«количество» есть только у картинок', () => {
  assert.equal(plan({ typedPrompt: 'к', count: 4 }).jobs, 4)
  assert.equal(plan({ typedPrompt: 'к', count: 4, kind: 'video' }).jobs, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import type { CatalogModel } from '../../types'
import { loadSavedModelParams, saveModelParams } from './modelParamsStorage'
import { panelParams } from './genOptions'
import {
  applyPromptAspectSession,
  aspectForRefs,
  defaultModelId,
  rememberPromptAspectSession,
  resetPromptAspectSessionForTests,
  withoutPromptAspectPersistence,
} from './modelAspect'

const withAuto: CatalogModel = {
  id: 'edit', name: 'Edit', kind: 'image', refs: true,
  params: [{
    name: 'aspect_ratio', label: 'Пропорции', widget: 'select', default: 'auto',
    options: ['auto', '1:1', '9:16'].map((value) => ({ value, label: value })),
  }],
} as CatalogModel

const withoutAuto: CatalogModel = {
  ...withAuto,
  id: 'plain',
  params: [{
    name: 'aspect_ratio', label: 'Пропорции', widget: 'select', default: '4:3',
    options: ['4:3', '9:16'].map((value) => ({ value, label: value })),
  }],
} as CatalogModel

const cloudWithoutAuto: CatalogModel = {
  ...withoutAuto,
  id: 'grok-image-hq',
  params: [{
    name: 'aspect', label: 'Пропорции', widget: 'select', default: '1:1',
    options: ['1:1', '3:4', '2:3'].map(value => ({ value, label: value })),
  }],
}

test('сетевой модели без нативного auto предлагаем «Авто» только с фото', () => {
  const withPhoto = panelParams(cloudWithoutAuto, true, true, true)[0]
  const withoutPhoto = panelParams(cloudWithoutAuto, false, true, false)[0]
  assert.equal(withPhoto?.options?.[0]?.value, 'auto')
  assert.equal(withPhoto?.options?.[0]?.label, 'Auto')
  assert.equal(withoutPhoto?.options?.some(option => option.value === 'auto'), false)
  assert.equal(cloudWithoutAuto.params[0]?.options?.some(option => option.value === 'auto'), false,
    'серверная схема не подменяется интерфейсной')
})

test('с выбранным фото виртуальное «Авто» становится сессионным выбором', () => {
  resetPromptAspectSessionForTests()
  assert.equal(applyPromptAspectSession(cloudWithoutAuto, { aspect: '1:1' }, true).aspect, 'auto')
  rememberPromptAspectSession(cloudWithoutAuto, { aspect: '3:4' }, true)
  assert.equal(applyPromptAspectSession(cloudWithoutAuto, {}, true).aspect, '3:4')
  rememberPromptAspectSession(cloudWithoutAuto, { aspect: 'auto' }, true)
  assert.equal(applyPromptAspectSession(cloudWithoutAuto, {}, true).aspect, 'auto')
  assert.equal(applyPromptAspectSession(cloudWithoutAuto, {}, false).aspect, undefined,
    'без фото серверу нельзя обещать виртуальное auto')
  resetPromptAspectSessionForTests()
})

test('референс появился — пропорции становятся «Авто»', () => {
  assert.equal(aspectForRefs(withAuto, { aspect_ratio: '9:16' }, true).aspect_ratio, 'auto')
})

test('референс снят — «Авто» уступает конкретной пропорции', () => {
  // «Авто» не к чему привязать без референса, и модель получила бы мусор
  const next = aspectForRefs(withAuto, { aspect_ratio: 'auto' }, false)
  assert.notEqual(next.aspect_ratio, 'auto')
})

test('модель без «Авто» не получает его никогда', () => {
  assert.equal(aspectForRefs(withoutAuto, { aspect_ratio: '4:3' }, true).aspect_ratio, '4:3')
})

test('выбранная вручную пропорция без референса не трогается', () => {
  const current = { aspect_ratio: '9:16', quality: 'high' }
  assert.deepEqual(aspectForRefs(withAuto, current, false), current)
})

test('повторный вызов ничего не меняет — правило идемпотентно', () => {
  const once = aspectForRefs(withAuto, { aspect_ratio: '1:1' }, true)
  assert.deepEqual(aspectForRefs(withAuto, once, true), once)
})

test('десктопный промпт начинает с «Авто», если выбор в сессии не меняли', () => {
  resetPromptAspectSessionForTests()
  assert.equal(
    applyPromptAspectSession(withAuto, { aspect_ratio: '9:16' }).aspect_ratio,
    'auto',
  )
})

test('ручная пропорция десктопного промпта запоминается до конца сессии', () => {
  resetPromptAspectSessionForTests()
  rememberPromptAspectSession(withAuto, { aspect_ratio: '9:16' })

  assert.equal(applyPromptAspectSession(withAuto, {}).aspect_ratio, '9:16')
  assert.equal(
    applyPromptAspectSession({ ...withAuto, id: 'another' }, { aspect_ratio: 'auto' }).aspect_ratio,
    '9:16',
  )
})

test('если модель не знает запомненную пропорцию, десктоп временно показывает «Авто»', () => {
  resetPromptAspectSessionForTests()
  rememberPromptAspectSession(withAuto, { aspect_ratio: '9:16' })
  const onlySquare = {
    ...withAuto,
    params: withAuto.params.map((param) => ({
      ...param,
      options: ['auto', '1:1'].map((value) => ({ value, label: value })),
    })),
  }

  assert.equal(applyPromptAspectSession(onlySquare, {}).aspect_ratio, 'auto')
  assert.equal(applyPromptAspectSession(withAuto, {}).aspect_ratio, '9:16')
})

test('сессионная пропорция не уезжает в постоянный черновик', () => {
  assert.deepEqual(
    withoutPromptAspectPersistence({ aspect_ratio: '9:16', aspect: '16:9', quality: 'high' }),
    { quality: 'high' },
  )
})

test('сессионная пропорция удаляется из постоянной памяти параметров модели', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } })
  try {
    saveModelParams('model', { aspect_ratio: '9:16', quality: 'high' }, ['aspect_ratio', 'aspect'])
    assert.deepEqual(loadSavedModelParams().model, { quality: 'high' })
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('десктопный PromptBar подключает сессионное правило и для UI, и для отправки', async () => {
  const promptBarSource = await readFile(new URL('./PromptBar.tsx', import.meta.url), 'utf8')
  const selectionSource = await readFile(new URL('./useModelSelection.ts', import.meta.url), 'utf8')
  assert.match(promptBarSource, /promptAspectSession:\s*true/)
  assert.match(selectionSource, /allowAutoWithoutRefs:\s*promptAspectSession/)
  assert.match(promptBarSource, /params:\s*withoutPromptAspectPersistence\(params\)/)
})

test('модель по умолчанию: картинки — GPT Image 2, видео — первая базовая', () => {
  const models = [
    { id: 'nano-banana', name: 'Nano', kind: 'image', refs: false, params: [] },
    { id: 'chatgpt-image-2', name: 'GPT', kind: 'image', refs: false, params: [] },
    { id: 'seedance-2', name: 'Seedance', kind: 'video', refs: false, params: [] },
  ] as CatalogModel[]
  assert.equal(defaultModelId(models, 'image'), 'chatgpt-image-2')
  assert.equal(defaultModelId(models, 'video'), 'seedance-2')
  assert.equal(defaultModelId([], 'image'), null)
})

test('серверный глобальный дефолт важнее исторического клиентского выбора', () => {
  const models = [
    { id: 'chatgpt-image-2', name: 'GPT', kind: 'image', refs: false, params: [] },
    { id: 'grok-image', name: 'Grok', kind: 'image', refs: false, params: [] },
  ] as CatalogModel[]
  assert.equal(defaultModelId(models, 'image', {
    image: 'grok-image', video: null, audio: null, assistant: null,
  }), 'grok-image')
})

test('скрытый или несовместимый глобальный дефолт не ломает новый выбор', () => {
  const models = [
    { id: 'chatgpt-image-2', name: 'GPT', kind: 'image', refs: false, params: [] },
    { id: 'grok-image', name: 'Grok', kind: 'image', refs: false, lifecycle: 'archived', params: [] },
    { id: 'seedance-2', name: 'Seedance', kind: 'video', refs: false, params: [] },
  ] as CatalogModel[]
  assert.equal(defaultModelId(models, 'image', {
    image: 'grok-image', video: null, audio: null, assistant: null,
  }), 'chatgpt-image-2')
  assert.equal(defaultModelId(models, 'video', {
    image: null, video: 'chatgpt-image-2', audio: null, assistant: null,
  }), 'seedance-2')
})

/**
 * ⚠️ Правило «авто по референсу» обязано действовать и в нодах: там значения
 * засеиваются от БАЗОВОЙ модели (у Grok это 1:1), а по референсу включается её
 * edit-вариант, где «авто» и есть значение по умолчанию. Без общего правила
 * портретный референс давал квадратный результат (жалоба 07.09.2026).
 */
test('нода зовёт общее правило авто-пропорций, а не заводит своё', async () => {
  const source = await readFile(
    new URL('../nodes/GenNode.tsx', import.meta.url),
    'utf8',
  )
  // Нода зовёт общее правило через свою обёртку (на переходах, а не на каждое
  // изменение пропорции) — см. nodeAspect.ts и его тесты.
  assert.match(source, /createNodeAspectTracker\(/, 'GenNode обязан звать общее правило')
  const rule = await readFile(new URL('../nodes/nodeAspect.ts', import.meta.url), 'utf8')
  assert.match(rule, /aspectForRefs\(/, 'обёртка ноды не заводит своё правило пропорций')
  assert.match(
    source,
    /hasMediaRefs = mediaRefs\.hasImage \|\| mediaRefs\.hasVideo/,
    'медиа-референс — это картинка ИЛИ видео',
  )
})

test('правило знает оба имени параметра: aspect_ratio у своего каталога и aspect у сервера команды', () => {
  const cloud = {
    id: 'cloud', name: 'Cloud', kind: 'image',
    params: [{ name: 'aspect', label: 'Пропорции', widget: 'select', default: '4:3', options: [
      { value: 'auto', label: 'Авто' }, { value: '4:3', label: '4:3' }, { value: '9:16', label: '9:16' },
    ] }],
  } as unknown as Parameters<typeof aspectForRefs>[0]
  assert.deepEqual(aspectForRefs(cloud, { aspect: '4:3' }, true), { aspect: 'auto' })
  assert.deepEqual(aspectForRefs(cloud, { aspect: 'auto' }, false), { aspect: '4:3' })
  const chosen = { aspect: '9:16' }
  assert.equal(aspectForRefs(cloud, chosen, false), chosen)
})

// ⚠️ У канона сервера команды «Авто» ПО УМОЛЧАНИЮ значит «параметр не задан»:
// сервер не шлёт его провайдеру и принимает без референса. Подмена первым
// пунктом превращала ролик 16:9 в вертикаль (у Gemini Omni Flash первым стоит
// 9:16) или квадрат — на планшете после того, как тронули и сняли референс.
test('канон сервера команды: «Авто» по умолчанию не подменяется и не вырезается из списка', () => {
  const unset = {
    id: 'veo-omni', name: 'Gemini Omni Flash', kind: 'video',
    params: [
      { name: 'aspect', label: 'Пропорции', widget: 'select', default: 'auto', options: ['auto', '9:16', '16:9'].map((value) => ({ value, label: value })) },
      { name: 'size', label: 'Размер', widget: 'select', default: 'auto', options: ['auto', 'sd', 'hd'].map((value) => ({ value, label: value })) },
    ],
  } as unknown as CatalogModel
  const current = { aspect: 'auto' }
  assert.equal(aspectForRefs(unset, current, false), current, 'референс сняли — «не задано» остаётся')
  assert.equal(aspectForRefs(unset, { aspect: '16:9' }, true).aspect, 'auto', 'подключили — «Авто», как у всех')
  for (const param of panelParams(unset, false)) {
    assert.equal(param.options?.[0]?.value, 'auto', `${param.name}: «Авто» остаётся в списке и без референса`)
    assert.equal(param.default, 'auto')
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogModel, ParamSpec } from '../../types.js'
import type { MacroFile } from './macroFile.js'
import { adaptMacroFile } from './macroFileAdapt.js'
import { LOCAL_MODELS, TEAM_MODELS, assertRunnable, dataOf, edge, node, seeded, transfer } from './macroFileTestKit.js'

// «Авто» у пропорций и размера при переносе макроса: его судьба зависит от того,
// подключён ли к ноде референс. Остальные правила перевода параметров — в
// macroFileParams.test.ts.

// ⚠️ «Авто» у пропорций значит «решит модель по референсу». У своей доски базовый
// Grok такого значения не знает, а его вариант «по референсам» (он включается
// сам по подключённым входам) знает. Нода с подключённым референсом получала
// умолчание базовой модели: на сетевой доске кадр шёл в пропорциях референса, а
// после переноса на свою — квадратом. Молча: открытие редактора этого не чинит.
test('«Авто» у ноды с подключённым референсом переносится: его примет вариант модели «по референсам»', () => {
  const still = (id: string) => node(id, 'image', { prompt: 'x', model: 'grok-image', params: seeded(TEAM_MODELS, 'grok-image') })
  const clip = (id: string) => node(id, 'video', { prompt: 'x', model: 'grok-video', params: seeded(TEAM_MODELS, 'grok-video') })
  const imported = transfer('team', 'local', [
    node('in', 'input'), node('file', 'media'), node('words', 'note', { prompt: 'кот' }),
    still('byInput'), still('byFile'), still('free'), still('textOnly'),
    clip('byFrame'), clip('freeClip'),
  ], [
    edge('in', 'images', 'byInput', 'ref1'),
    edge('file', 'image', 'byFile', 'ref1'),
    edge('words', 'out', 'textOnly', 'prompt'),
    edge('byInput', 'out', 'byFrame', 'frame1'),
  ])
  for (const id of ['byInput', 'byFile']) {
    assert.deepEqual(dataOf(imported, id).params, { aspect_ratio: 'auto', resolution: '1k', num_images: 1 }, id)
    assert.equal(dataOf(imported, id).model, 'grok-image', 'в ноде остаётся базовая модель — вариант включится сам')
    assertRunnable(LOCAL_MODELS, dataOf(imported, id), id, 'grok-image-edit')
  }
  // Референса нет — «Авто» решать не по чему, и базовая модель его не примет:
  // остаётся её умолчание. Текст на входе «промпт» — не референс.
  for (const id of ['free', 'textOnly']) {
    assert.deepEqual(dataOf(imported, id).params, { aspect_ratio: '1:1', resolution: '1k', num_images: 1 }, id)
    assertRunnable(LOCAL_MODELS, dataOf(imported, id), id)
  }
  assert.deepEqual(dataOf(imported, 'byFrame').params, { aspect_ratio: 'auto', resolution: 'auto', duration: 5 })
  assertRunnable(LOCAL_MODELS, dataOf(imported, 'byFrame'), 'byFrame', 'grok-i2v')
  assert.deepEqual(dataOf(imported, 'freeClip').params, { aspect_ratio: '16:9', resolution: 'auto', duration: 5 })
  assertRunnable(LOCAL_MODELS, dataOf(imported, 'freeClip'), 'freeClip')
  assert.deepEqual(imported.notes, [])
})

test('по референсу переносится только «Авто» и только у пропорций и размера', () => {
  const pick = (name: string, label: string, fallback: string, values: string[]): ParamSpec => ({
    name, label, widget: 'select', default: fallback, options: values.map((value) => ({ value, label: value })),
  })
  const models = [
    { id: 'x', name: 'X', kind: 'image', pairId: 'x-edit', params: [
      pick('aspect_ratio', 'Пропорции', '1:1', ['1:1', '16:9']), pick('quality', 'Качество', 'high', ['low', 'high']),
    ] },
    { id: 'x-edit', name: 'X — по референсам', kind: 'image', refs: true, params: [
      pick('aspect_ratio', 'Пропорции', 'auto', ['auto', '1:1', '16:9', '2:1']), pick('quality', 'Качество', 'auto', ['auto', 'low', 'high']),
    ] },
    // Наоборот: «Авто» знает базовая модель, а её вариант — нет.
    { id: 'y', name: 'Y', kind: 'image', pairId: 'y-edit', params: [pick('aspect_ratio', 'Пропорции', 'auto', ['auto', '1:1'])] },
    { id: 'y-edit', name: 'Y — по референсам', kind: 'image', refs: true, params: [pick('aspect_ratio', 'Пропорции', '1:1', ['1:1', '16:9'])] },
  ] as CatalogModel[]
  const item = (id: string, params: Record<string, string>, model = 'x') => (
    { id, type: 'gen' as const, position: { x: 0, y: 0 }, data: { kind: 'image', prompt: 'x', status: 'idle' as const, model, params } }
  )
  const about = {
    aspect: { label: 'Пропорции', default: 'auto', values: { auto: 'Авто' } },
    quality: { label: 'Качество', default: 'high', values: { auto: 'Авто' } },
  }
  const file: MacroFile = {
    format: 'canai-macro', version: 1, name: 'x', catalog: 'team', modelNames: { x: 'X' },
    paramInfo: { x: about, 'y-edit': about },
    graph: {
      nodes: [
        { id: 'in', type: 'gen', position: { x: 0, y: 0 }, data: { kind: 'input', prompt: '', status: 'idle' } },
        item('auto', { aspect: 'auto', quality: 'auto' }), item('wide', { aspect: '2:1' }), item('free', { aspect: 'auto' }),
        item('variant', { aspect: 'auto' }, 'y-edit'),
      ],
      edges: [edge('in', 'images', 'auto', 'ref1'), edge('in', 'images', 'wide', 'ref1')],
    },
  }
  const imported = adaptMacroFile({ file, droppedFiles: 0 }, { catalog: 'local', models, defaultModelId: () => 'x' })
  assert.deepEqual(dataOf(imported, 'auto').params, { aspect_ratio: 'auto', quality: 'high' })
  assert.deepEqual(dataOf(imported, 'wide').params, { aspect_ratio: '1:1', quality: 'high' })
  assert.deepEqual(dataOf(imported, 'free').params, { aspect_ratio: '1:1', quality: 'high' })
  // В ноде записан сам вариант, и к ней ничего не подключено: сработает он, а не его базовая модель.
  assert.deepEqual(dataOf(imported, 'variant').params, { aspect_ratio: '1:1' })
  // За «Авто» у пропорций следит редактор: снимут референс — он вернёт ноде
  // пропорцию базовой модели. За «Авто» у качества и за «2:1», которые знает
  // только вариант, следить некому: без референса нода с ними не запустилась бы.
  assert.deepEqual(imported.notes, [
    '«Image» (X): setting «Качество» has no value here «Авто» - delivered by «high»',
    '«Image» (X): setting «Пропорции» has no value here «2:1» - delivered by «1:1»',
  ])
})

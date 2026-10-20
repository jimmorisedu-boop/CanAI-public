import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultNodeModelId } from '../nodes/nodeModel.js'
import type { NodeKind } from '../nodes/types.js'
import { buildMacroFile, readMacroFile, type MacroFile } from './macroFile.js'
import { TEAM_RUNNABLE_NODE_KINDS, adaptMacroFile } from './macroFileAdapt.js'
import {
  CATALOGS, LOCAL_MODELS, TEAM_MODELS, assertRunnable, dataOf, edge, node, seeded, target, transfer, type Side,
} from './macroFileTestKit.js'

// Макрос из файла — под каталог получателя: модели, виды нод и файлы. У своей
// доски и у сервера команды каталоги разные: id моделей, имена параметров,
// названия размеров и даже вид значений не совпадают. Принятый «как есть» макрос
// выглядел бы рабочим и падал на запуске («Неизвестная модель», «Неизвестный
// параметр: aspect_ratio»). Перевод самих параметров — в macroFileParams.test.ts.

test('файл встаёт в тот же каталог без единого замечания и без единой правки', () => {
  const nodes = [
    node('in', 'input'),
    node('img', 'image', { prompt: 'кот', model: 'chatgpt-image-2', params: { ...seeded(LOCAL_MODELS, 'chatgpt-image-2'), aspect_ratio: '9:16' } }),
    // Значение, годное только варианту «по референсам», в своём каталоге не трогаем.
    node('grok', 'image', { prompt: 'кот', model: 'grok-image', params: { ...seeded(LOCAL_MODELS, 'grok-image'), aspect_ratio: 'auto' } }),
    node('out', 'output'),
  ]
  const built = buildMacroFile({ name: 'Кожа лица', graph: { nodes, edges: [edge('in', 'images', 'img', 'ref1')] } }, 'local', LOCAL_MODELS)
  const imported = adaptMacroFile(readMacroFile(JSON.stringify(built.file)), target('local'))
  assert.equal(imported.name, 'Кожа лица')
  assert.deepEqual(imported.notes, [])
  assert.deepEqual(imported.graph, built.file.graph)
})

test('макрос со своей доски на сетевой: модель находится по имени, параметры переводятся', () => {
  const imported = transfer('local', 'team', [
    node('img', 'image', { prompt: 'кот', model: 'chatgpt-image-2', params: { ...seeded(LOCAL_MODELS, 'chatgpt-image-2'), aspect_ratio: '9:16', resolution: '2K' } }),
    node('flare', 'image', {
      prompt: 'кот', model: 'gpt-image-2.5-flare',
      params: { ...seeded(LOCAL_MODELS, 'gpt-image-2.5-flare'), resolution: '4K', quality: 'max', output_format: 'jpeg', output_compression: 80 },
    }),
    node('music', 'audio', { prompt: 'epic', model: 'lyria', params: seeded(LOCAL_MODELS, 'lyria') }),
  ])
  assert.equal(dataOf(imported, 'img').model, 'gpt-image-2')
  assert.deepEqual(dataOf(imported, 'img').params, { aspect: '9:16', size: '2k', format: 'png' })
  assert.deepEqual(dataOf(imported, 'flare').params, {
    aspect: '4:3', size: '4k', quality: 'max', background: 'auto', format: 'jpeg', compression: 80,
  })
  assert.deepEqual(dataOf(imported, 'music').params, { seed: -1, negative: 'low quality' })
  assert.deepEqual(imported.notes, [], 'та же модель под другим id — не замена; умолчания — не потеря')
})

test('макрос с сетевой доски на свою: то же в обратную сторону', () => {
  const imported = transfer('team', 'local', [
    node('img', 'image', { prompt: 'кот', model: 'gpt-image-2', params: { aspect: '9:16', size: '2k', format: 'png' } }),
    node('clip', 'video', { prompt: 'кот', model: 'grok-video', params: { aspect: '3:4', size: 'sd', duration: 9 } }),
  ])
  assert.equal(dataOf(imported, 'img').model, 'chatgpt-image-2')
  assert.deepEqual(dataOf(imported, 'img').params, { aspect_ratio: '9:16', resolution: '2K', quality: 'high', num_images: 1 })
  // У своей доски «Grok Video» зовутся две модели — берётся базовая, вариант включится сам.
  assert.equal(dataOf(imported, 'clip').model, 'grok')
  assert.deepEqual(dataOf(imported, 'clip').params, { aspect_ratio: '3:4', resolution: '480p', duration: 9 })
  assert.deepEqual(imported.notes, [])
})

// ⚠️ Находка проверки 02.10.2026: нода без модели (так выглядят ноды старых
// макросов) шла в чужой каталог как есть. Системный промпт LLM и настройки
// оставались под именами каталога автора — «Неизвестный параметр: system_prompt»,
// «…: aspect_ratio», — а картинку и видео без модели сервер команды не запускает
// вовсе. Кнопка выглядела готовой и падала на запуске.
test('нода без модели в чужой каталог «как есть» не идёт: модель по умолчанию, настройки переведены', () => {
  const bare = [
    node('llm', 'text', { prompt: 'улучши промпт', params: { system_prompt: 'Ты арт-директор', temperature: 0.7 } }),
    node('img', 'image', { prompt: 'кот', params: { aspect_ratio: '9:16', resolution: '2K' } }),
    node('img2', 'image', { prompt: 'пёс' }),
    node('clip', 'video', { prompt: 'оживи' }),
  ]
  const toTeam = transfer('local', 'team', bare)
  assert.deepEqual(dataOf(toTeam, 'llm'), {
    kind: 'text', prompt: 'Ты арт-директор\n\nулучши промпт', status: 'idle', model: 'gemini', params: {},
  })
  assert.deepEqual(dataOf(toTeam, 'img').params, { aspect: '9:16', size: '2k', seed: -1, format: 'png' })
  assert.equal(dataOf(toTeam, 'img').model, 'nano-banana')
  assert.equal(dataOf(toTeam, 'clip').model, 'seedance-2')
  assert.deepEqual(toTeam.notes, [
    '«LLM» (Gemini Flash): no model was selected in the node - the default model was set',
    '«Image» (Nano Banana 2): no model was selected in the node - the default model was set (in 2 nodes)',
    '«Video» (Seedance 2.0): no model was selected in the node - the default model was set',
    '«LLM» (Gemini Flash): the system prompt has been moved to the beginning of the node prompt - there is no separate field for it here',
    // Температуру выбирал автор или нет, файл о ноде без модели не помнит.
    '«LLM» (Gemini Flash): some of the settings from the file do not apply here - check the node in the editor',
  ])
  for (const item of toTeam.graph.nodes) assertRunnable(TEAM_MODELS, item.data, item.id)

  // Обратно — то же: имена настроек сервера команды своему серверу незнакомы.
  const toLocal = transfer('team', 'local', [node('img', 'image', { prompt: 'кот', params: { aspect: '9:16', size: '2k' } })])
  assert.equal(dataOf(toLocal, 'img').model, 'nano-banana')
  assert.deepEqual(dataOf(toLocal, 'img').params, { aspect_ratio: '9:16', resolution: '2K', num_images: 1, seed: -1 })
  assert.deepEqual(toLocal.notes, ['«Image» (Nano Banana 2): no model was selected in the node - the default model was set'])
  assertRunnable(LOCAL_MODELS, dataOf(toLocal, 'img'), 'с сетевой на свою')

  // В свой каталог нода встаёт нетронутой: модель ей подставит редактор.
  const same = transfer('local', 'local', bare)
  assert.deepEqual(same.notes, [])
  assert.deepEqual(same.graph.nodes.map((item) => item.data.model), [undefined, undefined, undefined, undefined])
  assert.deepEqual(dataOf(same, 'llm').params, { system_prompt: 'Ты арт-директор', temperature: 0.7 })
})

// ⚠️ Текст из буфера прежнего приложения не помнит, чей каталог у графа. Раньше
// он считался «своим»: макрос, скопированный на сетевой доске, вставал на свою
// как есть — с `aspect` и `size`, — и свой сервер отказывал такой ноде на запуске.
test('текст из буфера прежнего приложения сверяется с каталогом получателя всегда', () => {
  const pasted = (params: Record<string, unknown>, side: Side) => adaptMacroFile(readMacroFile(JSON.stringify({
    type: 'canai-macro', name: 'Старый',
    graph: { nodes: [node('img', 'image', { prompt: 'x', model: 'nano-banana', params })], edges: [] },
  })), target(side))
  const own = seeded(LOCAL_MODELS, 'nano-banana')

  // Скопирован на сетевой доске, вставлен на свою: модель с тем же id, а имена параметров чужие.
  const toLocal = pasted({ aspect: '9:16', size: '2k', seed: 5 }, 'local')
  assert.deepEqual(dataOf(toLocal, 'img').params, { aspect_ratio: '9:16', resolution: '2K', num_images: 1, seed: 5 })
  assert.deepEqual(toLocal.notes, [])
  assertRunnable(LOCAL_MODELS, dataOf(toLocal, 'img'), 'с сетевой на свою')

  // Скопирован и вставлен на своей доске — параметры те же.
  const same = pasted({ ...own, aspect_ratio: '9:16' }, 'local')
  assert.deepEqual(dataOf(same, 'img').params, { ...own, aspect_ratio: '9:16' })
  assert.deepEqual(same.notes, [])

  // Скопирован на своей, вставлен на сетевую.
  const toTeam = pasted({ ...own, aspect_ratio: '9:16', resolution: '2K' }, 'team')
  assert.deepEqual(dataOf(toTeam, 'img').params, { aspect: '9:16', size: '2k', seed: -1, format: 'png' })
  assert.deepEqual(toTeam.notes, [])
  assertRunnable(TEAM_MODELS, dataOf(toTeam, 'img'), 'со своей на сетевую')
})

// ⚠️ Сервер команды исполняет не все виды нод: на «Видео + звук» и «Достать
// звук» он отвечает «В макросе есть неподдерживаемая нода» — всему макросу и уже
// на запуске. Граф при этом сохраняет, так что кнопка выглядела рабочей.
test('ноды, которые у получателя не работают, названы сразу при загрузке', () => {
  const nodes = [
    node('in', 'input'),
    node('clip', 'video', { prompt: 'x', model: 'seedance-2', params: { ...seeded(LOCAL_MODELS, 'seedance-2'), duration: '8' } }),
    node('mux', 'muxAudio'), node('mux2', 'muxAudio'), node('cut', 'extractAudio'),
    node('up', 'other', { model: 'seedvr-seamless-upscale', params: seeded(LOCAL_MODELS, 'seedvr-seamless-upscale') }),
    node('out', 'output'),
  ]
  const toTeam = transfer('local', 'team', nodes)
  assert.deepEqual(toTeam.notes, [
    'Nodes do not work on the network board: «Video + sound», «Extract audio», «Other» - the macro will not run with them',
  ])
  // Для «Другого» у сервера команды нет ни одной модели: выбирать в ноде нечего.
  assert.deepEqual(dataOf(toTeam, 'up'), { kind: 'other', prompt: '', status: 'idle' })
  assert.ok(!toTeam.notes.some((note) => /выберите модель/.test(note)), 'совет, которому нельзя последовать, не даём')
  assert.deepEqual(transfer('local', 'local', nodes).notes, [], 'на своей доске всё это работает')
})

test('список видов нод, которые исполняет сервер команды, — двойник его правила', () => {
  // canai-cloud: macroQuotePlan в src/macros/runs.ts и processRun в worker.ts.
  // Меняется набор там — менять и здесь, и в TEAM_RUNNABLE_NODE_KINDS.
  assert.deepEqual([...TEAM_RUNNABLE_NODE_KINDS].sort(), [
    'audio', 'combine', 'image', 'input', 'media', 'note', 'other', 'output', 'text', 'video',
  ])
})

test('нода из другой версии CanAI и вид без моделей — тоже «не работают», каждому получателю свои слова', () => {
  const text = JSON.stringify({
    format: 'canai-macro', version: 1, name: 'x', catalog: 'local', modelNames: { 'seedance-2': 'ByteDance Seedance 2.0' },
    graph: { nodes: [
      node('w', 'wait'), node('v', 'video', { prompt: 'x', model: 'seedance-2', params: { duration: '12' } }),
      node('bare', 'video', { prompt: 'x' }),
    ], edges: [] },
  })
  const noVideo = { ...target('team'), models: TEAM_MODELS.filter((model) => model.kind !== 'video'), defaultModelId: () => null }
  const toTeam = adaptMacroFile(readMacroFile(text), noVideo)
  assert.deepEqual(toTeam.notes, [
    'Nodes do not work on the network board: unknown node "wait", «Video» - the macro will not run with them',
  ])
  assert.deepEqual(dataOf(toTeam, 'v'), { kind: 'video', prompt: 'x', status: 'idle' })
  assert.deepEqual(adaptMacroFile(readMacroFile(text), target('local')).notes, [
    'Nodes do not work here: unknown node "wait" - their part of the macro will not be executed',
  ])

  // Нода без модели в своём каталоге остаётся как есть: модель ей подставит
  // редактор. Но если подставлять нечего — о ней сказано и здесь.
  const models = TEAM_MODELS.filter((model) => model.kind !== 'video')
  const teamWithoutVideo = { catalog: 'team' as const, models, defaultModelId: (kind: string) => defaultNodeModelId(models, kind as NodeKind) }
  const bare = JSON.stringify({
    format: 'canai-macro', version: 1, name: 'x', catalog: 'team', modelNames: {},
    graph: { nodes: [node('clip', 'video', { prompt: 'x' }), node('img', 'image', { prompt: 'x' })], edges: [] },
  })
  const kept = adaptMacroFile(readMacroFile(bare), teamWithoutVideo)
  assert.deepEqual(kept.notes, ['Nodes do not work on the network board: «Video» - the macro will not run with them'])
  assert.deepEqual(kept.graph.nodes.map((item) => item.data.model), [undefined, undefined])
})

// ⚠️ Реестр видов нод в редакторе — обычный объект: вид `constructor` сходил за
// знакомый, а в замечании назывался «undefined».
test('вид ноды со служебным именем объекта — неизвестная нода, а не «undefined»', () => {
  for (const kind of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const file: MacroFile = {
      format: 'canai-macro', version: 1, name: 'x', catalog: 'local', modelNames: {},
      graph: { nodes: [{ id: 'a', type: 'gen', position: { x: 0, y: 0 }, data: { kind, prompt: 'x', status: 'idle' } }], edges: [] },
    }
    assert.deepEqual(adaptMacroFile({ file, droppedFiles: 0 }, target('team')).notes, [
      `Nodes do not work on the network board: unknown node "${kind}" - the macro will not run with them`,
    ])
    assert.deepEqual(adaptMacroFile({ file, droppedFiles: 0 }, target('local')).notes, [
      `Nodes do not work here: unknown node "${kind}" - their part of the macro will not be executed`,
    ])
  }
})

// ⚠️ Таблицы соответствий были обычными объектами: по имени `constructor` или
// `toString` из них доставалась служебная функция, и загрузка падала с
// «(PARAM_ALIASES[name] ?? []) is not iterable», а модель с таким id попадала в
// замечание как «function Object() { [native code] }».
test('служебные имена объекта в параметрах, размерах и моделях не роняют загрузку', () => {
  const params = JSON.parse('{"constructor":"x","toString":"y","__proto__":"z","resolution":"constructor","aspect_ratio":"toString"}') as Record<string, string>
  const hostile = (id: string, model: string) => ({
    id, type: 'gen' as const, position: { x: 0, y: 0 }, data: { kind: 'image', prompt: 'x', status: 'idle' as const, model, params },
  })
  const file: MacroFile = {
    format: 'canai-macro', version: 1, name: 'x', catalog: 'local', modelNames: {},
    graph: { nodes: [hostile('a', 'constructor'), hostile('b', '__proto__'), hostile('c', 'chatgpt-image-2')], edges: [] },
  }
  for (const side of ['team', 'local'] as Side[]) {
    const imported = adaptMacroFile({ file, droppedFiles: 0 }, target(side))
    const said = imported.notes.join('\n')
    assert.ok(!/function|native code|is not iterable|undefined|\[object/.test(said), said)
    assert.ok(imported.notes.some((note) => note.startsWith('Model "constructor" replaced with "')), said)
    for (const item of imported.graph.nodes) {
      if (item.data.model !== 'chatgpt-image-2') assertRunnable(CATALOGS[side], item.data, `${side}, ${item.id}`)
    }
  }

  // Файл помнит параметры своей модели — и по служебному имени из этой памяти
  // тоже ничего не достаётся: ни «сведений» о модели `constructor`, ни
  // «настройки» `toString`.
  const remembering: MacroFile = {
    ...file,
    modelNames: { 'chatgpt-image-2': 'GPT Image 2' },
    paramInfo: { 'chatgpt-image-2': { aspect_ratio: { label: 'Пропорции', default: '4:3' }, resolution: { label: 'Разрешение', default: '1K' } } },
    graph: { nodes: [hostile('a', 'constructor'), hostile('c', 'chatgpt-image-2')], edges: [] },
  }
  assert.deepEqual(adaptMacroFile({ file: remembering, droppedFiles: 0 }, target('team')).notes, [
    'Model "constructor" replaced with "Nano Banana 2"',
    // О модели `constructor` файл ничего не помнит: выбирал ли автор значения, неизвестно.
    '«Image» (Nano Banana 2): setting «Size» has no value here «constructor» - delivered by «Auto»',
    '«Image» (Nano Banana 2): setting «Aspect ratio» has no value here «toString» - delivered by «Auto»',
    '«Image» (Nano Banana 2): some of the settings from the file do not apply here - check the node in the editor',
    // О своей модели помнит: названы настройки автора, а «настройки» со служебными именами — мусор.
    '«Image» (GPT Image 2): setting «Разрешение» has no value here «constructor» - delivered by «Auto»',
    '«Image» (GPT Image 2): setting «Пропорции» has no value here «toString» - delivered by «Auto»',
  ])
})

test('модели у получателя нет — берётся модель по умолчанию, и об этом сказано', () => {
  const imported = transfer('team', 'local', [
    node('a', 'text', { prompt: 'x', model: 'gpt-6-astra', params: {} }),
  ])
  assert.equal(dataOf(imported, 'a').model, 'gemini')
  assert.deepEqual(dataOf(imported, 'a').params, { system_prompt: '', temperature: 1, max_tokens: 1024 })
  assert.deepEqual(imported.notes, ['Model "GPT-6 Astra" replaced with "Gemini 3.8 Flash"'])
})

test('модель другого вида ноде не оставляем: картинке — модель картинок', () => {
  // В файле у ноды «Картинка» стоит текстовая модель — такой id у получателя есть, но не того вида.
  const imported = transfer('local', 'local', [node('img', 'image', { prompt: 'кот', model: 'gemini', params: { temperature: 1 } })])
  assert.equal(dataOf(imported, 'img').model, 'nano-banana')
  assert.deepEqual(imported.notes, ['Model "Gemini 3.8 Flash" replaced with "Nano Banana 2"'])
  assertRunnable(LOCAL_MODELS, dataOf(imported, 'img'), 'img')
})

// ⚠️ Замечание «файл не переносится» раньше выходило про ЛЮБУЮ ноду «Файл».
test('о файле ноды «Файл» сказано, только если он был и остался у автора', () => {
  const withFile = (id: string) => node(id, 'media', { result: { url: `/media/${id}.png`, mime: 'image/png' } })
  assert.deepEqual(transfer('local', 'team', [withFile('a'), node('out', 'output')]).notes, [
    'The file in the “File” node is not transferred - select it again',
  ])
  assert.deepEqual(transfer('local', 'local', [withFile('a'), withFile('b')]).notes, [
    'Files in the “File” nodes are not transferred - select them again (node: 2)',
  ])
  assert.deepEqual(transfer('local', 'team', [node('slot', 'media', { assetSlot: 0 }), node('empty', 'media')]).notes, [])
})

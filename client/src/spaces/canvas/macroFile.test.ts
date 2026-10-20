import assert from 'node:assert/strict'
import test from 'node:test'
import { libraryFileName } from './libraryFile.js'
import { buildMacroFile, readMacroFile } from './macroFile.js'
import { LOCAL_MODELS, edge, fileText, node, refused, seeded } from './macroFileTestKit.js'

// Просьба владельца 01.10.2026: «пусть каждый сам себе настраивает, но
// предусмотри возможность их сохранять и обмениваться друг между другом».
// Файл приходит извне — эти тесты про то, чему в нём нельзя верить. Подгонка
// под каталог получателя проверяется в macroFileAdapt.test.ts.

const graph = {
  nodes: [
    { ...node('in', 'input', { status: 'done' }), selected: true, measured: { width: 240, height: 150 } },
    {
      ...node('img', 'image', {
        prompt: 'кот', status: 'done', model: 'chatgpt-image-2',
        params: { ...seeded(LOCAL_MODELS, 'chatgpt-image-2'), aspect_ratio: '9:16', resolution: '2K' },
        result: { url: '/media/result.png' }, outputHistory: [{ url: '/media/old.png' }], jobId: 'job-1', restoredAt: 3,
        collapsed: true,
      }),
      position: { x: 300, y: 10 },
    },
    node('file', 'media', { result: { url: '/media/мой-файл.png' } }),
    node('asset', 'media', { assetSlot: 2 }),
  ],
  edges: [
    edge('in', 'images', 'img', 'ref1'),
    { id: 'e2', source: 'in', target: 'нет-такой', sourceHandle: 'images', targetHandle: 'ref1' },
  ],
}

test('в файл уходит сам макрос, а не следы прогона и не ссылки на файлы этого компьютера', () => {
  const { file, droppedFiles } = buildMacroFile({ name: 'Кожа лица', graph }, 'local', LOCAL_MODELS)
  assert.equal(file.format, 'canai-macro')
  assert.equal(file.catalog, 'local')
  assert.deepEqual(file.modelNames, { 'chatgpt-image-2': 'GPT Image 2' })
  const text = JSON.stringify(file)
  for (const leak of ['/media/', 'job-1', 'outputHistory', 'restoredAt', 'measured', 'selected']) {
    assert.ok(!text.includes(leak), `в файле не должно быть «${leak}»`)
  }
  assert.equal(droppedFiles, 1, 'файл из ноды «Файл» не переносится — об этом надо сказать')
  assert.deepEqual(file.missingFiles, ['file'], 'нода, привязанная к ассету, своего файла не теряет')
  assert.equal(file.graph.edges.length, 1, 'связь в никуда отброшена')
  const image = file.graph.nodes.find((item) => item.id === 'img')!
  assert.deepEqual(image.position, { x: 300, y: 10 })
  assert.deepEqual(image.data, {
    kind: 'image', prompt: 'кот', status: 'idle', model: 'chatgpt-image-2',
    params: { aspect_ratio: '9:16', resolution: '2K', quality: 'high', num_images: 1 }, collapsed: true,
  })
  assert.deepEqual(file.graph.nodes.find((item) => item.id === 'asset')!.data, { kind: 'media', prompt: '', status: 'idle', assetSlot: 2 })
})

// По этим подписям и умолчаниям получателю говорят словами, что не перенеслось
// и меняет ли это что-нибудь: его собственный каталог чужих параметров не знает.
test('файл помнит, как автор видел параметры своих моделей', () => {
  const { file } = buildMacroFile({ name: 'm', graph }, 'local', LOCAL_MODELS)
  const info = file.paramInfo!['chatgpt-image-2']!
  assert.equal(info.aspect_ratio!.label, 'Aspect ratio')
  assert.equal(info.aspect_ratio!.default, '4:3')
  assert.equal(info.aspect_ratio!.values!.auto, 'Auto')
  assert.equal(info.quality!.values!.low, 'Low')
  assert.equal(info.num_images!.default, 1)
  // «Авто» у пропорций Grok знает только вариант «по референсам» — подпись берётся и оттуда.
  const grok = buildMacroFile({ name: 'm', graph: { nodes: [node('g', 'image', { model: 'grok-image' })], edges: [] } }, 'local', LOCAL_MODELS)
  assert.equal(grok.file.paramInfo!['grok-image']!.aspect_ratio!.default, '1:1', 'умолчание — базовой модели')
  assert.equal(grok.file.paramInfo!['grok-image']!.aspect_ratio!.values!.auto, 'Auto')
})

test('файл читается обратно тем же, каким был собран', () => {
  const built = buildMacroFile({ name: 'Кожа лица', graph }, 'local', LOCAL_MODELS)
  const back = readMacroFile(JSON.stringify(built.file, null, 2))
  assert.deepEqual(back.file, built.file)
  assert.equal(back.droppedFiles, 1)
})

// ⚠️ Раньше из файла шли любые поля ноды, кроме восьми «следов прогона»: файл в
// 18 КБ с глубоко вложенным мусором раздувал macros.json на 17 МБ, а ссылки в
// незнакомых полях доезжали до библиотеки и до сервера команды.
test('из ноды берётся только белый список полей: мусор любой глубины до графа не доходит', () => {
  const deep = (depth: number, core: unknown): unknown => {
    let value = core
    for (let level = 0; level < depth; level++) value = { a: value }
    return value
  }
  const { file } = readMacroFile(fileText([{
    id: 'n', type: 'custom-type', position: { x: 'лево', y: Number.MAX_VALUE }, hidden: true, parentId: 'x', className: 'evil',
    data: {
      kind: 'image', prompt: 'кот', status: 'running', model: 'chatgpt-image-2', collapsed: 'да', assetSlot: 2.5,
      junk: deep(3000, 1), previewSrc: '/media/чужое.png', media: { result: { url: 'https://example.com/x.png' } },
      params: {
        aspect_ratio: '9:16', seed: 7, enable_safety_checker: false,
        nested: { deeper: deep(50, '/media/x.png') }, list: [1, 2], nothing: null, huge: Number.POSITIVE_INFINITY,
        'bad name': 'x', constructor: 'x', toString: 'x', __proto__: 'x',
      },
    },
  }]))
  assert.deepEqual(file.graph.nodes, [{
    id: 'n', type: 'gen', position: { x: 0, y: 1_000_000 },
    data: {
      kind: 'image', prompt: 'кот', status: 'idle', model: 'chatgpt-image-2',
      params: { aspect_ratio: '9:16', seed: 7, enable_safety_checker: false },
    },
  }])
  assert.ok(JSON.stringify(file).length < 2000, 'мусор в библиотеку не едет')
})

test('у ноды не бывает больше шести десятков параметров', () => {
  const params = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`p${index}`, index]))
  const { file } = readMacroFile(fileText([node('n', 'image', { params })]))
  assert.equal(Object.keys(file.graph.nodes[0]!.data.params!).length, 60)
})

test('связей из файла берётся не больше восьмисот', () => {
  const edges = Array.from({ length: 900 }, (_, index) => ({ id: `e${index}`, source: 'a', target: 'b' }))
  const { file } = readMacroFile(fileText([node('a', 'note', { prompt: 'x' }), node('b', 'output')], edges))
  assert.equal(file.graph.edges.length, 800)
  assert.equal(file.graph.edges.at(-1)!.id, 'e799', 'берутся первые, по порядку файла')
})

// ⚠️ Прежняя проверка обходила граф на двенадцать уровней вглубь: встроенная
// картинка на тринадцатом доезжала до библиотеки.
test('встроенная картинка — отказ на любой глубине', () => {
  for (const depth of [1, 13, 40, 5000]) {
    let junk: unknown = 'data:image/png;base64,AAAA'
    for (let level = 0; level < depth; level++) junk = { a: [junk] }
    refused(() => readMacroFile(fileText([node('n', 'note', { prompt: 'x', junk })])), /embedded images/, `глубина ${depth}`)
    refused(
      () => buildMacroFile({ name: 'm', graph: { nodes: [node('n', 'note', { prompt: 'x', junk })], edges: [] } }, 'local', LOCAL_MODELS),
      /built-in pictures - we do not save such a macro/,
      `сохранение, глубина ${depth}`,
    )
  }
})

// ⚠️ Прежняя проверка принимала за картинку любой текст со слова «data:» в
// начале: макрос с такой заметкой не сохранялся в файл — с сообщением про картинки.
test('текст, который начинается со слова «data:», — обычный текст', () => {
  for (const prompt of ['data:\n  brand: вермилион', 'Data: use the brand palette', 'data: 2026-10-01, продажи выросли']) {
    const built = buildMacroFile({ name: 'm', graph: { nodes: [node('n', 'note', { prompt })], edges: [] } }, 'local', LOCAL_MODELS)
    assert.equal(readMacroFile(JSON.stringify(built.file)).file.graph.nodes[0]!.data.prompt, prompt)
  }
})

// ⚠️ Цвет по типу данных редактор ставит ОДИН раз — при соединении — и хранит в
// style связи. Без него связи после загрузки вставали серыми и тонкими.
test('связь переносится вместе с оформлением, и только с проверенным', () => {
  const built = buildMacroFile({ name: 'm', graph }, 'local', LOCAL_MODELS)
  assert.deepEqual(built.file.graph.edges[0], {
    id: 'xy-edge__inimages-imgref1', source: 'in', target: 'img', sourceHandle: 'images', targetHandle: 'ref1',
    style: { stroke: '#3fb950', strokeWidth: 2 }, animated: true,
  })
  const look = (item: Record<string, unknown>) => {
    const { file } = readMacroFile(fileText(
      [node('a', 'note', { prompt: 'x' }), node('b', 'output')],
      [{ id: 'e', source: 'a', target: 'b', ...item }],
    ))
    const { id: _id, source: _source, target: _target, ...rest } = file.graph.edges[0]!
    return rest
  }
  assert.deepEqual(look({ style: { stroke: 'var(--port-text)', strokeWidth: 1.5 }, animated: false }), {
    style: { stroke: 'var(--port-text)', strokeWidth: 1.5 }, animated: false,
  })
  // Чужая строка стиля в разметку не попадает: ни адрес, ни выражение, ни линия во весь экран.
  for (const stroke of ['url(https://example.com/x.svg)', 'red; background: url(x)', 'expression(alert(1))', 'var(--x); color: red', '#12345', 7]) {
    assert.deepEqual(look({ style: { stroke } }), {}, String(stroke))
  }
  for (const strokeWidth of [0, 1000, -2, '2', Number.NaN]) assert.deepEqual(look({ style: { strokeWidth } }), {}, String(strokeWidth))
  assert.deepEqual(
    look({ style: { stroke: '#3FB950', opacity: 0, display: 'none' }, hidden: true, className: 'x', type: 'step', animated: 'да', sourceHandle: 'плохой порт' }),
    { style: { stroke: '#3FB950' } },
  )
})

// ⚠️ Раньше получателю говорилось «файл не переносится» про любую ноду «Файл» —
// и про привязанную к ассету, и про ту, где файла не было вовсе.
test('о пропавшем файле ноды «Файл» говорится, только когда он и правда был', () => {
  const nodes = [node('own', 'media'), node('empty', 'media'), node('asset', 'media', { assetSlot: 1 }), node('o', 'output')]
  assert.equal(readMacroFile(fileText(nodes, [], { missingFiles: ['own', 'asset', 'нет-такой'] })).droppedFiles, 1)
  assert.deepEqual(readMacroFile(fileText(nodes, [], { missingFiles: ['own'] })).file.missingFiles, ['own'])
  assert.equal(readMacroFile(fileText(nodes, [], { missingFiles: [] })).droppedFiles, 0)
  // Файл прежнего вида пометки не несёт: там считаем, что файл был.
  assert.deepEqual(readMacroFile(fileText(nodes)).file.missingFiles, ['own', 'empty'])
  // Прежний буфер обмена несёт граф как есть — ссылка видна сама.
  const clipboard = JSON.stringify({ type: 'canai-macro', name: 'x', graph: { nodes: [
    node('own', 'media', { result: { url: '/media/a.png' } }), node('cloud', 'media', { result: { assetId: 'ast_1' } }),
    node('empty', 'media'), node('asset', 'media', { assetSlot: 0, result: { url: '/media/b.png' } }),
  ], edges: [] } })
  const read = readMacroFile(clipboard)
  assert.deepEqual(read.file.missingFiles, ['own', 'cloud'])
  assert.ok(!JSON.stringify(read.file).includes('/media/'), 'сама ссылка в граф не идёт')
})

test('негодный файл — отказ словами, а не падение', () => {
  const bad: Array<[string, string, RegExp]> = [
    ['не JSON', 'привет', /could not be read/],
    ['чужой JSON', '{"a":1}', /not a CanAI macro file/],
    ['файл помощника', '{"format":"canai-assistant","name":"x"}', /helper file/],
    ['без нод', fileText([]), /not a single valid node/],
    ['без графа', '{"format":"canai-macro","version":1,"name":"x"}', /no macro graph/],
    ['новее приложения', '{"format":"canai-macro","version":9,"name":"x","graph":{"nodes":[],"edges":[]}}', /newer CanAI version/],
    ['слишком много нод', fileText(Array.from({ length: 201 }, (_, index) => node(`n${index}`, 'note'))), /more than 200 nodes/],
    ['встроенная картинка', fileText([node('n', 'media', { result: { url: 'data:image/png;base64,AAAA' } })]), /embedded images/],
    ['слишком большой', `{"format":"canai-macro","pad":"${'я'.repeat(2_000_001)}"}`, /too large/],
  ]
  for (const [label, text, expected] of bad) refused(() => readMacroFile(text), expected, label)
})

test('из чужого графа берутся только годные ноды и связи', () => {
  // null в списке, нода без data, нода без kind, дубль id — раньше такое роняло
  // ряд макросов вместе с холстом (см. graphDiagnostics.test.ts).
  const { file } = readMacroFile(JSON.stringify({
    format: 'canai-macro', version: 1, name: '  Мусор  ',
    graph: {
      nodes: [
        null, { id: 'a' }, { id: 'b', data: {} }, { id: 'ok', data: { kind: 'note', prompt: 5 } }, { id: 'ok', data: { kind: 'note' } },
        'строка', { id: 'плохой id', data: { kind: 'note' } }, { id: 'k', data: { kind: 'вид с пробелом' } },
      ],
      edges: [null, { id: 'e', source: 'ok', target: 'ok' }, { id: 'e', source: 'ok', target: 'ok' }, { source: 'ok', target: 'ok' }],
    },
  }))
  assert.equal(file.name, 'Мусор')
  assert.deepEqual(file.graph.nodes.map((item) => item.id), ['ok'])
  assert.equal(file.graph.nodes[0]!.data.prompt, '', 'промпт числом превращается в пустую строку')
  assert.equal(file.graph.edges.length, 1)
})

// ⚠️ У обычного объекта по ключу `constructor` лежит функция. Такие имена из
// чужого файла роняли загрузку отказом по-английски («… is not iterable») и
// попадали в замечания как «function Object() { [native code] }».
test('служебные имена объекта в файле не становятся ни моделью, ни параметром', () => {
  const { file } = readMacroFile(fileText(
    [
      node('a', 'image', { model: 'constructor', params: { constructor: 'x', toString: 1, valueOf: true, ok: 'да' } }),
      node('b', 'image', { model: '__proto__' }), node('c', 'image', { model: 'toString' }),
    ],
    [],
    {
      modelNames: { constructor: 'Чужая', toString: 'Чужая', hasOwnProperty: 'Чужая', настоящая: 'Модель' },
      paramInfo: { constructor: { x: { label: 'x' } }, m: { toString: { label: 'x' }, ok: { label: 'Годный', values: { constructor: 'x', a: 'А' } } } },
    },
  ))
  assert.deepEqual(file.graph.nodes.map((item) => item.data.model), [undefined, undefined, undefined])
  assert.deepEqual(file.graph.nodes[0]!.data.params, { ok: 'да' })
  assert.deepEqual(file.modelNames, { настоящая: 'Модель' })
  assert.deepEqual(file.paramInfo, { m: { ok: { label: 'Годный', values: { a: 'А' } } } })

  // Ключ `__proto__` в объектном литерале своим не становится — только в самом тексте файла.
  const polluted = readMacroFile('{"format":"canai-macro","version":1,"name":"x",'
    + '"modelNames":{"__proto__":"Чужая"},"paramInfo":{"__proto__":{"polluted":{"label":"x"}}},'
    + '"graph":{"nodes":[{"id":"n","data":{"kind":"image","params":{"__proto__":{"polluted":true},"ok":1}}}],"edges":[]}}')
  assert.deepEqual(polluted.file.graph.nodes[0]!.data.params, { ok: 1 })
  assert.deepEqual(polluted.file.modelNames, {})
  assert.deepEqual(polluted.file.paramInfo, {})
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'общий прототип объектов не тронут')
})

// ⚠️ Реестр видов нод в редакторе — обычный объект: вид `constructor` сходил за
// знакомый, в замечании назывался «undefined», а редактор на такой ноде падал
// («Интерфейс сломался в блоке редактор макросов»).
test('служебное имя объекта видом ноды не становится', () => {
  const hostile = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__']
  const { file } = readMacroFile(fileText([
    ...hostile.map((kind, index) => node(`h${index}`, kind, { prompt: 'x' })),
    node('ok', 'note', { prompt: 'y' }), node('future', 'wait'),
  ]))
  // Вид из другой версии CanAI остаётся: его покажут неизвестной нодой, которую можно удалить.
  assert.deepEqual(file.graph.nodes.map((item) => item.data.kind), ['note', 'wait'])
  refused(() => readMacroFile(fileText([node('h', 'constructor')])), /not a single valid node/)
  // И при сохранении такая нода в файл не идёт.
  const built = buildMacroFile({ name: 'm', graph: { nodes: [node('h', 'toString'), node('ok', 'note', { prompt: 'y' })], edges: [] } }, 'local', LOCAL_MODELS)
  assert.deepEqual(built.file.graph.nodes.map((item) => item.id), ['ok'])
})

// ⚠️ Номера — ключи таблиц прогона у движка (`ownEntry` в server/src/macroGraph.ts): нода `constructor` сходила за посчитанную и не исполнялась.
test('служебное имя объекта не становится номером ноды, номером связи или портом', () => {
  const hostile = ['constructor', 'toString', 'hasOwnProperty', '__proto__']
  const link = (id: string, source: string, ports = {}) => ({ id, source, target: 'b:2', ...ports })
  const nodes = [...hostile.map((id) => node(id, 'note', { prompt: 'x' })), node('a.1', 'note', { prompt: 'y' }), node('b:2', 'output')]
  const edges = [...hostile.map((id) => link(id, 'a.1')), link('lost', 'toString'), link('kept', 'a.1', { sourceHandle: 'constructor', targetHandle: 'in-text' }), link('kept2', 'a.1', { sourceHandle: 'out', targetHandle: '__proto__' })]
  for (const { file } of [readMacroFile(fileText(nodes, edges)), buildMacroFile({ name: 'm', graph: { nodes, edges } }, 'local', LOCAL_MODELS)]) {
    assert.deepEqual(file.graph.nodes.map((item) => item.id), ['a.1', 'b:2'], 'обычные номера — с точкой и двоеточием — проходят')
    assert.deepEqual(file.graph.edges, [{ id: 'kept', source: 'a.1', target: 'b:2', targetHandle: 'in-text' }, { id: 'kept2', source: 'a.1', target: 'b:2', sourceHandle: 'out' }], 'связь к отброшенной ноде уходит с ней, служебный порт — как любой негодный')
  }
})

test('прежний вид из буфера обмена (type вместо format) тоже читается', () => {
  const { file } = readMacroFile(JSON.stringify({ type: 'canai-macro', name: 'Из буфера', graph: { nodes: graph.nodes.slice(0, 1), edges: [] } }))
  assert.equal(file.name, 'Из буфера')
  assert.equal(file.catalog, undefined, 'чей каталог у графа, такой текст не помнит — и угадывать его нельзя')
  assert.equal(file.paramInfo, undefined, 'сведений о параметрах в таком тексте нет')
  // Пометка каталога — только из двух известных значений.
  for (const catalog of ['local', 'team'] as const) assert.equal(readMacroFile(fileText([node('n', 'note')], [], { catalog })).file.catalog, catalog)
  for (const catalog of ['cloud', '', 5, null]) assert.equal(readMacroFile(fileText([node('n', 'note')], [], { catalog })).file.catalog, undefined)
})

test('имя файла безопасно для диска и говорит, что это', () => {
  assert.equal(libraryFileName('Кожа: лица / v2?', 'macro'), 'Кожа лица v2.canai-macro.json')
  assert.equal(libraryFileName('   ', 'assistant'), 'assistant.canai-assistant.json')
})

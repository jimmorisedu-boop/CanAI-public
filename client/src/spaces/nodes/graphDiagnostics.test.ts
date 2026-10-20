// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { pluralRu, summarizeDiagnostics, validateGraph } from './graphDiagnostics.js'
import { macroRunnable } from './macroPersistence.js'
import type { CanaiEdge, CanaiNode, NodeKind } from './types.js'

function node(id: string, kind: NodeKind, prompt = ''): CanaiNode {
  return {
    id,
    type: 'gen',
    position: { x: 0, y: 0 },
    data: { kind, prompt, status: 'idle' },
  }
}

test('uses English singular and plural diagnostic words for every count', () => {
  assert.equal(pluralRu(1, 'error', 'errors', 'errors'), 'error')
  assert.equal(pluralRu(2, 'error', 'errors', 'errors'), 'errors')
  assert.equal(pluralRu(21, 'error', 'errors', 'errors'), 'errors')
})

test('returns every blocking diagnostic with navigation targets', () => {
  const nodes = [
    node('image', 'image'),
    node('video', 'video'),
    node('output', 'output'),
  ]
  const diagnostics = validateGraph(nodes, [])

  assert.deepEqual(
    diagnostics.filter((item) => item.severity === 'error').map((item) => item.code),
    ['output_disconnected', 'prompt_missing', 'prompt_missing'],
  )
  assert.equal(diagnostics[0].nodeId, 'output')
  assert.equal(diagnostics[1].fieldId, 'prompt')
})

test('reports cycle and unreachable nodes without hiding either', () => {
  const nodes = [
    node('a', 'note', 'A'),
    node('b', 'note', 'B'),
    node('output', 'output'),
  ]
  const edges: CanaiEdge[] = [
    { id: 'ab', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'out' },
    { id: 'ba', source: 'b', sourceHandle: 'out', target: 'a', targetHandle: 'out' },
  ]
  const diagnostics = validateGraph(nodes, edges)

  assert.ok(diagnostics.some((item) => item.code === 'graph_cycle'))
  assert.ok(diagnostics.some((item) => item.code === 'node_unreachable'))
})

test('reports every independent cyclic strongly connected component', () => {
  const nodes = [
    node('a1', 'note', 'A1'),
    node('a2', 'note', 'A2'),
    node('b1', 'note', 'B1'),
    node('b2', 'note', 'B2'),
    node('output', 'output'),
  ]
  const edges: CanaiEdge[] = [
    { id: 'a12', source: 'a1', sourceHandle: 'out', target: 'a2', targetHandle: 'out' },
    { id: 'a21', source: 'a2', sourceHandle: 'out', target: 'a1', targetHandle: 'out' },
    { id: 'b12', source: 'b1', sourceHandle: 'out', target: 'b2', targetHandle: 'out' },
    { id: 'b21', source: 'b2', sourceHandle: 'out', target: 'b1', targetHandle: 'out' },
  ]

  const cycles = validateGraph(nodes, edges).filter((item) => item.code === 'graph_cycle')

  assert.equal(cycles.length, 2)
  assert.equal(new Set(cycles.map((item) => item.nodeId)).size, 2)
})

test('structurally valid graph is named structurally valid, not launch ready', () => {
  const nodes = [node('text', 'note', 'готово'), node('output', 'output')]
  const edges: CanaiEdge[] = [
    {
      id: 'to-output',
      source: 'text',
      sourceHandle: 'out',
      target: 'output',
      targetHandle: 'in-text',
    },
  ]
  const summary = summarizeDiagnostics(validateGraph(nodes, edges))

  assert.deepEqual(summary, {
    errors: 0,
    warnings: 0,
    structurallyValid: true,
    label: 'Valid',
  })
})

test('other node with an empty unconnected prompt blocks the graph', () => {
  const nodes = [node('other', 'other'), node('output', 'output')]
  const edges: CanaiEdge[] = [
    {
      id: 'to-output',
      source: 'other',
      sourceHandle: 'out',
      target: 'output',
      targetHandle: 'in-image',
    },
  ]
  const diagnostics = validateGraph(nodes, edges)
  const summary = summarizeDiagnostics(diagnostics)

  assert.ok(diagnostics.some((item) => item.code === 'prompt_missing'))
  assert.equal(summary.structurallyValid, false)
})

test('пустая note блокирует запуск графической диагностикой', () => {
  const nodes = [node('note', 'note'), node('output', 'output')]
  const edges: CanaiEdge[] = [
    {
      id: 'to-output',
      source: 'note',
      sourceHandle: 'out',
      target: 'output',
      targetHandle: 'in-text',
    },
  ]

  const diagnostics = validateGraph(nodes, edges)

  assert.ok(
    diagnostics.some(
      (item) =>
        item.code === 'note_missing' &&
        item.nodeId === 'note' &&
        item.fieldId === 'prompt',
    ),
  )
})

test('media без файла и ассета блокирует запуск до engine', () => {
  const media = node('media', 'media')
  const nodes = [media, node('output', 'output')]
  const edges: CanaiEdge[] = [
    {
      id: 'to-output',
      source: 'media',
      sourceHandle: 'out',
      target: 'output',
      targetHandle: 'in-image',
    },
  ]

  const diagnostics = validateGraph(nodes, edges)
  assert.ok(
    diagnostics.some(
      (item) => item.code === 'media_missing' && item.nodeId === 'media',
    ),
  )

  media.data.assetSlot = 0
  assert.equal(
    validateGraph(nodes, edges).some((item) => item.code === 'media_missing'),
    false,
  )
})


test('SeedVR Seamless не требует несуществующий prompt', () => {
  const utility = node('other', 'other')
  utility.data.model = 'seedvr-seamless-upscale'
  const nodes = [node('input', 'input'), utility, node('output', 'output')]
  const edges: CanaiEdge[] = [
    {
      id: 'image-to-seedvr',
      source: 'input',
      sourceHandle: 'images',
      target: 'other',
      targetHandle: 'image_url',
    },
    {
      id: 'to-output',
      source: 'other',
      sourceHandle: 'out',
      target: 'output',
      targetHandle: 'in-image',
    },
  ]
  assert.equal(validateGraph(nodes, edges).some((item) => item.code === 'prompt_missing'), false)
  assert.equal(validateGraph(nodes, edges).some((item) => item.code === 'reference_missing'), false)
})

test('SeedVR Seamless требует картинку до запуска', () => {
  const utility = node('other', 'other')
  utility.data.model = 'seedvr-seamless-upscale'
  const diagnostics = validateGraph([utility], [])
  assert.equal(diagnostics.find((item) => item.code === 'reference_missing')?.portId, 'image_url')
})

test('предупреждение про «Ответ» не блокирует запуск макроса', () => {
  const nodes = [node('input', 'input'), node('wait', 'wait'), node('out', 'output')]
  const edges: CanaiEdge[] = [
    { id: 'e1', source: 'input', target: 'wait', sourceHandle: 'text', targetHandle: 'ctx' },
    { id: 'e2', source: 'wait', target: 'out', sourceHandle: 'out', targetHandle: 'in-text' },
  ]
  const summary = summarizeDiagnostics(validateGraph(nodes, edges, 'canvas'))
  assert.equal(summary.errors, 0)
  assert.equal(summary.structurallyValid, true)
})

test('нода без поля prompt в сохранённом графе не роняет проверку', () => {
  // ⚠️ Проверку зовёт и ряд макросов в промпт-баре (macroRunnable): граф, где у
  // ноды нет поля prompt (сохранён мимо редактора, принят из файла), ронял
  // целиком холст — «Интерфейс сломался в блоке „канвас"» (поймано живой
  // проверкой 01.10.2026). Пустой промпт — это диагноз, а не исключение.
  const bare = (id: string, kind: NodeKind): CanaiNode => ({
    id, type: 'gen', position: { x: 0, y: 0 }, data: { kind, status: 'idle' } as CanaiNode['data'],
  })
  const diagnostics = validateGraph([bare('image', 'image'), bare('note', 'note')], [])
  assert.ok(diagnostics.some((item) => item.nodeId === 'image' && item.code === 'prompt_missing'))
})

test('негодный граф из чужого файла — черновик, а не падение холста', () => {
  // ⚠️ macroRunnable зовётся прямо в отрисовке ряда макросов и строк
  // библиотеки. Граф приходит и извне (Ctrl+V, файл обмена), сервер проверяет
  // только, что nodes и edges — массивы. Каждое из этих четырёх ронял холст на
  // всех досках и после перезагрузки: макрос уже лежал в файле.
  const good: CanaiNode = {
    id: 'image', type: 'gen', position: { x: 0, y: 0 },
    data: { kind: 'image', prompt: 'кот', status: 'idle' } as CanaiNode['data'],
  }
  const broken: Array<[string, unknown[], unknown[]]> = [
    ['нода без data', [{ id: 'x', type: 'gen', position: { x: 0, y: 0 } }], []],
    ['null среди нод', [null, good], []],
    ['null среди связей', [good], [null]],
    ['prompt числом', [{ ...good, data: { ...good.data, prompt: 5 } }], []],
  ]
  for (const [label, nodes, edges] of broken) {
    assert.doesNotThrow(() => macroRunnable({ nodes, edges } as never), label)
    assert.equal(macroRunnable({ nodes, edges } as never), false, label)
  }
  assert.doesNotThrow(() => validateGraph([{ ...good, data: { ...good.data, prompt: 5 } } as never], []))
})

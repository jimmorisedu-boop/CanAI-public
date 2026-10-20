import assert from 'node:assert/strict'
import test from 'node:test'
import { runMacroGraph, type MacroRunContext } from './macroEngine.js'
import {
  collectInputs, emptyInputSnapshot, ownEntry,
  type MacroGraph, type MacroInputSnapshot, type MacroNode, type MacroResult,
} from './macroGraph.js'

// Номера нод и связей приходят из графа как есть, а таблицы прогона (входы по
// связям, результаты шагов, заглушки) — обычные объекты из JSON. Редактор выдаёт
// номера-UUID, но макрос из файла, собранного руками, мог лечь в библиотеку с
// номером `constructor`, `toString` или `__proto__` — у обычного объекта по
// такому «ключу» лежит служебная функция или его прототип.

const HOSTILE = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']

/** Таблица, какой она приходит с диска и из запроса: свои ключи, включая `__proto__`. */
const fromJson = <T>(entries: Array<[string, T]>): Record<string, T> => (
  JSON.parse(`{${entries.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}`)
)

function node(id: string, kind: string, extra: Record<string, unknown> = {}): MacroNode {
  return { id, data: { kind, prompt: 'п', ...extra } }
}

function harness(graph: MacroGraph, overrides: Partial<MacroRunContext> = {}) {
  const prompts: Record<string, string> = Object.create(null)
  const placeholders: unknown[] = []
  const outputs: Array<{ nodeId: string; result: MacroResult }> = []
  const context: MacroRunContext = {
    graph,
    seedRefs: [],
    generate: async ({ node: target, prompt, placeholderId }) => {
      prompts[target.id] = prompt
      placeholders.push(placeholderId)
      return target.data.kind === 'text' ? { text: `ответ ${target.id}` } : { url: '/media/result.png', mime: 'image/png' }
    },
    muxAudio: async () => ({}),
    extractAudio: async () => ({}),
    onNode: () => {},
    onOutput: (result, nodeId) => {
      outputs.push({ nodeId, result })
    },
    ...overrides,
  }
  return { context, prompts, placeholders, outputs }
}

/** «Вход → LLM → Картинка → Выход»: номер LLM-ноды и номер связи от «Входа» — подставные. */
function chain(llmId: string, inputEdgeId: string): MacroGraph {
  return {
    nodes: [node('in', 'input'), node(llmId, 'text', { prompt: 'опиши' }), node('img', 'image', { prompt: 'акварель' }), node('out', 'output')],
    edges: [
      { id: inputEdgeId, source: 'in', target: llmId, sourceHandle: 'text', targetHandle: 'ctx' },
      { id: 'e2', source: llmId, target: 'img', sourceHandle: 'out', targetHandle: 'prompt' },
      { id: 'e3', source: 'img', target: 'out', sourceHandle: 'out', targetHandle: 'in-image' },
    ],
  }
}

test('значение из таблицы берётся только по своему ключу', () => {
  for (const key of HOSTILE) {
    assert.equal(ownEntry({}, key), undefined, key)
    assert.equal(ownEntry(undefined, key), undefined, key)
    assert.deepEqual(ownEntry(fromJson([[key, { text: 'своё' }]]), key), { text: 'своё' }, `${key}: свой ключ читается`)
  }
  assert.equal(ownEntry({ a: 1 }, 'a'), 1)
})

// ⚠️ `refsByEdge['__proto__']` у обычного объекта — его прототип: перебор падал с
// «object is not iterable», а по `constructor` перебирались буквы служебной функции.
test('связь от «Входа» со служебным именем в номере не роняет сбор входов', () => {
  for (const edgeId of HOSTILE) {
    const graph = chain('llm', edgeId)
    const collect = (snapshot: MacroInputSnapshot) => collectInputs({
      node: graph.nodes[1]!, graph, results: new Map(), nodesById: new Map(graph.nodes.map((item) => [item.id, item])),
      legacyRootSeed: false, snapshot, seedRefs: [],
    })
    assert.deepEqual(collect(emptyInputSnapshot()), { inheritedText: [], refs: [] }, `${edgeId}: по связи ничего не пришло`)
    const sent = { ...emptyInputSnapshot(), refsByEdge: fromJson([[edgeId, [{ kind: 'text' as const, text: 'кот на крыше' }]]]) }
    assert.deepEqual(collect(sent), { inheritedText: ['кот на крыше'], refs: [] }, `${edgeId}: присланное по связи доходит`)
  }
})

// ⚠️ `initialResults['constructor']` — функция Object: нода сходила за посчитанную
// до перезапуска и не исполнялась, а платная картинка ниже шла без её текста.
test('нода со служебным именем в номере исполняется, а не сходит за посчитанную', async () => {
  for (const llmId of HOSTILE) {
    const h = harness(chain(llmId, 'e1'), {
      snapshot: { ...emptyInputSnapshot(), refsByEdge: { e1: [{ kind: 'text', text: 'кот на крыше' }] } },
      placeholderByNode: {},
      initialResults: {},
    })
    const { delivered } = await runMacroGraph(h.context)
    assert.equal(delivered, 1, llmId)
    assert.equal(h.prompts[llmId], 'кот на крыше\n\nопиши', `${llmId}: LLM-нода запущена со своим входом`)
    assert.equal(h.prompts.img, `ответ ${llmId}\n\nакварель`, `${llmId}: картинка получила текст LLM`)
    assert.deepEqual(h.placeholders, [undefined, undefined], `${llmId}: заглушки, которой не занимали, у ноды нет`)
  }
})

// Правило продолжения прежнее: посчитанный шаг не повторяется — и у такой ноды тоже.
test('посчитанный до перезапуска шаг с таким номером не считается заново', async () => {
  for (const llmId of HOSTILE) {
    const h = harness(chain(llmId, 'e1'), { initialResults: fromJson([[llmId, { text: 'готовый ответ' }]]) })
    await runMacroGraph(h.context)
    assert.equal(llmId in h.prompts, false, `${llmId}: шаг оплачен до перезапуска`)
    assert.equal(h.prompts.img, 'готовый ответ\n\nакварель', llmId)
  }
})

// ⚠️ `placeholderByNode['constructor']` — тоже функция: движок считал, что нода
// заняла карточку и результат поставит сама задача, и на доску не клал ничего.
test('результат ноды без своей заглушки кладётся на доску, каким бы ни был её номер', async () => {
  for (const id of HOSTILE) {
    const graph: MacroGraph = {
      nodes: [node(id, 'image'), node('out', 'output')],
      edges: [{ id: 'e', source: id, target: 'out', sourceHandle: 'out', targetHandle: 'in-image' }],
    }
    const free = harness(graph, { placeholderByNode: {} })
    await runMacroGraph(free.context)
    assert.deepEqual(free.outputs.map((item) => item.nodeId), [id], `${id}: заглушки нет — кладёт вызывающий`)

    const owned = harness(graph, { placeholderByNode: fromJson([[id, 'slot-1']]) })
    await runMacroGraph(owned.context)
    assert.deepEqual(owned.outputs, [], `${id}: своя заглушка — результат поставит задача`)
    assert.deepEqual(owned.placeholders, ['slot-1'], id)
  }
})

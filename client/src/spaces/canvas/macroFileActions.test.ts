import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { LibraryFileError, serializeLibraryFile } from './libraryFile.js'
import { buildMacroFile } from './macroFile.js'
import {
  importMacroFromText, isMacroText, macroCatalogOf, macroClipboardText, type MacroLibraryApi,
} from './macroFileActions.js'
import { LOCAL_MODELS, edge, node, seeded } from './macroFileTestKit.js'

// Макрос внутрь попадает одним путём — и «Из файла», и по Ctrl+V.
//
// ⚠️ Раньше вставка из буфера клала граф как есть, мимо чистки и проверки
// каталога: встроенные результаты и устаревшие параметры доезжали до библиотеки.

const macro = {
  name: 'Портрет',
  graph: {
    nodes: [
      { ...node('in', 'input', { status: 'done' }), selected: true },
      node('img', 'image', {
        prompt: 'кот', model: 'chatgpt-image-2', status: 'done',
        params: { ...seeded(LOCAL_MODELS, 'chatgpt-image-2'), aspect_ratio: '9:16', resolution: '2K' },
        result: { url: '/media/result.png' }, jobId: 'job-1', outputHistory: [{ url: '/media/old.png' }],
      }),
      node('out', 'output'),
    ],
    edges: [edge('in', 'images', 'img', 'ref1'), edge('img', 'out', 'out', 'in-image')],
  },
}

type Call = [name: string, ...args: unknown[]]

function library(): { api: MacroLibraryApi; calls: Call[] } {
  const calls: Call[] = []
  const api: MacroLibraryApi = {
    models: async () => {
      calls.push(['models'])
      return { models: LOCAL_MODELS, defaults: { image: 'chatgpt-image-2', video: 'seedance-2', audio: 'lyria', assistant: 'claude' } }
    },
    saveMacro: async (...args) => {
      calls.push(['saveMacro', ...args])
      return {}
    },
  }
  return { api, calls }
}

const graphOf = (call: Call): { nodes: Array<{ id: string; data: Record<string, unknown> }>; edges: unknown[] } => (
  call[2] as never
)

test('в буфер уходит тот же файл обмена, что «Сохранить в файл»', () => {
  const text = macroClipboardText(macro, 'local', LOCAL_MODELS)
  assert.equal(text, serializeLibraryFile(buildMacroFile(macro, 'local', LOCAL_MODELS).file))
  const parsed = JSON.parse(text) as Record<string, unknown>
  assert.equal(parsed.format, 'canai-macro')
  assert.equal(parsed.catalog, 'local')
  assert.deepEqual(parsed.modelNames, { 'chatgpt-image-2': 'GPT Image 2' })
  assert.ok(parsed.paramInfo, 'сведения о параметрах — в тексте: по ним получателю говорят, что не перенеслось')
  for (const leak of ['/media/', 'job-1', 'outputHistory', 'selected']) assert.ok(!text.includes(leak), leak)
  assert.equal(macroCatalogOf('local'), 'local')
})

test('пустой макрос в буфер не кладётся — отказ словами', () => {
  assert.throws(
    () => macroClipboardText({ name: 'Пустой', graph: { nodes: [], edges: [] } }, 'local', LOCAL_MODELS),
    (error: unknown) => error instanceof LibraryFileError && /not a single valid node/.test(error.message),
  )
})

test('Ctrl+V узнаёт макрос в буфере и не трогает посторонний текст', () => {
  assert.equal(isMacroText(macroClipboardText(macro, 'local', LOCAL_MODELS)), true)
  assert.equal(isMacroText(JSON.stringify({ type: 'canai-macro', name: 'x', graph: macro.graph })), true, 'прежний вид')
  const foreign: unknown[] = [
    '', 'привет', 'https://example.com/canai-macro', '{"a":1}', '[1,2,3]', 'canai-macro', '"canai-macro"',
    '{"format":"canai-assistant","name":"x"}',
    // пометка есть, но это не JSON и не наш файл
    '{"format":"canai-macro"', '{"note":"canai-macro"}', '["canai-macro"]',
    // объект доски, в тексте которого лежит файл макроса
    JSON.stringify({ kind: 'canai-canvas', items: [{ text: '{"format":"canai-macro"}' }] }),
    `{"format":"canai-macro","pad":"${'я'.repeat(2_000_001)}"}`,
    null, undefined, 7, { format: 'canai-macro' },
  ]
  for (const text of foreign) assert.equal(isMacroText(text), false, String(text).slice(0, 60))
})

test('вставка из буфера проходит локальную чистку и сохраняет связи', async () => {
  const { api, calls } = library()
  const text = macroClipboardText(macro, 'local', LOCAL_MODELS)
  const imported = await importMacroFromText(text, 'local', 'canvas', 2, (name) => `${name} (copy)`, api)
  assert.deepEqual(imported, { name: 'Портрет (copy)', notes: [] })
  assert.deepEqual(calls.map(([name]) => name), ['models', 'saveMacro'])
  const [, name, graphValue, id, slot, baseRevision, scope] = calls[1]!
  assert.equal(name, 'Портрет (copy)')
  assert.deepEqual([id, slot, baseRevision, scope], [undefined, 2, undefined, 'canvas'])
  const graph = graphValue as ReturnType<typeof graphOf>
  const image = graph.nodes.find((item) => item.id === 'img')!.data
  assert.equal(image.model, 'chatgpt-image-2')
  assert.deepEqual(image.params, { aspect_ratio: '9:16', resolution: '2K', quality: 'high', num_images: 1 })
  assert.equal(graph.edges.length, 2)
  // Связи доезжают до библиотеки вместе с цветом: редактор их заново не красит.
  assert.deepEqual(graph.edges[0], {
    id: 'xy-edge__inimages-imgref1', source: 'in', target: 'img', sourceHandle: 'images', targetHandle: 'ref1',
    style: { stroke: '#3fb950', strokeWidth: 2 }, animated: true,
  })
})

test('на своей доске макрос ложится в указанный слот своей области, умолчания моделей — из каталога', async () => {
  const { api, calls } = library()
  const text = JSON.stringify({
    format: 'canai-macro', version: 1, name: 'Командный', catalog: 'local', modelNames: { 'image-2030': 'Модель из будущего' },
    graph: { nodes: [
      node('img', 'image', { prompt: 'кот', model: 'image-2030', params: { aspect: '9:16', size: '2k' } }),
      node('llm', 'text', { prompt: 'вопрос', model: 'gpt-6-astra', params: {} }),
    ], edges: [] },
  })
  const imported = await importMacroFromText(text, 'local', 'canvas', 4, undefined, api)
  assert.equal(imported.name, 'Командный')
  assert.deepEqual(imported.notes, [
    'Model "Модель из будущего" replaced with "GPT Image 2"',
    'Model "gpt-6-astra" replaced with "Claude Opus 5.5"',
  ])
  assert.deepEqual(calls.map(([name]) => name), ['models', 'saveMacro'])
  const [, name, graph, id, slot, baseRevision, scope] = calls[1]!
  assert.deepEqual([name, id, slot, baseRevision, scope], ['Командный', undefined, 4, undefined, 'canvas'])
  const image = (graph as ReturnType<typeof graphOf>).nodes[0]!.data
  assert.equal(image.model, 'chatgpt-image-2')
  assert.deepEqual(image.params, { aspect_ratio: '9:16', resolution: '2K', quality: 'high', num_images: 1 })
})

test('прежний текст из буфера (граф как есть) проходит ту же чистку', async () => {
  const { api, calls } = library()
  const legacy = JSON.stringify({ type: 'canai-macro', name: 'Старый', graph: macro.graph })
  const imported = await importMacroFromText(legacy, 'local', 'canvas', 0, undefined, api)
  assert.deepEqual(imported.notes, [])
  const saved = JSON.stringify(graphOf(calls[1]!))
  for (const leak of ['/media/', 'job-1', 'outputHistory', 'selected', '"done"']) assert.ok(!saved.includes(leak), leak)
})

test('негодный текст — отказ словами, и в библиотеку не пишется ничего', async () => {
  const { api, calls } = library()
  await assert.rejects(
    () => importMacroFromText('{"format":"canai-macro","version":1,"name":"x"}', 'local', 'canvas', undefined, undefined, api),
    (error: unknown) => error instanceof LibraryFileError && /no macro graph/.test(error.message),
  )
  await assert.rejects(
    () => importMacroFromText('{"format":"canai-assistant","name":"x"}', 'local', 'canvas', 0, undefined, api),
    (error: unknown) => error instanceof LibraryFileError && /helper file/.test(error.message),
  )
  assert.deepEqual(calls, [])
})

test('имя копии не длиннее предела имени макроса', async () => {
  const { api, calls } = library()
  const text = macroClipboardText(macro, 'local', LOCAL_MODELS)
  const imported = await importMacroFromText(text, 'local', 'canvas', undefined, (name) => `${'я'.repeat(120)} ${name}`, api)
  assert.equal(Array.from(imported.name).length, 100)
  assert.equal(calls[1]![1], imported.name)
})

// Диск — это DOM, его здесь не поднять; проверяем, что «Из файла» не завела свой
// путь мимо чистки и что предел размера у неё — макроса.
test('«Из файла» идёт тем же путём, что вставка из буфера', () => {
  const source = readFileSync(new URL('./macroFileActions.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('export async function importMacroFromFile'))
  assert.match(body, /pickLibraryFile\('macro'\)/)
  assert.match(body, /return importMacroFromText\(text, source, scope, freeSlot\)/)
  assert.ok(!/readMacroFile|adaptMacroFile|saveMacro/.test(body), 'второго пути в библиотеку быть не должно')
})

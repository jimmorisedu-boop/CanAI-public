import type { IncomingRef } from './refs.js'

// Модель графа макроса на сервере.
//
// Раньше макрос исполнялся в браузере: `spaces/nodes/engine.ts` обходил граф и
// сам дёргал генерации. Это работало, пока вкладка жива, — а на планшете экран
// гаснет через пару минут, Safari замораживает фоновую вкладку, и прогон
// обрывался на середине с уже оплаченными шагами. Поэтому обход графа переехал
// сюда, а браузерного движка больше нет: две копии этой логики неминуемо
// разъехались бы, и макрос вёл бы себя по-разному в зависимости от того, откуда
// его запустили.
//
// Здесь — только арифметика графа, без сети и файлов: её можно проверять
// тестами, и весь риск переноса сидит именно в ней.

export type MacroNodeKind =
  | 'text'
  | 'note'
  | 'image'
  | 'video'
  | 'audio'
  | 'muxAudio'
  | 'extractAudio'
  | 'input'
  | 'output'
  | 'media'
  | 'other'
  | 'combine'

export const KNOWN_NODE_KINDS: ReadonlySet<string> = new Set<MacroNodeKind>([
  'text', 'note', 'image', 'video', 'audio', 'muxAudio', 'extractAudio',
  'input', 'output', 'media', 'other', 'combine',
])

/** Шаги, которые пользователь считает шагами цепочки (и за которые платит). */
export const GENERATIVE_KINDS: ReadonlySet<string> = new Set(['text', 'image', 'video', 'audio', 'other'])

/**
 * Именованные картиночные входы моделей (Ideogram: image_url / mask_url /
 * reference_image_urls). Список повторяет `MODEL_INPUT_PORTS` в клиентском
 * `ports.ts`: там он нужен для рисования портов, здесь — чтобы проставить
 * референсу роль. Добавляете модель с именованными входами — впишите её
 * порты в оба места.
 */
export const NAMED_IMAGE_HANDLES: ReadonlySet<string> = new Set([
  'image_url',
  'mask_url',
  'reference_image_urls',
])

export interface MacroNodeData {
  kind: MacroNodeKind | string
  prompt?: string
  model?: string
  params?: Record<string, unknown>
  assetSlot?: number
  result?: MacroResult
}

export interface MacroNode {
  id: string
  data: MacroNodeData
}

export interface MacroEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface MacroGraph {
  nodes: MacroNode[]
  edges: MacroEdge[]
}

/** Результат шага: то же, что отдаёт /api/jobs/:id. */
export interface MacroResult {
  url?: string
  text?: string
  mime?: string
  seed?: number
  width?: number
  height?: number
}

/**
 * Что подаётся в ноды «Вход».
 *
 * Считает это КЛИЕНТ и присылает готовым: разбор опирается на текущее
 * выделение доски и полку ассетов — контекст, которого у сервера нет и не
 * должно быть. Сервер получает уже разложенный по связям снимок.
 */
export interface MacroInputSnapshot {
  refs: IncomingRef[]
  refsByEdge: Record<string, IncomingRef[]>
  assetsBySlot: Record<string, { kind: string; src?: string; text?: string } | undefined>
}

export function emptyInputSnapshot(): MacroInputSnapshot {
  return { refs: [], refsByEdge: {}, assetsBySlot: {} }
}

/**
 * Значение из таблицы прогона по номеру ноды или связи — только СВОЁ.
 *
 * ⚠️ Таблицы (входы по связям, результаты шагов, заглушки) — обычные объекты
 * из JSON, а номера берутся из графа как есть. По номеру `constructor` или
 * `toString` обычный объект отдаёт служебную функцию, по `__proto__` — свой
 * прототип: нода сходила за посчитанную до перезапуска и не исполнялась
 * (платная генерация ниже шла без её текста), а связь от «Входа» роняла прогон
 * отказом по-английски («object is not iterable»). Редактор таких номеров не
 * выдаёт, но макрос из файла, собранного руками, мог уже лечь в библиотеку.
 */
export function ownEntry<T>(table: Record<string, T> | undefined, key: string): T | undefined {
  return table && Object.hasOwn(table, key) ? table[key] : undefined
}

/** Топологический порядок (алгоритм Кана). null — в графе цикл. */
export function topoOrder(graph: MacroGraph): MacroNode[] | null {
  const indegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  for (const node of graph.nodes) {
    indegree.set(node.id, 0)
    adjacency.set(node.id, [])
  }
  for (const edge of graph.edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue
    adjacency.get(edge.source)!.push(edge.target)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }
  const queue = graph.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  if (order.length !== graph.nodes.length) return null
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  return order.map((id) => byId.get(id)!)
}

/** Выход «seed» отдаёт не сам результат, а его зерно отдельным числом. */
export function resultForSourceHandle(
  result: MacroResult,
  sourceHandle?: string | null,
): MacroResult | undefined {
  if (sourceHandle !== 'seed') return result
  if (typeof result.seed !== 'number') return undefined
  return { text: String(result.seed), seed: result.seed }
}

export class IncompatibleLinkError extends Error {}

function assertHandleMatchesMedia(sourceHandle: string, result: MacroResult): void {
  if (!result.url) return
  const isVideo = (result.mime ?? '').startsWith('video/')
  const isAudio = (result.mime ?? '').startsWith('audio/')
  if (sourceHandle === 'image' && isVideo) {
    throw new IncompatibleLinkError('Incompatible connection: video connected to the Image input')
  }
  if (sourceHandle === 'image' && isAudio) {
    throw new IncompatibleLinkError('Incompatible connection: audio connected to the Image input')
  }
  if (sourceHandle === 'video' && !isVideo) {
    throw new IncompatibleLinkError('Incompatible connection: image connected to the Video input')
  }
  if (sourceHandle === 'audio' && !isAudio) {
    throw new IncompatibleLinkError('Incompatible connection: media connected to the Audio input')
  }
}

function acceptsInput(handle: string, role?: string): boolean {
  return handle === 'ctx'
    || handle === 'prompt'
    || handle.startsWith('ref')
    || handle.startsWith('frame')
    || handle.startsWith('video')
    || handle.startsWith('audio')
    || Boolean(role)
}

/**
 * Входы ноды: тексты и референсы, собранные из уже посчитанных предков.
 *
 * `legacyRootSeed` — старые графы без нод «Вход»: выделение доски подаётся
 * корневым нодам напрямую, иначе такие макросы перестали бы работать.
 */
export function collectInputs(input: {
  node: MacroNode
  graph: MacroGraph
  results: Map<string, MacroResult>
  nodesById: Map<string, MacroNode>
  legacyRootSeed: boolean
  snapshot: MacroInputSnapshot
  seedRefs: IncomingRef[]
}): { inheritedText: string[]; refs: IncomingRef[] } {
  const { node, graph, results, nodesById, legacyRootSeed, snapshot, seedRefs } = input
  const inheritedText: string[] = []
  const refs: IncomingRef[] = []

  if (legacyRootSeed) {
    for (const ref of seedRefs) {
      if (ref.kind === 'text') inheritedText.push(ref.text ?? '')
      else refs.push(ref)
    }
  }

  for (const edge of graph.edges) {
    if (edge.target !== node.id) continue
    const handle = edge.targetHandle ?? ''
    const role = NAMED_IMAGE_HANDLES.has(handle) ? handle : undefined
    const source = nodesById.get(edge.source)

    if (source?.data.kind === 'input') {
      // Ноды «Вход» раздают то, что клиент уже разложил по связям.
      for (const item of ownEntry(snapshot.refsByEdge, edge.id) ?? []) {
        if (item.kind === 'text') inheritedText.push(item.text ?? '')
        else refs.push(role ? { ...item, role } : item)
      }
      continue
    }

    const stored = results.get(edge.source)
    const result = stored ? resultForSourceHandle(stored, edge.sourceHandle) : undefined
    if (!result) continue
    assertHandleMatchesMedia(edge.sourceHandle ?? '', result)
    if (!acceptsInput(handle, role)) continue
    if (result.text) inheritedText.push(result.text)
    if (result.url) {
      const isVideo = (result.mime ?? '').startsWith('video/')
      const isAudio = (result.mime ?? '').startsWith('audio/')
      const roleData = role ? { role } : {}
      refs.push({
        kind: isAudio ? 'audio' : isVideo ? 'video' : 'image',
        src: result.url,
        ...roleData,
      })
    }
  }
  return { inheritedText, refs }
}

export function buildPrompt(node: MacroNode, inheritedText: string[]): string {
  const own = node.data.prompt?.trim() ?? ''
  return [...inheritedText.map((text) => text.trim()), own].filter(Boolean).join('\n\n')
}

/**
 * Ноды, чей результат уедет на доску.
 *
 * Считается ДО прогона, потому что от этого зависит, сколько заглушек занять:
 * клиент готовит их заранее и присылает их номера, а сервер привязывает к ним
 * задачи. Так результат встаёт на своё место независимо от того, открыт ли
 * где-то браузер.
 */
export function deliveringNodeIds(graph: MacroGraph): string[] {
  const outputs = new Set(graph.nodes.filter((node) => node.data.kind === 'output').map((node) => node.id))
  if (outputs.size > 0) {
    const delivering: string[] = []
    for (const node of graph.nodes) {
      if (node.data.kind === 'output') continue
      const feedsOutput = graph.edges.some((edge) => edge.source === node.id && outputs.has(edge.target))
      if (feedsOutput && node.data.kind !== 'input' && KNOWN_NODE_KINDS.has(node.data.kind)) delivering.push(node.id)
    }
    return delivering
  }
  // Легаси-граф без «Выхода»: на доску уезжают листья.
  const hasOutgoing = new Set(graph.edges.map((edge) => edge.source))
  return graph.nodes
    .filter((node) => (GENERATIVE_KINDS.has(node.data.kind)
      || node.data.kind === 'muxAudio' || node.data.kind === 'extractAudio') && !hasOutgoing.has(node.id))
    .map((node) => node.id)
}

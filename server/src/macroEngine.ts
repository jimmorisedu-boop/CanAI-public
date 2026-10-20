import {
  GENERATIVE_KINDS,
  KNOWN_NODE_KINDS,
  buildPrompt,
  collectInputs,
  deliveringNodeIds,
  emptyInputSnapshot,
  ownEntry,
  resultForSourceHandle,
  topoOrder,
  type MacroGraph,
  type MacroInputSnapshot,
  type MacroNode,
  type MacroResult,
} from './macroGraph.js'
import type { IncomingRef } from './refs.js'

// Обход графа макроса. Перенесён из браузера один в один по правилам, включая
// те, что уже стоили денег и разбирательств:
//
//  • сбой одной ноды НЕ рвёт прогон — падает только её ветка («ветка
//    оборвалась выше»), независимые доходят до «Выхода»;
//  • прогон считается провальным, только если ошибки были И на доску не
//    доехало ничего;
//  • нода незнакомого вида (осталась от прежней версии) роняет свою ветку, а
//    не весь макрос;
//  • легаси-графы без «Входа»/«Выхода» работают по-прежнему: выделение идёт
//    корневым нодам, результаты листьев — на доску.

export interface MacroNodePatch {
  status?: 'idle' | 'queued' | 'running' | 'done' | 'error'
  progress?: string
  error?: string
  jobId?: string
  result?: MacroResult
}

export interface MacroRunContext {
  graph: MacroGraph
  seedRefs: IncomingRef[]
  snapshot?: MacroInputSnapshot
  /** Заглушки на доске: по одной на ноду, чей результат уезжает на холст. */
  placeholderByNode?: Record<string, string>
  /**
   * Результаты шагов, посчитанных ДО перезапуска приложения.
   *
   * Правило, ради которого всё это заведено: шаг перезапускается, только если
   * у него нет ни сохранённого результата, ни живой задачи. Иначе продолжение
   * прогона означало бы повторную оплату уже сделанной работы.
   */
  initialResults?: Record<string, MacroResult>
  /** Ноды, чей результат уже уехал на доску: второй раз класть нельзя. */
  deliveredNodeIds?: readonly string[]
  /** Сообщить, что результат ноды уехал на доску — чтобы это пережило рестарт. */
  onDelivered?(nodeId: string): void
  /** Запустить генерацию и дождаться её. Отдаёт результат шага. */
  generate(input: {
    node: MacroNode
    prompt: string
    refs: IncomingRef[]
    placeholderId?: string
    onJob(jobId: string): void
    onProgress(text: string): void
  }): Promise<MacroResult>
  /** Локальные операции нашего ffmpeg — денег не стоят, моделью не являются. */
  muxAudio(videoSrc: string, audioSrc: string): Promise<MacroResult>
  extractAudio(videoSrc: string): Promise<MacroResult>
  onNode(nodeId: string, patch: MacroNodePatch): void
  /** Доставка на доску для легаси-графов и нод «Выход». */
  onOutput?(result: MacroResult, nodeId: string): void | Promise<void>
  isCancelled?(): boolean
}

export class MacroCancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}

export async function runMacroGraph(context: MacroRunContext): Promise<{ delivered: number }> {
  const { graph } = context
  const order = topoOrder(graph)
  if (!order) throw new Error('Graph contains a cycle — cannot complete')

  const snapshot = context.snapshot ?? emptyInputSnapshot()
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const hasIncoming = new Set(graph.edges.map((edge) => edge.target))
  const hasOutgoing = new Set(graph.edges.map((edge) => edge.source))
  const hasInputNodes = graph.nodes.some((node) => node.data.kind === 'input')
  const hasOutputNodes = graph.nodes.some((node) => node.data.kind === 'output')
  const delivering = new Set(deliveringNodeIds(graph))

  const results = new Map<string, MacroResult>()
  const failed = new Set<string>()
  const errors: string[] = []
  let delivered = 0

  // Единственное место, где считается «уехало на доску».
  //
  // У генеративной ноды, занявшей заглушку, результат ставит сама задача (у неё
  // есть адрес доски) — второй раз через onOutput класть нельзя, вышел бы
  // дубль. Всё остальное (звуковые операции, готовые файлы) кладёт вызывающий.
  const alreadyDelivered = new Set(context.deliveredNodeIds ?? [])
  const placeOnBoard = async (nodeId: string, result: MacroResult): Promise<void> => {
    const ownsSlot = GENERATIVE_KINDS.has(nodesById.get(nodeId)?.data.kind ?? '')
      && delivering.has(nodeId) && Boolean(ownEntry(context.placeholderByNode, nodeId))
    // До перезапуска этот результат уже уехал на доску — второй экземпляр там
    // не нужен. Но в счёт доставленного он входит: иначе прогон, целиком
    // сделавший работу до рестарта, посчитался бы провальным.
    if (!ownsSlot && !alreadyDelivered.has(nodeId)) {
      await context.onOutput?.(result, nodeId)
      context.onDelivered?.(nodeId)
    }
    alreadyDelivered.add(nodeId)
    delivered += 1
  }

  const stopIfCancelled = () => {
    if (context.isCancelled?.()) throw new MacroCancelledError()
  }

  for (const node of graph.nodes) {
    context.onNode(node.id, { status: 'idle', error: undefined, progress: undefined })
  }

  const initialResults = context.initialResults ?? {}
  for (const [nodeId, result] of Object.entries(initialResults)) results.set(nodeId, result)

  for (const node of order) {
    stopIfCancelled()

    // Шаг посчитан до перезапуска (свой ключ таблицы, см. ownEntry): повторять его — значит платить дважды.
    const restored = ownEntry(initialResults, node.id)
    if (restored && node.data.kind !== 'output') {
      context.onNode(node.id, { status: 'done', result: restored, progress: undefined, error: undefined })
      if (!hasOutputNodes && !hasOutgoing.has(node.id)) await placeOnBoard(node.id, restored)
      continue
    }

    if (node.data.kind === 'output') {
      // «Выход» собирает независимые ветки: падение одного входа не должно
      // прятать результаты остальных.
      let placed = 0
      let preview: MacroResult | undefined
      for (const edge of graph.edges) {
        if (edge.target !== node.id) continue
        const stored = results.get(edge.source)
        const result = stored ? resultForSourceHandle(stored, edge.sourceHandle) : undefined
        if (!result || (!result.url && !result.text)) continue
        await placeOnBoard(edge.source, result)
        preview ??= result
        placed += 1
      }
      context.onNode(node.id, {
        status: placed ? 'done' : 'error',
        error: placed ? undefined : 'No result reached the output — connect its inputs',
        result: preview,
        progress: undefined,
      })
      continue
    }

    if (node.data.kind === 'combine') {
      const { inheritedText } = collectInputs({
        node,
        graph,
        results,
        nodesById,
        legacyRootSeed: !hasInputNodes && !hasIncoming.has(node.id),
        snapshot,
        seedRefs: context.seedRefs,
      })
      const separator = node.data.prompt !== undefined && node.data.prompt !== ''
        ? node.data.prompt.replace(/\\n/g, '\n')
        : '\n\n'
      const result: MacroResult = { text: inheritedText.join(separator) }
      results.set(node.id, result)
      context.onNode(node.id, { status: 'done', result, progress: undefined })
      continue
    }

    if (graph.edges.some((edge) => edge.target === node.id && failed.has(edge.source))) {
      failed.add(node.id)
      context.onNode(node.id, { status: 'error', error: 'branch was interrupted above', progress: undefined })
      continue
    }

    if (!KNOWN_NODE_KINDS.has(node.data.kind)) {
      const message = 'Node from a previous app version — delete it'
      failed.add(node.id)
      errors.push(message)
      context.onNode(node.id, { status: 'error', error: message, progress: undefined })
      continue
    }

    if (node.data.kind === 'note') {
      const text = node.data.prompt?.trim() ?? ''
      if (text) results.set(node.id, { text })
      else {
        failed.add(node.id)
        errors.push('Text node is empty')
      }
      context.onNode(node.id, {
        status: text ? 'done' : 'error',
        error: text ? undefined : 'enter text',
        result: { text },
        progress: undefined,
      })
      continue
    }

    if (node.data.kind === 'media') {
      let value = node.data.result
      if (node.data.assetSlot != null) {
        const asset = ownEntry(snapshot.assetsBySlot, String(node.data.assetSlot))
        if (asset && (asset.kind === 'image' || asset.kind === 'video') && asset.src) {
          value = { url: asset.src, mime: asset.kind === 'video' ? 'video/mp4' : 'image/png' }
        }
      }
      const has = Boolean(value?.url)
      if (has && value) results.set(node.id, value)
      else {
        failed.add(node.id)
        errors.push('The File node has no selected file or asset')
      }
      context.onNode(node.id, {
        status: has ? 'done' : 'error',
        error: has ? undefined : 'Select a file or asset',
        result: value,
        progress: undefined,
      })
      continue
    }

    if (node.data.kind === 'muxAudio' || node.data.kind === 'extractAudio') {
      const { refs } = collectInputs({
        node,
        graph,
        results,
        nodesById,
        legacyRootSeed: !hasInputNodes && !hasIncoming.has(node.id),
        snapshot,
        seedRefs: context.seedRefs,
      })
      const video = refs.find((ref) => ref.kind === 'video')
      const audio = refs.find((ref) => ref.kind === 'audio')
      const missing = node.data.kind === 'muxAudio'
        ? (!video ? 'connect video' : !audio ? 'connect track' : null)
        : (!video ? 'connect video' : null)
      if (missing) {
        failed.add(node.id)
        errors.push(missing)
        context.onNode(node.id, { status: 'error', error: missing, progress: undefined })
        continue
      }
      context.onNode(node.id, { status: 'running', progress: 'calculating…', error: undefined })
      try {
        const result = node.data.kind === 'muxAudio'
          ? await context.muxAudio(video!.src!, audio!.src!)
          : await context.extractAudio(video!.src!)
        results.set(node.id, result)
        context.onNode(node.id, { status: 'done', result, progress: undefined })
        if (!hasOutputNodes && !hasOutgoing.has(node.id)) await placeOnBoard(node.id, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'error'
        failed.add(node.id)
        errors.push(message)
        context.onNode(node.id, { status: 'error', error: message, progress: undefined })
      }
      continue
    }

    if (node.data.kind === 'input') {
      const got = snapshot.refs.length
      context.onNode(node.id, {
        status: 'done',
        progress: undefined,
        error: undefined,
        result: { text: got ? `Selected objects: ${got}` : 'No objects selected' },
      })
      continue
    }

    const { inheritedText, refs } = collectInputs({
      node,
      graph,
      results,
      nodesById,
      legacyRootSeed: !hasInputNodes && !hasIncoming.has(node.id),
      snapshot,
      seedRefs: context.seedRefs,
    })
    const prompt = buildPrompt(node, inheritedText)
    // У SeedVR промпта во входной схеме нет вовсе: непустая строка нужна
    // только общему API CanAI и в fal не уходит.
    const requestPrompt = prompt || (
      node.data.kind === 'other' && node.data.model === 'seedvr-seamless-upscale' ? 'upscale' : ''
    )
    if (!requestPrompt) {
      failed.add(node.id)
      errors.push(`node «${node.data.kind}»: no prompt`)
      context.onNode(node.id, {
        status: 'error',
        error: 'No prompt (enter text or connect an input)',
        progress: undefined,
      })
      continue
    }

    context.onNode(node.id, { status: 'running', progress: 'sending…', error: undefined })
    try {
      const result = await context.generate({
        node,
        prompt: requestPrompt,
        refs,
        placeholderId: ownEntry(context.placeholderByNode, node.id),
        onJob: (jobId) => context.onNode(node.id, { jobId }),
        onProgress: (text) => context.onNode(node.id, { progress: text }),
      })
      results.set(node.id, result)
      context.onNode(node.id, { status: 'done', result, progress: undefined })
      // С нодами «Выход» доставку считает их ветка; в легаси-графе доставляют
      // листья.
      if (!hasOutputNodes && !hasOutgoing.has(node.id)) await placeOnBoard(node.id, result)
    } catch (error) {
      if (error instanceof MacroCancelledError) throw error
      const message = error instanceof Error ? error.message : 'error'
      context.onNode(node.id, { status: 'error', error: message, progress: undefined })
      if (message === 'Cancelled' || message === 'отменено') throw new MacroCancelledError()
      failed.add(node.id)
      errors.push(message)
    }
  }

  // Ошибки были, и до выхода не дошло ничего — прогон честно провален.
  if (errors.length > 0 && delivered === 0) throw new Error(errors[0])
  return { delivered }
}

export { GENERATIVE_KINDS }

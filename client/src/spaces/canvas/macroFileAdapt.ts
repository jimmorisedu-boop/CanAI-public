import type { CatalogModel } from '../../types'
import { inspectNodeMediaRefs, resolveNodeModel } from '../nodes/nodeModel'
import type { NodeKind } from '../nodes/types'
import { own, type LibraryCatalog } from './libraryFile'
import type { FileNode, MacroFile } from './macroFile'
import {
  brokenNodesNote, kindTitle, knownNodeKind, missingFilesNote, nodeLabel, replacedModelNote, systemPromptNote,
  tallied, unsetModelNote, unsureParamsNote,
} from './macroFileNotes'
import { translateParams } from './macroFileParams'

// Граф из файла — под каталог моделей получателя.
//
// ⚠️ У своей доски и у сервера команды каталоги РАЗНЫЕ: та же модель зовётся
// `chatgpt-image-2` и `gpt-image-2`, та же настройка — `aspect_ratio` и
// `aspect`, тот же размер — `1K` и `hd`. Принятый «как есть» макрос выглядел
// бы рабочим и падал на запуске. Что переводится — переводим, прочее берёт
// умолчания получателя, и обо всём, что при этом РЕАЛЬНО потерялось, человеку
// сказано по нодам (перевод параметров — в macroFileParams.ts, слова — в
// macroFileNotes.ts).

/** Виды нод, которым нужна модель: за них платят и на своей доске, и на сетевой. */
const GENERATIVE_KINDS: ReadonlySet<string> = new Set(['text', 'image', 'video', 'audio', 'other'])

/**
 * Виды нод, которые исполняет сервер команды.
 *
 * ⚠️ Список — двойник правила сервера команды: `macroQuotePlan` в его
 * src/macros/runs.ts и `processRun` в src/macros/worker.ts знают служебные
 * «Вход», «Текст», «Объединение», «Выход», «Файл» и ноды с моделью (`generative`).
 * На любой другой вид (у нас это «Видео + звук» и «Достать звук» — их считает
 * ffmpeg своего сервера) он отвечает «В макросе есть неподдерживаемая нода» и
 * отказывает ВСЕМУ макросу ещё на котировке. Граф с такой нодой он при этом
 * сохраняет (`normalizeMacroGraph` в graph.ts вид не проверяет) — кнопка
 * выглядела рабочей и падала на запуске. Меняется набор там — менять и здесь.
 */
export const TEAM_RUNNABLE_NODE_KINDS: ReadonlySet<string> = new Set([
  'input', 'note', 'combine', 'output', 'media', ...GENERATIVE_KINDS,
])

/**
 * Исполнит ли получатель ноду такого вида. Своя доска знает все виды, которые
 * знает редактор (`KNOWN_NODE_KINDS` в server/src/macroGraph.ts — тот же набор,
 * что `NODE_PORTS`); незнакомый вид — из другой версии CanAI — роняет свою
 * ветку макроса.
 */
function runsAt(catalog: LibraryCatalog, kind: string): boolean {
  return catalog === 'team' ? TEAM_RUNNABLE_NODE_KINDS.has(kind) : knownNodeKind(kind)
}

export interface MacroImport {
  name: string
  graph: MacroFile['graph']
  /** Что изменилось по дороге — словами, для человека. Пусто — принят как есть. */
  notes: string[]
}

export interface MacroImportTarget {
  catalog: LibraryCatalog
  models: readonly CatalogModel[]
  /** Модель по умолчанию для вида ноды; `null`, если в каталоге для такого вида моделей нет. */
  defaultModelId(kind: string): string | null
}

/**
 * Модель получателя для ноды: та же, одноимённая или модель по умолчанию.
 * `sourceId` нет — в ноде модель не была выбрана: остаётся модель по умолчанию.
 */
function resolveModel(
  kind: string,
  sourceId: string | undefined,
  sourceName: string | undefined,
  target: MacroImportTarget,
): { model: CatalogModel | undefined; replaced: boolean } {
  const ofKind = target.models.filter((model) => model.kind === kind)
  const same = sourceId ? ofKind.find((model) => model.id === sourceId) : undefined
  if (same) return { model: same, replaced: false }
  // Та же модель под другим id (каталоги зовут её по-разному) — не замена.
  // Из одноимённых берём базовую: вариант «по референсам» включается сам.
  const named = sourceName ? ofKind.filter((model) => model.name === sourceName) : []
  const twin = named.find((model) => !model.refs) ?? named[0]
  if (twin) return { model: twin, replaced: false }
  const fallbackId = target.defaultModelId(kind)
  return { model: ofKind.find((model) => model.id === fallbackId), replaced: true }
}

type EditorEdges = Parameters<typeof inspectNodeMediaRefs>[1]
type EditorNodes = Parameters<typeof inspectNodeMediaRefs>[2]

/**
 * Модель, которая сработает у получателя при подключённых к ноде входах: вместо
 * базовой включается её вариант «по референсам». Правило то же, что в редакторе
 * нод (`resolveNodeModel`) и на своём сервере перед запуском: связи читаем из
 * графа файла теми же функциями, а не вторым, своим разбором. К ноде ничего
 * медийного не подключено — сработает та модель, что в ней записана.
 */
function workingModel(
  node: FileNode,
  model: CatalogModel,
  graph: MacroFile['graph'],
  models: CatalogModel[],
): CatalogModel {
  const refs = inspectNodeMediaRefs(node.id, graph.edges as EditorEdges, graph.nodes as unknown as EditorNodes)
  if (!refs.hasImage && !refs.hasVideo && !refs.hasAudio) return model
  return resolveNodeModel(models, node.data.kind as NodeKind, model.id, refs.hasImage, refs.hasVideo, refs.hasAudio) ?? model
}

/**
 * Граф из файла — под каталог моделей получателя.
 *
 * `defaultModelId(kind)` — модель по умолчанию для вида ноды; `null`, если
 * в каталоге для такого вида моделей нет.
 */
export function adaptMacroFile(
  input: { file: MacroFile; droppedFiles: number },
  target: MacroImportTarget,
): MacroImport {
  const { file } = input
  // Каталог автора неизвестен (текст из буфера прежнего приложения) — сверяем
  // как чужой: в таком графе бывают имена параметров и своей доски, и сетевой.
  const crossCatalog = file.catalog !== target.catalog
  const models = [...target.models]
  const replaced = new Map<string, string>()
  const broken = new Set<string>()
  const unset: string[] = []
  const moved: string[] = []
  const lost: string[] = []

  const nodes = file.graph.nodes.map((node): FileNode => {
    const { kind } = node.data
    if (!runsAt(target.catalog, kind)) {
      broken.add(kindTitle(kind))
      return node
    }
    if (!GENERATIVE_KINDS.has(kind)) return node
    const sourceId = node.data.model
    if (!sourceId && !crossCatalog) {
      // В своём каталоге ноду без модели не трогаем: модель ей подставит
      // редактор — если подставлять есть что.
      if (target.defaultModelId(kind) === null) broken.add(kindTitle(kind))
      return node
    }
    // ⚠️ В ЧУЖОЙ каталог нода без модели «как есть» не идёт. Раньше шла:
    // системный промпт LLM и параметры оставались под именами каталога автора
    // («Неизвестный параметр: system_prompt», «…: aspect_ratio»), а картинку и
    // видео без модели сервер команды не запускает вовсе — кнопка выглядела
    // готовой и падала на запуске. Ставим модель по умолчанию, параметры
    // переводим под неё и говорим об этом.
    const sourceName = sourceId ? own(file.modelNames, sourceId) : undefined
    const found = resolveModel(kind, sourceId, sourceName, target)
    const model = found.model
    if (!model) {
      // Для этого вида ноды у получателя нет ни одной модели: выбирать в ноде
      // нечего, и работать она не будет.
      broken.add(kindTitle(kind))
      const { model: _model, params: _params, ...rest } = node.data
      return { ...node, data: rest }
    }
    const label = nodeLabel(kind, model.name)
    if (!sourceId) unset.push(unsetModelNote(label))
    else if (found.replaced) replaced.set(sourceName ?? sourceId, model.name)
    if (model.id === sourceId && !crossCatalog) return node
    const working = workingModel(node, model, file.graph, models)
    const translated = translateParams(node, model, working, sourceId ? own(file.paramInfo, sourceId) : undefined)
    for (const loss of translated.losses) lost.push(`${label}: ${loss}`)
    if (translated.unsure) lost.push(unsureParamsNote(label))
    if (!translated.systemPrompt) return { ...node, data: { ...node.data, model: model.id, params: translated.params } }
    moved.push(systemPromptNote(label))
    const prompt = node.data.prompt.trim() ? `${translated.systemPrompt}\n\n${node.data.prompt}` : translated.systemPrompt
    return { ...node, data: { ...node.data, prompt, model: model.id, params: translated.params } }
  })

  const notes: string[] = []
  if (broken.size > 0) notes.push(brokenNodesNote(target.catalog, [...broken]))
  if (input.droppedFiles > 0) notes.push(missingFilesNote(input.droppedFiles))
  for (const [from, to] of replaced) notes.push(replacedModelNote(from, to))
  notes.push(...tallied(unset), ...tallied(moved), ...tallied(lost, true))
  return { name: file.name, graph: { nodes, edges: file.graph.edges }, notes }
}

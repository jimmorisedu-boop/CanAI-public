import type { CatalogModel } from '../../types'
import {
  ASSISTANT_FILE_FORMAT, LIBRARY_FILE_VERSION, LibraryFileError, MACRO_FILE_FORMAT,
  cleanName, hasInlineMedia, isPlain, parseJson, type LibraryCatalog, type Plain,
} from './libraryFile'
import {
  MAX_NODE_PARAMS, PARAM_NAME, describeModels, isModelId, isParamValue, readModelNames, readParamInfo, safeKey,
  type FileModelNames, type FileParamInfoMap, type ParamValue,
} from './macroFileModels'

// Файл макроса: что в нём лежит, как его собрать и прочитать. Что файл помнит
// о моделях автора — в macroFileModels.ts, подгонка под каталог получателя — в
// macroFileAdapt.ts, общие правила обмена — в libraryFile.ts.

export type { FileParamInfo, ParamValue } from './macroFileModels'

/**
 * Всё, что файл несёт о ноде, — БЕЛЫЙ список.
 *
 * ⚠️ Раньше из файла шли любые поля ноды, кроме восьми «следов прогона»: файл
 * в 18 КБ с глубоко вложенным мусором раздувал macros.json на 17 МБ, а ссылки
 * в незнакомых полях доезжали до библиотеки и до сервера команды.
 *
 * Список сверен с тем, что о ноде читают редактор (client/src/spaces/nodes) и
 * оба движка — server/src/macroEngine.ts и macros/worker.ts сервера команды:
 * вид, промпт, модель, параметры и слот ассета. `collapsed` читает только
 * редактор. `result` тоже читают (файл ноды «Файл»), но в файл обмена он не
 * идёт намеренно: это файл компьютера или доски автора.
 */
export interface FileNodeData {
  kind: string
  prompt: string
  status: 'idle'
  model?: string
  params?: Record<string, ParamValue>
  collapsed?: true
  assetSlot?: number
}

export interface FileNode {
  id: string
  type: 'gen'
  position: { x: number; y: number }
  data: FileNodeData
}

export interface FileEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  /** Цвет и толщина провода: редактор красит связь один раз, при соединении. */
  style?: { stroke?: string; strokeWidth?: number }
  animated?: boolean
}

export interface MacroFile {
  format: typeof MACRO_FILE_FORMAT
  version: number
  name: string
  /**
   * Чей каталог моделей у графа. Нет поля — неизвестно: так выглядит текст из
   * буфера прежнего приложения, и тогда граф сверяется с каталогом получателя
   * всегда, как чужой.
   */
  catalog?: LibraryCatalog
  /** Имена моделей на момент сохранения — по ним модель ищут у получателя. */
  modelNames: FileModelNames
  /** Параметры этих моделей у автора. Нет поля — файл прежнего вида. */
  paramInfo?: FileParamInfoMap
  /** Ноды «Файл», чей файл остался у автора. Нет поля — файл прежнего вида. */
  missingFiles?: string[]
  graph: { nodes: FileNode[]; edges: FileEdge[] }
}

const MAX_NODES = 200
const MAX_EDGES = 800
/** Полка ассетов — восемь слотов; запас на рост. */
const MAX_ASSET_SLOT = 99
const POSITION_LIMIT = 1_000_000
const SAFE_GRAPH_ID = /^[A-Za-z0-9_:.-]{1,120}$/u
const NODE_KIND = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u

/**
 * Вид ноды — обычное слово.
 *
 * ⚠️ Имя, которое есть у любого объекта (`constructor`, `toString`), видом
 * быть не может: реестр видов в редакторе — обычный объект и по такому имени
 * отдаёт служебную функцию. Нода с таким видом сходила за знакомую, в
 * замечании называлась «undefined», а редактор на ней падал.
 */
const isNodeKind = (value: unknown): value is string => (
  typeof value === 'string' && NODE_KIND.test(value) && safeKey(value, 40)
)

/**
 * Номер ноды, номер связи и имя порта — тоже без служебных имён объекта.
 *
 * ⚠️ Номера — ключи таблиц прогона у движка (результаты шагов, входы по связям,
 * заглушки). Нода с номером `constructor` или `__proto__` проходила разбор, а
 * движок считал её уже посчитанной и не исполнял: платная генерация ниже шла
 * без её текста. Такая нода в граф не идёт — вместе со связями к ней.
 */
const isGraphId = (value: unknown): value is string => (
  typeof value === 'string' && SAFE_GRAPH_ID.test(value) && safeKey(value, 120)
)
// Цвет провода: только `#hex` и переменная темы. Произвольная строка стиля из
// чужого файла в разметку не попадает.
const STROKE = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|var\(--[a-z0-9_-]{1,64}\))$/i
const MIN_STROKE_WIDTH = 0.5
const MAX_STROKE_WIDTH = 8

/** Параметры ноды: только простые значения под обычными именами. */
function cleanParams(raw: Plain): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {}
  let taken = 0
  for (const [name, value] of Object.entries(raw)) {
    if (taken >= MAX_NODE_PARAMS) break
    if (!PARAM_NAME.test(name) || !safeKey(name, 64) || !isParamValue(value)) continue
    params[name] = value
    taken++
  }
  return params
}

const coordinate = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-POSITION_LIMIT, Math.min(POSITION_LIMIT, value))
    : 0
)

/** Есть ли в ноде «Файл» сам файл: ссылка у своей доски, номер файла — у сетевой. */
function hasOwnFile(data: Plain): boolean {
  if (!isPlain(data.result)) return false
  const filled = (value: unknown) => typeof value === 'string' && value.trim() !== ''
  return filled(data.result.url) || filled(data.result.assetId)
}

function cleanNodes(raw: unknown): { nodes: FileNode[]; fileless: string[] } {
  if (!Array.isArray(raw)) throw new LibraryFileError("There are no macro nodes in the file")
  if (raw.length > MAX_NODES) throw new LibraryFileError(`The macro contains more than ${MAX_NODES} nodes - we do not accept such a file`)
  const fileless: string[] = []
  const seen = new Set<string>()
  const nodes: FileNode[] = []
  for (const item of raw) {
    if (!isPlain(item) || !isPlain(item.data)) continue
    const id = isGraphId(item.id) ? item.id : ''
    const kind = isNodeKind(item.data.kind) ? item.data.kind : ''
    if (!id || !kind || seen.has(id)) continue
    seen.add(id)
    const position = isPlain(item.position) ? item.position : {}
    const { model, params, collapsed, assetSlot } = item.data
    const slot = typeof assetSlot === 'number' && Number.isInteger(assetSlot) && assetSlot >= 0 && assetSlot <= MAX_ASSET_SLOT
      ? assetSlot
      : undefined
    // Нода, привязанная к ассету, файл не теряет: у получателя она возьмёт
    // его ассет из того же слота. Теряет только нода со своим файлом.
    if (kind === 'media' && slot === undefined && hasOwnFile(item.data)) fileless.push(id)
    nodes.push({
      id,
      type: 'gen',
      position: { x: coordinate(position.x), y: coordinate(position.y) },
      data: {
        kind,
        prompt: typeof item.data.prompt === 'string' ? item.data.prompt : '',
        status: 'idle',
        ...(isModelId(model) ? { model } : {}),
        ...(isPlain(params) ? { params: cleanParams(params) } : {}),
        ...(collapsed === true ? { collapsed } : {}),
        ...(slot !== undefined ? { assetSlot: slot } : {}),
      },
    })
  }
  return { nodes, fileless }
}

/**
 * Оформление связи. ⚠️ Без него связи после загрузки вставали серыми и
 * тонкими: цвет по типу данных редактор ставит ОДИН раз, при соединении
 * (onConnect в NodesSpace.tsx), и хранит в `style` связи, а при открытии
 * макроса связи идут в редактор как есть.
 */
function cleanEdgeLook(item: Plain): Pick<FileEdge, 'style' | 'animated'> {
  const style: NonNullable<FileEdge['style']> = {}
  if (isPlain(item.style)) {
    const { stroke, strokeWidth } = item.style
    if (typeof stroke === 'string' && STROKE.test(stroke)) style.stroke = stroke
    if (typeof strokeWidth === 'number' && strokeWidth >= MIN_STROKE_WIDTH && strokeWidth <= MAX_STROKE_WIDTH) {
      style.strokeWidth = strokeWidth
    }
  }
  return {
    ...(Object.keys(style).length > 0 ? { style } : {}),
    ...(typeof item.animated === 'boolean' ? { animated: item.animated } : {}),
  }
}

function cleanEdges(raw: unknown, nodeIds: Set<string>): FileEdge[] {
  if (!Array.isArray(raw)) return []
  const edges: FileEdge[] = []
  const seen = new Set<string>()
  for (const item of raw.slice(0, MAX_EDGES)) {
    if (!isPlain(item)) continue
    const { id, source, target } = item
    if (!isGraphId(id) || seen.has(id)) continue
    if (typeof source !== 'string' || typeof target !== 'string') continue
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue
    seen.add(id)
    edges.push({
      id, source, target,
      ...(isGraphId(item.sourceHandle) ? { sourceHandle: item.sourceHandle } : {}),
      ...(isGraphId(item.targetHandle) ? { targetHandle: item.targetHandle } : {}),
      ...cleanEdgeLook(item),
    })
  }
  return edges
}

function cleanGraph(raw: unknown, purpose: 'save' | 'load'): { graph: MacroFile['graph']; fileless: string[] } {
  if (!isPlain(raw)) throw new LibraryFileError("There is no macro graph in the file")
  if (hasInlineMedia(raw)) {
    throw new LibraryFileError(purpose === 'save'
      ? "The macro has built-in pictures - we do not save such a macro to a file"
      : "The file contains embedded images - we do not accept such a macro")
  }
  const { nodes, fileless } = cleanNodes(raw.nodes)
  if (nodes.length === 0) throw new LibraryFileError("There is not a single valid node in the macro")
  return { graph: { nodes, edges: cleanEdges(raw.edges, new Set(nodes.map((node) => node.id))) }, fileless }
}

const usedModels = (nodes: FileNode[]): string[] => nodes.flatMap((node) => (node.data.model ? [node.data.model] : []))

/** Файл макроса из того, что лежит в библиотеке. */
export function buildMacroFile(
  macro: { name: string; graph: unknown },
  catalog: LibraryCatalog,
  models: readonly CatalogModel[],
): { file: MacroFile; droppedFiles: number } {
  const { graph, fileless } = cleanGraph(macro.graph, 'save')
  return {
    file: {
      format: MACRO_FILE_FORMAT,
      version: LIBRARY_FILE_VERSION,
      name: cleanName(macro.name, 100) || "Macro",
      catalog,
      ...describeModels(usedModels(graph.nodes), models),
      missingFiles: fileless,
      graph,
    },
    droppedFiles: fileless.length,
  }
}

/** Разбор файла макроса. Понимает и прежний вид из буфера обмена: {type, name, graph}. */
export function readMacroFile(text: string): { file: MacroFile; droppedFiles: number } {
  const parsed = parseJson(text, 'macro')
  const fromClipboard = parsed.type === MACRO_FILE_FORMAT
  if (parsed.format === ASSISTANT_FILE_FORMAT) {
    throw new LibraryFileError("This is a helper file - load it in the helpers window")
  }
  if (parsed.format !== MACRO_FILE_FORMAT && !fromClipboard) throw new LibraryFileError("This is not a CanAI macro file")
  if (!fromClipboard && Number(parsed.version) > LIBRARY_FILE_VERSION) {
    throw new LibraryFileError("File was saved by a newer CanAI version — update the app")
  }
  const { graph, fileless } = cleanGraph(parsed.graph, 'load')
  // ⚠️ О пропавшем файле говорим, только когда он и правда был. Сам файл в
  // файл обмена не попадает никогда, поэтому о нём говорит пометка автора
  // (`missingFiles`). В файле прежнего вида пометки нет: там считаем, что файл
  // был, — так говорило и прежнее приложение. В прежнем буфере обмена граф
  // лежит как есть, и ссылка видна сама. Нода, привязанная к ассету, файла не
  // теряет вовсе.
  const needsFile = (node: FileNode) => node.data.kind === 'media' && node.data.assetSlot === undefined
  const marked = Array.isArray(parsed.missingFiles) ? new Set<unknown>(parsed.missingFiles) : null
  const seenLink = new Set(fileless)
  const missingFiles = graph.nodes
    .filter((node) => needsFile(node) && (seenLink.has(node.id) || (marked ? marked.has(node.id) : !fromClipboard)))
    .map((node) => node.id)
  const paramInfo = readParamInfo(parsed.paramInfo)
  // ⚠️ Чей каталог у графа, говорит только сама пометка. Раньше её отсутствие
  // читалось как «своя доска»: текст из буфера прежнего приложения, скопированный
  // на сетевой доске, вставал на свою как есть — с именами параметров сервера
  // команды (`aspect`, `size`), — и свой сервер отказывал такой ноде на запуске.
  const catalog = parsed.catalog === 'team' || parsed.catalog === 'local' ? parsed.catalog : undefined
  return {
    file: {
      format: MACRO_FILE_FORMAT,
      version: LIBRARY_FILE_VERSION,
      name: cleanName(parsed.name, 100) || "Macro",
      ...(catalog ? { catalog } : {}),
      modelNames: readModelNames(parsed.modelNames),
      ...(paramInfo ? { paramInfo } : {}),
      missingFiles,
      graph,
    },
    droppedFiles: missingFiles.length,
  }
}

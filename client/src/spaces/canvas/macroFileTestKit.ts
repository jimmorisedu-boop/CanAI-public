import assert from 'node:assert/strict'
import { CATALOG } from '../../../../packages/model-catalog/catalog'
import { paramValueAllowed } from '../../../../packages/model-catalog/macroModels'
import { parameterActive } from '../../../../packages/model-catalog/parameterRules'
import type { CatalogModel, ParamSpec } from '../../types'
import { defaultNodeModelId } from '../nodes/nodeModel'
import type { NodeKind } from '../nodes/types'
import { LibraryFileError } from './libraryFile'
import { buildMacroFile, readMacroFile, type FileNodeData } from './macroFile'
import { adaptMacroFile, type MacroImport, type MacroImportTarget } from './macroFileAdapt'

// Общее для тестов обмена макросами: оба каталога, заготовки графа и перенос
// «сохранили на одной доске — загрузили на другой».
//
// Каталог своей доски — настоящий (packages/model-catalog). Каталог сервера
// команды живёт в другом репозитории и сюда не импортируется, поэтому здесь его
// СНИМОК: что `publicCatalog()` отдаёт приложению (canai-cloud, коммит 627b4c9,
// 02.10.2026) — те же id, имена, параметры, подписи и умолчания. Тесты на
// выдуманных каталогах уже однажды не увидели, что системный промпт LLM и
// длительность Seedance теряются при переносе.

export const LOCAL_MODELS = CATALOG as unknown as CatalogModel[]

const select = (
  name: string, label: string, fallback: string, options: Array<[string, string]>,
): ParamSpec => ({
  name, label, widget: 'select', default: fallback, options: options.map(([value, text]) => ({ value, label: text })),
})

const ASPECTS: Array<[string, string]> = [
  ['auto', "Auto"], ['1:1', "Square 1:1"], ['3:4', "Portrait 3:4"], ['4:3', "Landscape 4:3"],
  ['9:16', "Portrait 9:16"], ['16:9', "Landscape 16:9"],
]
const SIZES: Array<[string, string]> = [['auto', "Auto"], ['sd', 'Small'], ['hd', '1K'], ['2k', '2K'], ['4k', '4K']]
const plain = (values: string[]): Array<[string, string]> => values.map((value) => [value, value])

const aspect = select('aspect', "Aspect ratio", 'auto', ASPECTS)
const size = select('size', "Size", 'auto', SIZES)
const format = select('format', "Format", 'png', [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WEBP']])
const seed: ParamSpec = { name: 'seed', label: "Seed", widget: 'seed', default: -1 }
const duration = (min: number, max: number): ParamSpec => ({
  name: 'duration', label: "Duration, s", widget: 'number', default: 5, min, max, step: 1,
})

const team = (id: string, name: string, kind: CatalogModel['kind'], params: ParamSpec[], refs = true): CatalogModel => (
  { id, name, kind, refs, params } as CatalogModel
)

/** Снимок каталога сервера команды. У текстовых моделей параметров нет вовсе. */
export const TEAM_MODELS: CatalogModel[] = [
  team('gemini', 'Gemini Flash', 'text', []),
  team('claude', 'Claude Opus 5.5', 'text', []),
  team('gpt-6-astra', 'GPT-6 Astra', 'text', []),
  team('nano-banana', 'Nano Banana 2', 'image', [aspect, size, seed, format]),
  team('gpt-image-2', 'GPT Image 2', 'image', [aspect, size, format]),
  team('grok-image', 'Grok Image', 'image', [aspect, size, format]),
  team('grok-image-hq', 'Grok Image HQ', 'image', [
    select('aspect', "Aspect ratio", '1:1', plain(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '20:9', '19.5:9', '9:19.5', '9:20'])),
    select('size', "Resolution", 'hd', [['hd', '1k'], ['2k', '2k']]),
  ]),
  team('gpt-image-2.5-flare', 'GPT Image 2.5 Flare', 'image', [
    select('aspect', "Aspect ratio", '4:3', [['auto', "Auto"], ...plain(['1:1', '3:4', '9:16', '4:3', '16:9'])]),
    select('size', "Resolution", 'hd', [['hd', '1K'], ['2k', '2K'], ['4k', '4K']]),
    select('quality', "Quality", 'high', [
      ['auto', "Auto"], ['low', "Low"], ['medium', "Medium"], ['high', "High"],
      ['xhigh', "Very high"], ['max', "Maximum"],
    ]),
    select('background', "Background", 'auto', [['auto', "Auto"], ['opaque', "Opaque"], ['transparent', "Transparent"]]),
    select('format', "File format", 'png', [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']]),
    {
      name: 'compression', label: "JPEG/WebP quality", widget: 'slider', min: 0, max: 100, step: 1,
      activeWhen: { name: 'format', values: ['jpeg', 'webp'] },
    },
  ]),
  team('seedance-2', 'Seedance 2.0', 'video', [aspect, size, duration(4, 15)]),
  team('grok-video', 'Grok Video', 'video', [aspect, size, duration(1, 15)]),
  team('veo-omni', 'Gemini Omni Flash', 'video', [
    select('aspect', "Aspect ratio", 'auto', [['auto', "Auto"], ['9:16', "Portrait 9:16"], ['16:9', "Landscape 16:9"]]),
    duration(3, 10),
  ]),
  team('lyria', "Lyria 2 - music", 'audio', [seed, { name: 'negative', label: "What to avoid", widget: 'textarea', default: '' }], false),
]

/** Получатель — как его собирает приложение: умолчание выбирает та же функция, что в редакторе нод. */
export function target(catalog: 'local' | 'team'): MacroImportTarget {
  const models = catalog === 'team' ? TEAM_MODELS : LOCAL_MODELS
  return { catalog, models, defaultModelId: (kind) => defaultNodeModelId(models, kind as NodeKind) }
}

/** Параметры новой ноды — умолчания модели, как их засевает редактор. */
export function seeded(models: readonly CatalogModel[], modelId: string): Record<string, unknown> {
  const model = models.find((item) => item.id === modelId)
  if (!model) throw new Error(`There is no model ${modelId} in the catalog`)
  return Object.fromEntries(model.params.filter((spec) => spec.default !== undefined).map((spec) => [spec.name, spec.default]))
}

export interface KitNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: Record<string, unknown>
  [extra: string]: unknown
}

export function node(id: string, kind: string, data: Record<string, unknown> = {}): KitNode {
  return { id, type: 'gen', position: { x: 0, y: 0 }, data: { kind, prompt: '', status: 'idle', ...data } }
}

/** Связь, как её создаёт редактор: с цветом по типу данных. */
export function edge(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return {
    id: `xy-edge__${source}${sourceHandle}-${target}${targetHandle}`,
    source, target, sourceHandle, targetHandle,
    style: { stroke: '#3fb950', strokeWidth: 2 }, animated: true,
  }
}

/**
 * JSON.stringify recurses through the value tree and overflows the Node 22
 * stack around five thousand nested containers. Macro fixtures deliberately
 * exercise that depth, so keep serialization iterative while retaining JSON's
 * treatment of unsupported values (object properties are omitted and array
 * entries become null).
 */
function stringifyFixture(value: unknown): string {
  type Frame =
    | { kind: 'value'; value: unknown }
    | { kind: 'text'; value: string }
    | { kind: 'leave'; value: object }
  const output: string[] = []
  const stack: Frame[] = [{ kind: 'value', value }]
  const active = new WeakSet<object>()

  while (stack.length > 0) {
    const frame = stack.pop()!
    if (frame.kind === 'text') {
      output.push(frame.value)
      continue
    }
    if (frame.kind === 'leave') {
      active.delete(frame.value)
      continue
    }

    const current = frame.value
    if (current === null) {
      output.push('null')
    } else if (typeof current === 'string') {
      output.push(JSON.stringify(current))
    } else if (typeof current === 'boolean') {
      output.push(current ? 'true' : 'false')
    } else if (typeof current === 'number') {
      output.push(Number.isFinite(current) ? String(current) : 'null')
    } else if (typeof current === 'bigint') {
      throw new TypeError('Do not know how to serialize a BigInt fixture value')
    } else if (typeof current === 'undefined' || typeof current === 'function' || typeof current === 'symbol') {
      output.push('null')
    } else {
      if (active.has(current)) throw new TypeError('Converting circular fixture structure to JSON')
      active.add(current)
      stack.push({ kind: 'leave', value: current })
      if (Array.isArray(current)) {
        output.push('[')
        stack.push({ kind: 'text', value: ']' })
        for (let index = current.length - 1; index >= 0; index -= 1) {
          stack.push({ kind: 'value', value: current[index] })
          if (index > 0) stack.push({ kind: 'text', value: ',' })
        }
      } else {
        output.push('{')
        const objectValue = current as Record<string, unknown>
        const keys = Object.keys(objectValue).filter((key) => {
          const candidate = objectValue[key]
          return candidate !== undefined && typeof candidate !== 'function' && typeof candidate !== 'symbol'
        })
        stack.push({ kind: 'text', value: '}' })
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index]!
          stack.push({ kind: 'value', value: objectValue[key] })
          stack.push({ kind: 'text', value: ':' })
          stack.push({ kind: 'text', value: JSON.stringify(key) })
          if (index > 0) stack.push({ kind: 'text', value: ',' })
        }
      }
    }
  }
  return output.join('')
}

/** Текст файла макроса с такими нодами и связями — каким он приходит извне. */
export function fileText(nodes: unknown[], edges: unknown[] = [], extra: Record<string, unknown> = {}): string {
  return stringifyFixture({ format: 'canai-macro', version: 1, name: 'x', catalog: 'local', modelNames: {}, ...extra, graph: { nodes, edges } })
}

/** Отказ словами (`LibraryFileError`), а не падение. */
export function refused(action: () => unknown, expected: RegExp, label?: string): void {
  assert.throws(action, (error: unknown) => error instanceof LibraryFileError && expected.test(error.message), label)
}

export type Side = 'local' | 'team'
export const CATALOGS: Record<Side, CatalogModel[]> = { local: LOCAL_MODELS, team: TEAM_MODELS }
export const otherSide = (side: Side): Side => (side === 'local' ? 'team' : 'local')

/** Сохранили на одной доске — загрузили на другой. */
export function transfer(from: Side, to: Side, nodes: KitNode[], edges: unknown[] = []): MacroImport {
  const built = buildMacroFile({ name: "Macro", graph: { nodes, edges } }, from, CATALOGS[from])
  return adaptMacroFile(readMacroFile(JSON.stringify(built.file)), target(to))
}

export function dataOf(result: MacroImport, id: string): FileNodeData {
  const found = result.graph.nodes.find((item) => item.id === id)
  if (!found) throw new Error(`There is no ${id} node in the graph`)
  return found.data
}

/**
 * Что не понравится серверу получателя перед запуском: имя параметра, его
 * значение и действует ли он. Пусто — нода запустится. Сверяет сервер с
 * моделью, которая СРАБОТАЕТ: при подключённом референсе это вариант «по
 * референсам» (`workingId`), иначе та, что в ноде.
 */
export function paramProblems(
  models: readonly CatalogModel[],
  data: FileNodeData,
  label: string,
  workingId = data.model,
): string[] {
  const model = models.find((item) => item.id === workingId)
  if (!model) return [`${label}: the recipient does not have the “${workingId}” model`]
  const params = data.params ?? {}
  const problems: string[] = []
  for (const [name, value] of Object.entries(params)) {
    const spec = model.params.find((item) => item.name === name)
    if (!spec) problems.push(`${label}: the model “${model.id}” does not have the parameter “${name}”`)
    else if (!paramValueAllowed(spec, value)) problems.push(`${label}: the value ${JSON.stringify(value)} is not suitable for the parameter “${name}”`)
    else if (!parameterActive(spec, model.params, params)) problems.push(`${label}: parameter “${name}” has no effect with these values`)
  }
  return problems
}

/** Нода запустится у получателя: его серверу нечего возразить (см. `paramProblems`). */
export function assertRunnable(...args: Parameters<typeof paramProblems>): void {
  assert.deepEqual(paramProblems(...args), [])
}

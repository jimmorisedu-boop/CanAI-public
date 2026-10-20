import type { ParamSpec } from '../../types'
import { plural } from '../../ui/plural'
import { isKnownNodeKind, metaFor } from '../nodes/ports'
import type { NodeKind } from '../nodes/types'
import { cutChars, own, type LibraryCatalog } from './libraryFile'
import { safeKey, type FileParamInfo, type ParamValue } from './macroFileModels'

// Что сказать человеку после загрузки макроса из файла или из буфера.
//
// ⚠️ Раньше о параметрах выходила одна общая фраза — «Часть параметров моделей
// сброшена к значениям по умолчанию» — почти при каждом переносе между своей
// доской и сетевой, даже когда терялось лишь служебное «картинок: 1». По ней
// нельзя было понять ни что пропало, ни в какой ноде; а настоящая потеря
// (системный промпт LLM, длительность ролика) пряталась за ней же. Теперь
// каждая строка называет ноду, настройку по её подписи и то, что с ней стало.

/** Сколько строк о настройках показываем; остальное сворачиваем в «и ещё N». */
const MAX_LOSS_NOTES = 6
const MAX_VALUE_SHOWN = 40
const MAX_NAME_SHOWN = 60

/** Чужой текст в замечании: в одну строку и не длиннее заданного. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/gu, ' ').trim()
  const cut = cutChars(line, max)
  return cut.length < line.length ? `${cut.trimEnd()}…` : line
}

function shown(value: ParamValue | undefined, labels: Record<string, string> | undefined): string {
  if (typeof value === 'boolean') return value ? "“on”" : "“off”"
  if (typeof value === 'number') return String(value)
  if (value === undefined || value.trim() === '') return "“empty”"
  return `«${clip(own(labels, value) ?? value, MAX_VALUE_SHOWN)}»`
}

/** Подпись настройки: какой её видел автор; файл не помнит — какой её видит получатель. */
const paramLabel = (name: string, info: FileParamInfo | undefined, spec?: ParamSpec): string => (
  `«${info?.label ?? spec?.label ?? name}»`
)

/**
 * Знает ли редактор такой вид ноды.
 *
 * ⚠️ Реестр видов (`NODE_PORTS`, `NODE_META` в nodes/ports.ts) — обычный
 * объект: по имени `constructor` или `toString` он отдаёт служебную функцию, и
 * вид с таким именем сходил за знакомый, а назывался «undefined».
 */
export function knownNodeKind(kind: string): boolean {
  return safeKey(kind, 40) && isKnownNodeKind(kind as NodeKind)
}

/** Название вида ноды, как оно написано на самой ноде. */
export function kindTitle(kind: string): string {
  return knownNodeKind(kind)
    ? `«${metaFor(kind as NodeKind).title}»`
    : `unknown node "${clip(kind, MAX_VALUE_SHOWN)}"`
}

/** Как назвать ноду в замечании: её вид и модель, которая теперь в ней стоит. */
export function nodeLabel(kind: string, modelName: string): string {
  return `${kindTitle(kind)} (${clip(modelName, MAX_NAME_SHOWN)})`
}

/**
 * В ноде не была выбрана модель (так выглядят ноды старых макросов). Картинку и
 * видео без модели сервер команды не запустит («Неизвестная модель»), а
 * параметры чужого каталога не разберёт ни один из серверов — при переносе
 * между каталогами модель ставим сами и называем её.
 */
export function unsetModelNote(label: string): string {
  return `${label}: no model was selected in the node - the default model was set`
}

/** У модели получателя такой настройки нет вовсе. */
export function lostParamNote(name: string, value: ParamValue, info: FileParamInfo | undefined): string {
  return `the ${paramLabel(name, info)} setting is not here - the ${shown(value, info?.values)} value is not transferred`
}

/** Настройка у получателя есть, но такого значения в ней нет. */
export function lostValueNote(
  name: string,
  value: ParamValue,
  info: FileParamInfo | undefined,
  spec: ParamSpec,
  fallback: ParamValue | undefined,
): string {
  const labels = Object.fromEntries((spec.options ?? []).map((option) => [option.value, option.label]))
  const taken = fallback === undefined ? "the setting remained unset" : `delivered by ${shown(fallback, labels)}`
  return `setting ${paramLabel(name, info, spec)} has no value here ${shown(value, info?.values)} - ${taken}`
}

/**
 * В файле были настройки, которых у получателя нет, а выбирал ли их автор,
 * файл не помнит (он прежнего вида или не знает этой модели). Перечислять их
 * нечем — у них нет подписей, — но и молчать о возможной потере нельзя.
 */
export function unsureParamsNote(label: string): string {
  return `${label}: some of the settings from the file do not apply here - check the node in the editor`
}

export function systemPromptNote(label: string): string {
  return `${label}: the system prompt has been moved to the beginning of the node prompt - there is no separate field for it here`
}

/**
 * Ноды, которые у получателя не работают: вид, который его сервер не
 * исполняет, либо вид, для которого у него нет ни одной модели.
 *
 * ⚠️ Раньше про ноду без модели говорилось «выберите модель в ноде» — а
 * выбирать было не из чего. Сервер команды к тому же отказывает всему макросу,
 * своя доска — только ветке с такой нодой.
 */
export function brokenNodesNote(catalog: LibraryCatalog, titles: readonly string[]): string {
  const list = titles.join(', ')
  return catalog === 'team'
    ? `Nodes do not work on the network board: ${list} - the macro will not run with them`
    : `Nodes do not work here: ${list} - their part of the macro will not be executed`
}

export function missingFilesNote(count: number): string {
  return count === 1
    ? "The file in the “File” node is not transferred - select it again"
    : `Files in the “File” nodes are not transferred - select them again (node: ${count})`
}

export function replacedModelNote(from: string, to: string): string {
  return `Model "${clip(from, MAX_NAME_SHOWN)}" replaced with "${clip(to, MAX_NAME_SHOWN)}"`
}

/**
 * Одинаковые замечания — одной строкой с числом нод; длинный список
 * сворачивается: читать тридцать строк подряд никто не станет.
 */
export function tallied(lines: readonly string[], capped = false): string[] {
  const counts = new Map<string, number>()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  const merged = [...counts].map(([line, count]) => (
    count > 1 ? `${line} (in ${count} ${plural(count, ["node", "nodes", "nodes"])})` : line
  ))
  if (!capped || merged.length <= MAX_LOSS_NOTES) return merged
  const hidden = merged.length - MAX_LOSS_NOTES
  return [
    ...merged.slice(0, MAX_LOSS_NOTES),
    `…and ${hidden} more ${plural(hidden, ["note", "notes", "notes"])} about settings — check the nodes in the workflow editor`,
  ]
}

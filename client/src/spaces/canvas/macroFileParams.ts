import { paramValueAllowed } from '../../../../packages/model-catalog/macroModels'
import { parameterActive } from '../../../../packages/model-catalog/parameterRules'
import type { CatalogModel, ParamSpec } from '../../types'
import { AUTO_BY_REF_PARAMS } from './autoParam'
import { own } from './libraryFile'
import type { FileNode } from './macroFile'
import { isParamValue, type FileParamInfo, type ParamValue } from './macroFileModels'
import { lostParamNote, lostValueNote } from './macroFileNotes'

// Параметры ноды из файла — под модель получателя.
//
// ⚠️ У своей доски и у сервера команды одна и та же настройка зовётся и хранится
// по-разному: `aspect_ratio` и `aspect`, размер `1K` и `hd`, длительность
// строкой «12» и числом 12. Что переводится — переводим, прочее берёт умолчание
// получателя, а о том, что при этом РЕАЛЬНО потерялось, собираем слова для
// человека (сами слова — в macroFileNotes.ts).

/**
 * Одна настройка под разными именами у своего каталога и у сервера команды.
 * Двойник таблицы `aliases` в packages/model-catalog/canonBridge.ts (там перевод
 * в одну сторону — при запуске генерации); за расхождением следит сторож в
 * macroFileAdapt.test.ts.
 *
 * ⚠️ Таблицы — `Map`, а не объекты: у объекта по ключу `constructor` или
 * `toString` лежит служебная функция, и параметр с таким именем из чужого
 * файла ронял загрузку отказом по-английски («… is not iterable»).
 */
const PARAM_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['aspect_ratio', ['aspect']], ['aspect', ['aspect_ratio']],
  ['resolution', ['size']], ['image_size', ['size']], ['size', ['resolution', 'image_size']],
  ['output_format', ['format']], ['format', ['output_format']],
  ['negative_prompt', ['negative']], ['negative', ['negative_prompt']],
  ['output_compression', ['compression']], ['compression', ['output_compression']],
])

/** Параметры-размеры: только их значения переводятся по таблице ступеней. */
const SIZE_PARAMS: ReadonlySet<string> = new Set(['size', 'resolution', 'image_size'])

/**
 * Ступени размера у своего каталога и у сервера команды называются по-разному.
 * Перевод «своя → сетевая» повторяет таблицу `sizes` в canonBridge.ts.
 */
const SIZE_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['0.5K', ['sd']], ['1K', ['hd']], ['1k', ['hd']], ['2K', ['2k']], ['4K', ['4k']],
  ['480p', ['sd']], ['720p', ['hd']], ['1080p', ['2k']], ['square_hd', ['hd']], ['square', ['sd']],
  ['sd', ['480p', '0.5K']], ['hd', ['720p', '1K', '1k']], ['2k', ['1080p', '2K']], ['4k', ['4K']],
])

/**
 * Параметры, которые человек в ноде не выбирал: панель ноды их не показывает
 * (`panelParams` в genOptions.ts убирает число картинок — на ноду всегда одна).
 * Их потеря ни на что не влияет, и говорить о ней незачем.
 */
const UNSEEN_PARAMS: ReadonlySet<string> = new Set(['num_images'])

const DIGITS = /^\d+(?:\.\d+)?$/u

const isNumeric = (spec: ParamSpec): boolean => (
  spec.widget === 'number' || spec.widget === 'slider' || spec.widget === 'seed'
)

function findSpec(model: CatalogModel, name: string): ParamSpec | undefined {
  const specs = model.params ?? []
  for (const candidate of [name, ...(PARAM_ALIASES.get(name) ?? [])]) {
    const spec = specs.find((item) => item.name === candidate)
    if (spec) return spec
  }
  return undefined
}

/**
 * Значение в том виде, в каком его поймёт поле получателя.
 *
 * ⚠️ Одно и то же значение каталоги хранят в разном ВИДЕ: длительность Seedance
 * на своей доске — строка из списка («12»), на сервере команды — число. При
 * буквальном сравнении она терялась в обе стороны: ролик выходил другой длины
 * и другой цены.
 */
function fittingValue(spec: ParamSpec, value: ParamValue): ParamValue | undefined {
  const candidates: ParamValue[] = [value]
  if (isNumeric(spec) && typeof value === 'string' && DIGITS.test(value.trim())) candidates.push(Number(value))
  if (spec.widget === 'select' && typeof value === 'number') candidates.push(String(value))
  if (typeof value === 'string' && SIZE_PARAMS.has(spec.name)) candidates.push(...(SIZE_ALIASES.get(value) ?? []))
  return candidates.find((candidate) => paramValueAllowed(spec, candidate))
}

/**
 * «Авто» у пропорций и размера значит «решит модель по референсу». Базовая
 * модель может такого значения не знать, а её вариант «по референсам» знает
 * (у своей доски так устроен Grok) — и редактор сам ставит ноде «Авто», когда к
 * ней подключают референс (nodeAspect.ts).
 *
 * ⚠️ Без этого нода с подключённым референсом получала умолчание БАЗОВОЙ
 * модели: на сетевой доске кадр шёл в пропорциях референса, а после переноса
 * на свою — квадратом, молча и за те же деньги. Открытие редактора этого не
 * чинит: оно не «переход», и правило редактора на нём не срабатывает.
 */
function autoByReference(spec: ParamSpec, working: CatalogModel): boolean {
  if (!AUTO_BY_REF_PARAMS.includes(spec.name)) return false
  const twin = (working.params ?? []).find((item) => item.name === spec.name)
  return Boolean(twin && paramValueAllowed(twin, 'auto'))
}

/**
 * Выбирал ли человек это значение — или оно стояло по умолчанию.
 *
 * Потеря умолчания ни на что не влияет: получатель возьмёт своё. Судить можно
 * только по тому, что файл помнит о параметрах модели автора (`paramInfo`):
 *   • о модели в файле ничего нет (файл прежнего вида) — «неизвестно»;
 *   • о модели есть, а такого параметра у неё нет — это не настройка, а мусор:
 *     каталог автора сам её не знал.
 */
function chosen(
  name: string,
  value: ParamValue,
  info: Record<string, FileParamInfo> | undefined,
): 'yes' | 'no' | 'unknown' {
  if (UNSEEN_PARAMS.has(name)) return 'no'
  if (!info) return 'unknown'
  const known = own(info, name)
  if (!known) return 'no'
  return known.default === undefined || known.default !== value ? 'yes' : 'no'
}

export interface TranslatedParams {
  params: Record<string, ParamValue>
  /** Системный промпт, которому у модели получателя нет своего поля. */
  systemPrompt: string
  /** Что не перенеслось — готовыми словами, без названия ноды. */
  losses: string[]
  /** Были настройки, которых у получателя нет, а выбирал ли их автор — файл не помнит. */
  unsure: boolean
}

/**
 * Параметры ноды для модели получателя: что переводится — переводим, прочее
 * берёт умолчание.
 *
 * `model` — модель, которая записана в ноде (базовая); `working` — та, что
 * сработает при подключённых к ноде входах (её вариант «по референсам» или она
 * же). Набор параметров в ноде — всегда базовой модели: так его засевает
 * редактор.
 */
export function translateParams(
  node: FileNode,
  model: CatalogModel,
  working: CatalogModel,
  info: Record<string, FileParamInfo> | undefined,
): TranslatedParams {
  const specs = model.params ?? []
  const params: Record<string, ParamValue> = {}
  for (const spec of specs) if (isParamValue(spec.default)) params[spec.name] = spec.default
  const losses: string[] = []
  let systemPrompt = ''
  let unsure = false
  for (const [name, value] of Object.entries(node.data.params ?? {})) {
    const spec = findSpec(model, name)
    if (!spec) {
      // ⚠️ Системный промпт LLM-ноды — не настройка, а половина её смысла. У
      // текстовых моделей сервера команды такого поля нет, и раньше текст
      // просто выбрасывался: макрос запускался, LLM отвечала без своих
      // инструкций, и дальше по цепочке уходили не те промпты.
      if (name === 'system_prompt' && node.data.kind === 'text') {
        if (typeof value === 'string') systemPrompt = value.trim()
        continue
      }
      const picked = chosen(name, value, info)
      if (picked === 'yes') losses.push(lostParamNote(name, value, own(info, name)))
      else if (picked === 'unknown') unsure = true
      continue
    }
    const fitting = fittingValue(spec, value)
    if (fitting !== undefined) {
      params[spec.name] = fitting
      continue
    }
    if (value === 'auto' && autoByReference(spec, working)) {
      params[spec.name] = 'auto'
      continue
    }
    // «Авто» при числовом поле — «пусть решает модель»: у получателя такого
    // значения нет, остаётся его умолчание.
    // ⚠️ Говорим об этом всегда — и когда «Авто» у автора стояло по умолчанию
    // (длительность Seedance на своей доске). Раньше молчали: длину ролика
    // выбирала модель, а после переноса он всегда выходил пятисекундным.
    // Сам параметр НЕ убираем: без длительности сервер команды считает цену
    // по самому длинному ролику, а панель ноды показывала бы умолчание.
    if (value === 'auto' && isNumeric(spec)) {
      losses.push(lostValueNote(name, value, own(info, name), spec, params[spec.name]))
      continue
    }
    // Значение, которого у получателя нет, называем и тогда, когда файл не
    // помнит, выбирал ли его автор: сам факт верен, а подпись настройки есть у
    // получателя. Умолчания одной и той же модели между каталогами переводятся
    // (за этим следит тест «нода на умолчаниях…»), так что это почти всегда выбор.
    if (chosen(name, value, info) !== 'no') {
      losses.push(lostValueNote(name, value, own(info, name), spec, params[spec.name]))
    }
  }
  // Настройка, которая при этих значениях не действует (качество JPEG при
  // формате PNG), у своего сервера — причина отказа всей ноде.
  for (const spec of specs) if (!parameterActive(spec, specs, params)) delete params[spec.name]
  return { params, systemPrompt, losses, unsure }
}

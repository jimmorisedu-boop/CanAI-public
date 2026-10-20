import type { CatalogModel, ParamSpec } from '../../types'
import { cleanName, isPlain } from './libraryFile'

// Что файл макроса помнит о моделях автора: их имена и параметры.
//
// У получателя каталог может быть другим (своя доска и сервер команды зовут
// одну модель и одну настройку по-разному). Только по этим именам модель у него
// находится, и только по этим подписям и умолчаниям ему можно сказать словами,
// что не перенеслось и меняет ли это что-нибудь.

export type ParamValue = string | number | boolean

/** Что файл помнит о параметре модели: подпись и умолчание на момент сохранения. */
export interface FileParamInfo {
  label: string
  default?: ParamValue
  /** Подписи значений списка — там, где они отличаются от самих значений. */
  values?: Record<string, string>
}

export type FileModelNames = Record<string, string>
export type FileParamInfoMap = Record<string, Record<string, FileParamInfo>>

export const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u
/**
 * Сколько параметров берём у одной ноды. Свой сервер пропускает к серверу
 * команды до 54 параметров запроса (parseParams в server/src/routes.ts: 48
 * полей подключённой модели и 6 общих) — столько с небольшим запасом.
 */
export const MAX_NODE_PARAMS = 60
/** Моделей в файле не бывает больше, чем нод (MAX_NODES в macroFile.ts). */
const MAX_MODELS = 200
const MAX_OPTIONS = 64
const MAX_MODEL_ID = 200

export function isParamValue(value: unknown): value is ParamValue {
  return typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * Годится ли строка в ключи таблицы.
 *
 * ⚠️ Имя, которое есть у любого объекта (`constructor`, `toString`,
 * `__proto__`), своим ключом быть не может: по такому «ключу» таблица отдаёт
 * служебную функцию, а запись в `__proto__` меняет сам объект.
 */
export function safeKey(key: string, max: number): boolean {
  return key.length > 0 && key.length <= max && !(key in Object.prototype)
}

export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && safeKey(value, MAX_MODEL_ID)
}

/**
 * Параметр, как его описывают модели одной семьи. Подпись и умолчание — у
 * первой (базовой: с ними нода создаётся), подписи значений — со всех: «Авто»
 * у пропорций бывает только у варианта «по референсам».
 */
function describeParam(specs: readonly ParamSpec[]): FileParamInfo {
  const [base] = specs
  const values: Record<string, string> = {}
  for (const option of specs.flatMap((spec) => spec.options ?? [])) {
    if (Object.keys(values).length >= MAX_OPTIONS) break
    if (option.label !== option.value && safeKey(option.value, 80) && !Object.hasOwn(values, option.value)) {
      values[option.value] = option.label
    }
  }
  return {
    label: cleanName(base.label, 80) || base.name,
    ...(isParamValue(base.default) ? { default: base.default } : {}),
    ...(Object.keys(values).length > 0 ? { values } : {}),
  }
}

/** Имена и параметры моделей, которыми пользуется граф, — как их знает каталог автора. */
export function describeModels(
  modelIds: Iterable<string>,
  models: readonly CatalogModel[],
): { modelNames: FileModelNames; paramInfo: FileParamInfoMap } {
  const modelNames: FileModelNames = {}
  const paramInfo: FileParamInfoMap = {}
  for (const id of modelIds) {
    const model = models.find((item) => item.id === id)
    if (!model || Object.hasOwn(modelNames, id)) continue
    modelNames[id] = model.name
    // В ноде лежит базовая модель, а её вариант «по референсам» включается сам
    // и может добавить свои параметры — описываем и их.
    const family = [model, ...models.filter((item) => item.id === model.pairId || item.id === model.videoPairId)]
    const specs = family.flatMap((item) => item.params ?? [])
    const info: Record<string, FileParamInfo> = {}
    for (const spec of specs) {
      if (!PARAM_NAME.test(spec.name) || !safeKey(spec.name, 64) || Object.hasOwn(info, spec.name)) continue
      info[spec.name] = describeParam(specs.filter((item) => item.name === spec.name))
    }
    paramInfo[id] = info
  }
  return { modelNames, paramInfo }
}

export function readModelNames(raw: unknown): FileModelNames {
  const modelNames: FileModelNames = {}
  if (!isPlain(raw)) return modelNames
  for (const [id, name] of Object.entries(raw).slice(0, MAX_MODELS)) {
    const clean = cleanName(name, 160)
    if (isModelId(id) && clean) modelNames[id] = clean
  }
  return modelNames
}

/** `undefined` — в файле сведений о параметрах нет вовсе: файл прежнего вида. */
export function readParamInfo(raw: unknown): FileParamInfoMap | undefined {
  if (!isPlain(raw)) return undefined
  const paramInfo: FileParamInfoMap = {}
  for (const [modelId, params] of Object.entries(raw).slice(0, MAX_MODELS)) {
    if (!isModelId(modelId) || !isPlain(params)) continue
    const info: Record<string, FileParamInfo> = {}
    for (const [name, value] of Object.entries(params).slice(0, MAX_NODE_PARAMS)) {
      const label = isPlain(value) ? cleanName(value.label, 80) : ''
      if (!isPlain(value) || !label || !PARAM_NAME.test(name) || !safeKey(name, 64)) continue
      const values: Record<string, string> = {}
      for (const [option, text] of Object.entries(isPlain(value.values) ? value.values : {}).slice(0, MAX_OPTIONS)) {
        const shown = cleanName(text, 80)
        if (shown && safeKey(option, 80)) values[option] = shown
      }
      info[name] = {
        label,
        ...(isParamValue(value.default) ? { default: value.default } : {}),
        ...(Object.keys(values).length > 0 ? { values } : {}),
      }
    }
    paramInfo[modelId] = info
  }
  return paramInfo
}

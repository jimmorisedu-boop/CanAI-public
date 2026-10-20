import type { CatalogModel, ParamSpec } from '../../types'
import { autoMeansUnset, isAspectParam } from './autoParam'

type Values = Record<string, unknown>
type ParamOptions = { hasMediaRefs?: boolean; allowAutoWithoutRefs?: boolean; referenceAspectRatio?: number | null }

function hasOwn(values: Values, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, name)
}

const NUMERIC_TEXT = /^-?\d+(?:\.\d+)?$/

// Сохранённое значение в том виде, в каком его примет ЭТА модель; undefined —
// не годится вовсе.
//
// Проверка обязана повторять серверную (validateModelParams): всё, что клиент
// оставит у себя, сервер получит и может отвергнуть целиком — ответом
// «Параметры не соответствуют выбранной модели», по которому пользователю
// нечего понять. Раньше сверялись только списки select, а числа проходили
// как есть: значение, законное вчера, после смены границ в каталоге
// превращалось в наглухо неработающую генерацию, и починить её можно было
// только угадав, какую ручку тронуть.
//
// ⚠️ Совпасть должен и ТИП, а не только написание. Память ручек одна на обе
// доски (`canai-model-params`), а номер модели у них общий — `seedance-2`. У
// своей доски длительность — список строк «4»…«15», у сервера команды — число.
// Число 15 из сетевой доски проходило сверку по `String(value)`, уходило в
// запрос числом, и сервер отвергал ВСЮ генерацию (жалоба 19.10.2026: Seedance
// по картинке, 480p, 15 с). Значение приводим к виду поля, а не выбрасываем:
// длительность — это деньги, и молча подставленное «Авто» стоило бы другого.
function normalized(spec: ParamSpec, value: unknown): unknown {
  if (value === undefined || value === null) return undefined
  if (spec.widget === 'select') {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined
    const text = String(value)
    return spec.options?.some((option) => option.value === text) ? text : undefined
  }
  if (spec.widget === 'boolean') return typeof value === 'boolean' ? value : undefined
  if (spec.widget === 'number' || spec.widget === 'slider' || spec.widget === 'seed') {
    const number = typeof value === 'string' && NUMERIC_TEXT.test(value.trim()) ? Number(value) : value
    if (typeof number !== 'number' || !Number.isFinite(number)) return undefined
    if ((spec.step === 1 || spec.widget === 'seed') && !Number.isInteger(number)) return undefined
    // у seed границ нет вовсе: −1 означает «случайный»
    if (spec.min != null && number < spec.min) return undefined
    if (spec.max != null && number > spec.max) return undefined
    return number
  }
  if (typeof value !== 'string') return undefined
  if (spec.options && !spec.options.some((option) => option.value === value)) return undefined
  return value
}

function supported(spec: ParamSpec, value: unknown): boolean {
  return normalized(spec, value) !== undefined
}

function closestSupportedAspect(spec: ParamSpec, referenceRatio: number | null | undefined): string | undefined {
  if (!referenceRatio || !Number.isFinite(referenceRatio) || referenceRatio <= 0) return undefined
  let closest: string | undefined
  let distance = Infinity
  for (const option of spec.options ?? []) {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(option.value)
    if (!match) continue
    const ratio = Number(match[1]) / Number(match[2])
    if (!Number.isFinite(ratio) || ratio <= 0) continue
    const nextDistance = Math.abs(Math.log(ratio / referenceRatio))
    if (nextDistance < distance) {
      closest = option.value
      distance = nextDistance
    }
  }
  return closest
}

/**
 * «Авто» у пропорций без референса — обещание, которое некому выполнить.
 *
 * ⚠️ Имя параметра задаёт каталог: у своего это `aspect_ratio`, у сервера
 * команды — `aspect`. Проверка знала только первое, и на планшете сетевой
 * доски панель показывала конкретную пропорцию, а в запрос уходило другое.
 * Исключение — канон сервера с «Авто» по умолчанию: там это «параметр не
 * задан», панель так и показывает, и подменять его нечем (см. autoParam.ts).
 */
function autoWithoutRefs(
  spec: ParamSpec,
  candidate: unknown,
  hasMediaRefs: boolean,
  options: ParamOptions | undefined,
): boolean {
  return isAspectParam(spec.name)
    && !autoMeansUnset(spec)
    && !hasMediaRefs
    && !options?.allowAutoWithoutRefs
    && candidate === 'auto'
}

export function reconcileModelParams(
  model: CatalogModel | null,
  current: Values,
  saved: Values = {},
  options?: ParamOptions,
): Values {
  if (!model) return {}
  const output: Values = {}
  const hasMediaRefs = options?.hasMediaRefs ?? false
  for (const spec of model.params) {
    let candidate = hasOwn(current, spec.name)
      ? current[spec.name]
      : saved[spec.name]
    if (autoWithoutRefs(spec, candidate, hasMediaRefs, options)) candidate = undefined
    const value = normalized(spec, candidate)
    if (value !== undefined) output[spec.name] = value
  }
  return output
}

export function materializeModelParams(
  model: CatalogModel | null,
  current: Values,
  options?: ParamOptions,
): Values {
  if (!model) return {}
  const output: Values = {}
  const hasMediaRefs = options?.hasMediaRefs ?? false
  for (const spec of model.params) {
    if (spec.name === 'num_images') continue
    let candidate = hasOwn(current, spec.name)
      ? current[spec.name]
      : spec.default

    // Некоторые сетевые модели не принимают буквальное auto. Интерфейс
    // предлагает его при выборе фото, а перед запросом переводит в ближайшее
    // значение из серверной схемы — неподдерживаемое auto не уходит в API.
    if (isAspectParam(spec.name)
      && candidate === 'auto' && !supported(spec, 'auto')) {
      candidate = closestSupportedAspect(spec, options?.referenceAspectRatio) ?? spec.default
    }

    if (autoWithoutRefs(spec, candidate, hasMediaRefs, options)) {
      const nonAutoOpt = spec.options?.find((o) => o.value !== 'auto')?.value
      candidate = spec.default !== 'auto' ? spec.default : (nonAutoOpt ?? '1:1')
    }

    const value = normalized(spec, candidate)
    if (value !== undefined) output[spec.name] = value
  }
  return output
}

import type { CatalogDefaults, CatalogModel, JobKind } from '../../types'
import { executorCompatibilityError } from '../../../../packages/model-catalog/version'
import { baseModels, effectiveModel } from './genOptions'
import {
  audioNeedsVisualText,
  autoRefusalText,
  emptyCatalogText,
  notAcceptedText,
  singleMediaKindText,
  tooFewText,
  tooManyText,
  tooManyTotalText,
  wrongKindText,
  type MediaRefKind,
  type RefCounts,
} from './smartModelMessages'

// Подбор модели в доке: явный выбор из списка либо «Авто». Чистые функции —
// одно правило на предпросмотр, цену, согласие и запуск, на компьютер и планшет.

/**
 * Значение пункта «Авто» в списке моделей. Живёт ТОЛЬКО в интерфейсе: в запрос,
 * на карточку и в черновик сеанса уходит настоящий номер модели либо ничего.
 */
export const AUTO_MODEL_ID = '__canai_auto_model__'

export type SmartModelRefKind = MediaRefKind | 'text'

export interface SmartModelRef {
  kind: SmartModelRefKind
}

export interface SmartModelSelectionInput {
  models: readonly CatalogModel[]
  kind: JobKind
  /** Что уйдёт в запрос — см. smartRefsFor. */
  refs?: readonly SmartModelRef[]
  /** null и AUTO_MODEL_ID означают «Авто». */
  modelId?: string | null
  defaults?: CatalogDefaults
}

export interface SmartModelSelectionResult {
  /** Модель, которая уйдёт в котировку и запуск: вариант «по референсам» уже подставлен. */
  model: CatalogModel | null
  /**
   * Её базовая модель из списка. Именно она хранится на карточке и объекте и
   * возвращается в док: номер варианта в списке выбрать нельзя.
   */
  baseModel: CatalogModel | null
  /** Чьи параметры показывать: при отказе «Авто» — модели по умолчанию. */
  panelModel: CatalogModel | null
  /** Причина отказа словами; null — модель принимает этот набор. */
  error: string | null
  mode: 'auto' | 'manual'
}

/**
 * Какие референсы видит подбор — РОВНО то, что уйдёт в запрос, а не то, что
 * лежит чипами.
 *
 * 1. Генерируем не видео — ролик уходит кадром-картинкой (toGenRefs), значит и
 *    считается картинкой. Иначе «картинка по видео» не запускалась вовсе:
 *    модели картинок видео не берут.
 * 2. В режиме скетча уходит одна склейка «картинка + рисунок», сколько бы чипов
 *    ни было выделено.
 */
export function smartRefsFor(
  kind: JobKind,
  refs: readonly SmartModelRef[],
  sketchTarget?: string | null,
): SmartModelRef[] {
  if (sketchTarget) return [{ kind: 'image' }]
  return refs.map((ref) => ({
    kind: ref.kind === 'video' && kind !== 'video' ? 'image' : ref.kind,
  }))
}

function counts(refs: readonly SmartModelRef[]): RefCounts {
  return refs.reduce<RefCounts>((result, ref) => {
    result[ref.kind] += 1
    return result
  }, { image: 0, video: 0, audio: 0, text: 0 })
}

function lifecycleError(model: CatalogModel | null): string | null {
  if (!model) return "Model not found in the current catalog."
  if (model.lifecycle === 'disabled') return `Model "${model.name}" is disabled in the catalog.`
  if (model.lifecycle === 'archived') return `Model "${model.name}" has been archived and is not available for new launch.`
  // Каталог сервера команды помечает недоступную модель признаком unavailable
  // (cloudCatalogModel). Гадать о доступности по имени или адресу нельзя.
  const availability = model as CatalogModel & { unavailable?: unknown }
  if (availability.unavailable === true) {
    return `Model "${model.name}" is not available in this connection.`
  }
  return executorCompatibilityError(model)
}

function modality(model: CatalogModel, kind: SmartModelRefKind): boolean {
  const declared = model.inputModalities
  // Если каталог перечислил виды входа, верим ему: случайный предел или поле
  // не должны «добавлять» модели второй вид медиа.
  if (declared && declared.length > 0) return declared.includes(kind)
  if (kind === 'image') {
    return Boolean(model.refs || model.imageInputField || (model.maxImageRefs ?? 0) > 0)
  }
  if (kind === 'video') {
    return Boolean(model.videoRefs || model.videoInputField || (model.maxVideoRefs ?? 0) > 0)
  }
  if (kind === 'audio') {
    return Boolean(model.audioInputField || (model.maxAudioRefs ?? 0) > 0)
  }
  // Промпт уходит отдельно: модель без объявленного «text» его всё равно берёт.
  return true
}

function referenceError(model: CatalogModel, refCounts: RefCounts): string | null {
  const { image, video, audio } = refCounts
  const mediaKinds = Number(image > 0) + Number(video > 0) + Number(audio > 0)
  if (mediaKinds > 1 && model.mediaInputMode === 'single') return singleMediaKindText(model.name)

  const values: Array<[MediaRefKind, number, number | undefined, number | undefined]> = [
    ['image', image, model.minImageRefs, model.maxImageRefs],
    ['video', video, model.minVideoRefs, model.maxVideoRefs],
    ['audio', audio, model.minAudioRefs, model.maxAudioRefs],
  ]
  for (const [kind, value, min, max] of values) {
    if (value > 0 && !modality(model, kind)) return notAcceptedText(model.name, kind)
    if (min != null && value < min) return tooFewText(model.name, kind, min, value)
    if (max != null && value > max) return tooManyText(model.name, kind, max, value)
  }

  const total = image + video + audio
  if (model.maxTotalRefs != null && total > model.maxTotalRefs) {
    return tooManyTotalText(model.name, model.maxTotalRefs, total)
  }
  if (model.audioRequiresVisualRef && audio > 0 && image + video === 0) {
    return audioNeedsVisualText(model.name)
  }
  return null
}

/**
 * Вид референса, который не берёт НИ ОДИН вариант выбранной модели.
 *
 * ⚠️ Без этого Grok Video с картинкой и звуком отвечал «не берёт картинки»:
 * звук отменял вариант «по кадру», и проверка шла по базовой модели, которая
 * картинок и правда не берёт. Человек убирал картинку — и упирался в звук.
 * Звук и ролик проверяем первыми: картинки семья берёт чаще всего.
 */
function familyRefusal(models: CatalogModel[], selected: CatalogModel, refCounts: RefCounts): string | null {
  const family = [selected, ...[selected.pairId, selected.videoPairId]
    .map((id) => models.find((model) => model.id === id))
    .filter((model): model is CatalogModel => Boolean(model))]
  for (const kind of ['audio', 'video', 'image'] as const) {
    if (refCounts[kind] > 0 && !family.some((model) => modality(model, kind))) {
      return notAcceptedText(selected.name, kind)
    }
  }
  return null
}

function defaultForKind(defaults: CatalogDefaults | undefined, kind: JobKind): string | null {
  if (!defaults) return null
  if (kind === 'image' || kind === 'video' || kind === 'audio') return defaults[kind]
  if (kind === 'text') return defaults.assistant
  return null
}

function effectiveCandidate(
  models: CatalogModel[],
  kind: JobKind,
  candidateId: string,
  refCounts: RefCounts,
): CatalogModel | null {
  return effectiveModel(
    models,
    kind,
    candidateId,
    refCounts.image > 0,
    refCounts.video > 0,
    refCounts.audio > 0,
    refCounts.image,
  )
}

/**
 * Базовая модель варианта: «…-edit», «…-i2v», «…-refs» → модель из списка.
 * У самостоятельной модели базой остаётся она сама.
 */
export function baseModelOf(models: readonly CatalogModel[], model: CatalogModel): CatalogModel {
  return models.find((item) => item.pairId === model.id || item.videoPairId === model.id) ?? model
}

/**
 * Номер, который можно выбрать в списке, по сохранённому номеру модели.
 * На карточках и в черновиках встречается номер варианта: его в списке нет, и
 * запуск по нему без референса ушёл бы в ручку правки без входной картинки.
 * null — такой модели в каталоге нет.
 */
export function selectableModelId(
  models: readonly CatalogModel[],
  modelId: string | null | undefined,
): string | null {
  if (!modelId || modelId === AUTO_MODEL_ID) return null
  const found = models.find((item) => item.id === modelId)
  return found ? baseModelOf(models, found).id : null
}

function manualSelection(
  input: SmartModelSelectionInput,
  refCounts: RefCounts,
): SmartModelSelectionResult {
  const models = input.models as CatalogModel[]
  const found = models.find((model) => model.id === input.modelId) ?? null
  if (!found) {
    return {
      model: null, baseModel: null, panelModel: null,
      error: "The selected model is not in the current catalog.", mode: 'manual',
    }
  }
  // Сохранённый номер варианта разрешаем через его базу: иначе вариант «по
  // референсам» запускался бы и без референсов.
  const selected = baseModelOf(models, found)
  const refused = (error: string): SmartModelSelectionResult => (
    { model: selected, baseModel: selected, panelModel: selected, error, mode: 'manual' }
  )
  if (selected.kind !== input.kind) return refused(wrongKindText(selected.name, input.kind))
  // Сначала сама выбранная модель: архивная или отключённая база не должна
  // «оживать» только потому, что её вариант по референсам ещё активен.
  const selectedError = lifecycleError(selected)
  if (selectedError) return refused(selectedError)
  const model = effectiveCandidate(models, input.kind, selected.id, refCounts)
  const error = lifecycleError(model) ?? familyRefusal(models, selected, refCounts) ?? referenceError(model!, refCounts)
  return { model, baseModel: selected, panelModel: model ?? selected, error, mode: 'manual' }
}

/** Каталог сервера команды помечает уходящие модели; у своего каталога поля нет. */
function deprecated(model: CatalogModel): boolean {
  return (model as CatalogModel & { releaseStatus?: unknown }).releaseStatus === 'deprecated'
}

/**
 * Порядок перебора для «Авто» — скучный и проверяемый: модель по умолчанию из
 * каталога, затем остальные в порядке каталога, уходящие (deprecated) — в самом
 * конце. Имена, адреса и выдуманные «уровни качества» не участвуют.
 *
 * ⚠️ У сервера команды умолчаний нет, а список начинается с уходящих моделей
 * (nano-banana, seedance-2): без этого «Авто» там всегда брало бы их.
 */
function autoCandidates(input: SmartModelSelectionInput): CatalogModel[] {
  const candidates = baseModels(input.models as CatalogModel[], input.kind)
  const preferredId = defaultForKind(input.defaults, input.kind)
  const preferred = candidates.filter((model) => model.id === preferredId)
  const rest = candidates.filter((model) => model.id !== preferredId)
  return [
    ...preferred,
    ...rest.filter((model) => !deprecated(model)),
    ...rest.filter(deprecated),
  ]
}

/**
 * Модель для запуска при данном выборе в списке и данном наборе референсов.
 *
 * Ручной выбор главнее: неподходящая модель даёт отказ словами, а не тихую
 * подмену. «Авто» берёт первую модель из своего порядка, которая принимает
 * весь набор.
 */
export function selectSmartModel(input: SmartModelSelectionInput): SmartModelSelectionResult {
  const refCounts = counts(input.refs ?? [])
  if (!isAutoModelId(input.modelId)) return manualSelection(input, refCounts)

  const models = input.models as CatalogModel[]
  const ordered = autoCandidates(input)
  let firstRefusal: { model: CatalogModel; error: string } | null = null
  for (const candidate of ordered) {
    const model = effectiveCandidate(models, input.kind, candidate.id, refCounts)
    const error = lifecycleError(model) ?? referenceError(model!, refCounts)
    if (!error && model) {
      return { model, baseModel: candidate, panelModel: model, error: null, mode: 'auto' }
    }
    firstRefusal ??= { model: model ?? candidate, error: error ?? emptyCatalogText(input.kind) }
  }
  if (!firstRefusal) {
    return { model: null, baseModel: null, panelModel: null, error: emptyCatalogText(input.kind), mode: 'auto' }
  }
  return {
    model: null,
    baseModel: null,
    // Параметры модели по умолчанию остаются на виду: человек меняет набор
    // референсов, а не настраивает запуск заново.
    panelModel: firstRefusal.model,
    // Модель одна — её причина и есть ответ. Перебирали несколько — называем
    // сам набор: имя последней из перебранных человеку ничего не скажет.
    error: ordered.length === 1 ? firstRefusal.error : autoRefusalText(input.kind, refCounts),
    mode: 'auto',
  }
}

export function isAutoModelId(modelId: string | null | undefined): boolean {
  return modelId == null || modelId === AUTO_MODEL_ID
}

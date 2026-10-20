import type { JobKind } from '../../types'
import { pluralWithCount } from '../../ui/plural'

// Слова подбора модели: что сказать человеку, когда набор референсов не
// проходит. Правила живут в smartModelSelection, формулировки — здесь: числа
// склоняются через ui/plural, а типы названы так же, как на чипах дока.

export type MediaRefKind = 'image' | 'video' | 'audio'
export type RefCounts = Record<MediaRefKind | 'text', number>

const KIND_LABEL: Partial<Record<JobKind, string>> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  text: "Text",
}

// Именительный при числе: «1 картинка, 2 картинки, 5 картинок».
const REF_NOUN: Record<MediaRefKind, [string, string, string]> = {
  image: ["image", "images", "images"],
  video: ["video", "video", "video"],
  audio: ["audio", "audio", "audio"],
}

// Родительный после «не больше» и «не меньше»: «1 картинки, 2 картинок».
const REF_NOUN_GENITIVE: Record<MediaRefKind, [string, string, string]> = {
  image: ["image", "images", "images"],
  video: ["video", "video", "video"],
  audio: ["audio", "audio", "audio"],
}

// Что именно не принимает модель: «не принимает картинки как референс».
const REF_PLURAL: Record<MediaRefKind, string> = {
  image: "images",
  video: "video",
  audio: "audio",
}

const TOTAL_GENITIVE: [string, string, string] = ["reference", "references", "references"]

export function kindLabel(kind: JobKind): string {
  return KIND_LABEL[kind] ?? kind
}

/** Состав набора словами: «2 картинки, 1 видео и 1 аудио»; пусто — референсов нет. */
export function refSetSummary(counts: RefCounts): string {
  const parts = (['image', 'video', 'audio'] as const)
    .filter((kind) => counts[kind] > 0)
    .map((kind) => pluralWithCount(counts[kind], REF_NOUN[kind]))
  if (parts.length < 2) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

export function wrongKindText(name: string, kind: JobKind): string {
  return `Model “${name}” is not suitable for type “${kindLabel(kind)}”.`
}

export function notAcceptedText(name: string, kind: MediaRefKind): string {
  return `Model “${name}” does not accept ${REF_PLURAL[kind]} as a reference.`
}

export function tooFewText(name: string, kind: MediaRefKind, min: number, selected: number): string {
  if (min === 1 && selected === 0) return `Model “${name}” needs a reference: ${REF_NOUN[kind][0]}.`
  return `Model “${name}” needs at least ${pluralWithCount(min, REF_NOUN_GENITIVE[kind])} (selected: ${selected}).`
}

export function tooManyText(name: string, kind: MediaRefKind, max: number, selected: number): string {
  return `Model “${name}” accepts no more than ${pluralWithCount(max, REF_NOUN_GENITIVE[kind])} (selected: ${selected}).`
}

export function tooManyTotalText(name: string, max: number, selected: number): string {
  return `Model “${name}” accepts no more than ${pluralWithCount(max, TOTAL_GENITIVE)} per run (selected: ${selected}).`
}

export function singleMediaKindText(name: string): string {
  return `Model “${name}” accepts only one type of reference per run.`
}

export function audioNeedsVisualText(name: string): string {
  return `Model “${name}” needs an image or video together with audio.`
}

export function emptyCatalogText(kind: JobKind): string {
  return `No available model for type “${kindLabel(kind)}” is in the catalog.`
}

/**
 * Отказ «Авто»: называем СИТУАЦИЮ — что выбрано, — а не последнюю из
 * перебранных моделей: её человек не выбирал и по её имени ничего не поймёт.
 */
export function autoRefusalText(kind: JobKind, counts: RefCounts): string {
  const summary = refSetSummary(counts)
  if (!summary) {
    return `No model for type “${kindLabel(kind)}” runs without references. Add a reference or choose a model manually.`
  }
  return `No model for type “${kindLabel(kind)}” supports this set: ${summary}. Remove some references or choose a model manually.`
}

/**
 * Подпись пункта «Авто» в списке моделей — одна на компьютер и планшет.
 *
 * Не выбран — просто «Авто»: называть рядом модель значило бы обещать то, чего
 * при ручном выборе не случится. Выбран — «Авто · <базовое имя>»: хвост
 * варианта («— по референсам») и цена сюда не идут — цена стоит на кнопке, а
 * длинная подпись выталкивает из ряда параметры (ряд настроек — в одну строку).
 */
export function autoOptionLabel(input: {
  selected: boolean
  /** Имя базовой модели, которую «Авто» берёт сейчас; null — подобрать не из чего. */
  modelName: string | null
  /** Каталог ещё не загружен: говорить «нет модели» рано. */
  catalogReady?: boolean
}): string {
  if (!input.selected || input.catalogReady === false) return "Auto"
  return input.modelName ? `Auto · ${input.modelName}` : "Auto · no model"
}

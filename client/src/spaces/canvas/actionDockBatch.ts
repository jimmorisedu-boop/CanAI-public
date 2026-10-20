import type { SelectionRef } from './konva/selection'

/** How a multi-image selection is admitted to a generation. */
export type ActionBatchMode = 'each' | 'together'

export interface ActionBatchGroup {
  /** The image that owns this group in `each` mode. */
  imageRef?: SelectionRef
  /** Frozen refs for this request. Text refs are intentionally shared. */
  refs: SelectionRef[]
}

export interface ActionBatchPlan {
  mode: ActionBatchMode
  groups: ActionBatchGroup[]
  imageCount: number
  jobs: number
  error: string | null
}

/** Numeric media tags are meaningful only against the complete ref list. */
// Keep punctuation attached to a tag valid (`@1,@2` is still two slots).
// Do not require leading whitespace: prompts commonly use a comma, slash, or
// closing parenthesis immediately before the tag.
const NUMERIC_REF_TAG = /@(\d+)\b/gu

/**
 * In `each` mode every request owns exactly one image. A prompt that names two
 * source slots would therefore mean different things for every request. Keep
 * the guard pure so the paid-launch path can reject it before any async work.
 */
export function actionBatchPromptAmbiguity(
  prompt: string,
  imageCount: number,
): string | null {
  if (imageCount < 2) return null
  const tags = new Set<number>()
  for (const match of prompt.matchAll(NUMERIC_REF_TAG)) {
    const number = Number(match[1])
    if (Number.isInteger(number) && number > 0) tags.add(number)
  }
  if (tags.size === 0) return null
  if (tags.size > 1 || [...tags].some((number) => number !== 1)) {
    return "In Edit Each mode, specify one source (@1) rather than multiple references (@1, @2)."
  }
  return null
}

export interface ActionBatchInput {
  kind: 'image' | 'video' | 'audio'
  mode: ActionBatchMode
  refs: SelectionRef[]
  prompt: string
  count: number
}

/**
 * Один логический источник на адрес: две карточки с одной и той же картинкой в
 * общем запросе считаются и уходят как один референс.
 */
export function logicalBatchRefs(refs: readonly SelectionRef[]): SelectionRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    if (ref.kind === 'text') return true
    const key = `${ref.kind}:${ref.src ?? `shape:${ref.shapeId}`}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Медиа-референс без адреса файла отправить нечем — говорим об этом до запуска. */
export function missingBatchSource(refs: readonly SelectionRef[]): string | null {
  return refs.some((ref) => ref.kind !== 'text' && !ref.src)
    ? "Failed to prepare one of the media references. Select it again."
    : null
}

/** «Изменить каждое» делит набор, только когда картинок хотя бы две. */
function splitsPerImage(
  kind: ActionBatchInput['kind'],
  mode: ActionBatchMode,
  imageCount: number,
): boolean {
  return kind === 'image' && mode === 'each' && imageCount >= 2
}

function eachGroupRefs(imageRef: SelectionRef, refs: readonly SelectionRef[]): SelectionRef[] {
  return [imageRef, ...refs.filter((ref) => ref.kind === 'text').map((ref) => ({ ...ref }))]
}

/**
 * Референсы ПЕРВОГО запроса. По ним док показывает модель и её параметры ещё
 * до того, как набран промпт: в «Изменить каждое» запрос несёт одну картинку,
 * и модель под него может быть не та, что под весь набор разом.
 */
export function leadBatchRefs(
  kind: ActionBatchInput['kind'],
  mode: ActionBatchMode,
  refs: readonly SelectionRef[],
): SelectionRef[] {
  const images = refs.filter((ref) => ref.kind === 'image')
  if (!splitsPerImage(kind, mode, images.length)) return refs.map((ref) => ({ ...ref }))
  return eachGroupRefs(images[0], refs)
}

/**
 * Plan the admission of a selected set without touching the board or network.
 * Keeping this pure makes the important "nothing is silently dropped" rule
 * testable before a placeholder or paid request exists.
 *
 * Здесь только СТРУКТУРА набора: на сколько запросов он делится и можно ли
 * делить. Берёт ли модель такой набор, решает подбор модели — по тому, что
 * каждый запрос реально отправит (см. planActionDockBatch).
 */
export function planActionBatch(input: ActionBatchInput): ActionBatchPlan {
  const refs = input.refs.map((ref) => ({ ...ref }))
  const images = refs.filter((ref) => ref.kind === 'image')
  const imageCount = images.length
  const count = Math.max(1, Math.min(4, Math.round(input.count) || 1))
  const refused = (error: string): ActionBatchPlan => (
    { mode: input.mode, groups: [], imageCount, jobs: 0, error }
  )

  // Video and audio requests have no per-image variant semantics. Preserve the
  // existing single combined request even when several images are selected.
  if (input.kind !== 'image') {
    return { mode: input.mode, groups: [{ refs }], imageCount, jobs: 1, error: null }
  }

  const ambiguity = input.mode === 'each'
    ? actionBatchPromptAmbiguity(input.prompt, imageCount)
    : null
  if (ambiguity) return refused(ambiguity)

  if (!splitsPerImage(input.kind, input.mode, imageCount)) {
    return { mode: input.mode, groups: [{ refs }], imageCount, jobs: count, error: null }
  }

  // "Each" is meaningful only for image inputs. If it is selected while the
  // selection also contains a video/audio ref, rejecting is safer than dropping
  // that ref and charging for a different request than the user saw.
  // ⚠️ Только когда набор действительно делится. С одной картинкой запрос один
  // и терять нечего, а переключателя режима в этот момент на экране нет:
  // «картинка + ролик» упиралась в отказ, из которого не было выхода.
  if (refs.some((ref) => ref.kind !== 'image' && ref.kind !== 'text')) {
    return refused("\"Edit Each\" only works with images. Remove video or audio from references.")
  }

  const groups = images.map((imageRef) => ({ imageRef, refs: eachGroupRefs(imageRef, refs) }))
  return { mode: input.mode, groups, imageCount, jobs: groups.length * count, error: null }
}

export function actionBatchIsSeparate(plan: ActionBatchPlan): boolean {
  return plan.mode === 'each' && plan.groups.length > 1
}

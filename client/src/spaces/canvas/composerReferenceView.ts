import type { SelectionRef } from './konva/selection'
import { mediaReferences, syncActiveReferences } from './referenceComposer'

export interface ReplacementSessionView {
  targetShapeId: string
  baseRefs: SelectionRef[]
}

export interface ComposerReferenceView {
  // новый хронологический порядок id — вызывающий сохраняет его до следующего раза
  order: string[]
  // полный активный набор (выделение канваса + ручные чипы)
  refs: SelectionRef[]
  // что показываем и отправляем прямо сейчас
  composerRefs: SelectionRef[]
  // стабильный ключ состава: сами массивы создаются заново каждый рендер
  composerRefsKey: string
  // только медиа — их и нумеруют ссылки @1, @2…
  mediaRefs: SelectionRef[]
  mediaIdsKey: string
  textRefs: SelectionRef[]
  replacementTarget: SelectionRef | null
  // номер заменяемого медиа-референса; null — заменяют текстовый
  replacementMediaNumber: number | null
}

// Что промпт-бар показывает чипами и отправляет на сервер. Вынесено ЧИСТОЙ
// функцией: здесь легко сломать что-то незаметно — порядок @-ссылок обязан
// совпадать с тем, как сервер разложит image_urls, а во время точечной замены
// чипы не должны шевелиться. Такое проверяется тестом, а не глазами.
export function composerReferenceView(input: {
  chatOpen: boolean
  selRefs: SelectionRef[]
  manualRefs: SelectionRef[]
  previousOrder: string[]
  replacement: ReplacementSessionView | null
  /** Keep distinct selected shapes even when they point at the same media URL. */
  preserveContentDuplicates?: boolean
}): ComposerReferenceView {
  const {
    chatOpen,
    selRefs,
    manualRefs,
    previousOrder,
    replacement,
    preserveContentDuplicates = false,
  } = input

  const synced = syncActiveReferences(previousOrder, [selRefs, manualRefs], {
    preserveContentDuplicates,
  })
  const refs = synced.refs
  // В окне помощника выделение канваса не участвует: там набор собирают
  // руками, чипами и перетаскиванием на бар.
  const live = chatOpen ? manualRefs : refs
  // Пока выбирается замена, чипы остаются неподвижными: новое выделение
  // канваса — кандидат для ОДНОГО слота, а не временно новый набор.
  const composerRefs = !chatOpen && replacement ? replacement.baseRefs : live

  const mediaRefs = mediaReferences(composerRefs)
  const replacementTarget =
    replacement?.baseRefs.find((ref) => ref.shapeId === replacement.targetShapeId) ?? null
  const replacementMediaNumber =
    replacementTarget === null || replacementTarget.kind === 'text'
      ? null
      : mediaRefs.findIndex((ref) => ref.shapeId === replacementTarget.shapeId) + 1

  return {
    order: synced.order,
    refs,
    composerRefs,
    composerRefsKey: composerRefs
      .map((ref) => `${ref.shapeId}:${ref.kind}:${ref.src ?? ''}:${ref.text ?? ''}`)
      .join('|'),
    mediaRefs,
    mediaIdsKey: mediaRefs.map((ref) => ref.shapeId).join('\u0000'),
    textRefs: composerRefs.filter((ref) => ref.kind === 'text'),
    replacementTarget,
    replacementMediaNumber,
  }
}

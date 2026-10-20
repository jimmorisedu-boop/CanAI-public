import type { SelectionRef } from './konva/selection'

export interface ReferenceMention {
  query: string
  start: number
}

function contentKey(ref: SelectionRef): string {
  if (ref.src) return `src:${ref.src}`
  if (ref.text) return `text:${ref.text.replace(/\s+/g, ' ').trim()}`
  return `shape:${ref.shapeId}`
}

export function appendUniqueReferences(
  current: SelectionRef[],
  incoming: SelectionRef[],
  options: { dedupeContent?: boolean } = {},
): SelectionRef[] {
  const dedupeContent = options.dedupeContent ?? true
  const next = current.map((ref) => ({ ...ref }))
  const ids = new Set(next.map((ref) => ref.shapeId))
  const contents = new Set(next.map(contentKey))

  for (const ref of incoming) {
    const key = contentKey(ref)
    if (ids.has(ref.shapeId) || (dedupeContent && contents.has(key))) continue
    next.push({ ...ref })
    ids.add(ref.shapeId)
    if (dedupeContent) contents.add(key)
  }

  return next
}

export function syncActiveReferences(
  previousOrder: string[],
  sources: SelectionRef[][],
  options: { preserveContentDuplicates?: boolean } = {},
): { order: string[]; refs: SelectionRef[] } {
  const preserveContentDuplicates = options.preserveContentDuplicates ?? false
  const sourceRefs = sources.flat()
  let active: SelectionRef[] = []
  for (const source of sources) {
    active = appendUniqueReferences(active, source, {
      dedupeContent: !preserveContentDuplicates,
    })
  }

  const byId = new Map(active.map((ref) => [ref.shapeId, ref]))
  const sourceById = new Map(sourceRefs.map((ref) => [ref.shapeId, ref]))
  const activeByContent = preserveContentDuplicates
    ? null
    : new Map(active.map((ref) => [contentKey(ref), ref]))
  const order: string[] = []
  for (const id of previousOrder) {
    const exact = byId.get(id)
    const previous = sourceById.get(id)
    const replacement = exact
      ?? (previous && activeByContent
        ? activeByContent.get(contentKey(previous))
        : undefined)
    if (replacement && !order.includes(replacement.shapeId)) {
      order.push(replacement.shapeId)
    }
  }
  const ordered = new Set(order)
  for (const ref of active) {
    if (ordered.has(ref.shapeId)) continue
    order.push(ref.shapeId)
    ordered.add(ref.shapeId)
  }

  return {
    order,
    refs: order
      .map((id) => byId.get(id))
      .filter((ref): ref is SelectionRef => Boolean(ref))
      .map((ref) => ({ ...ref })),
  }
}

export function mediaReferences(refs: SelectionRef[]): SelectionRef[] {
  return refs.filter((ref) => ref.kind !== 'text')
}

export type ReplaceComposerReferenceResult =
  | { status: 'replaced'; refs: SelectionRef[] }
  | { status: 'unchanged'; refs: SelectionRef[] }
  | { status: 'missing'; refs: SelectionRef[] }
  | { status: 'duplicate'; refs: SelectionRef[]; duplicateIndex: number }
  | { status: 'kind-mismatch'; refs: SelectionRef[] }

// Точечная замена сохраняет позицию слота: @1 остаётся @1, меняется только
// объект, на который он указывает. Текстовые и медиа-референсы не смешиваем,
// иначе вставка медиа вместо текста сдвинула бы все последующие @n.
export function replaceComposerReference(
  refs: SelectionRef[],
  targetShapeId: string,
  replacement: SelectionRef,
): ReplaceComposerReferenceResult {
  const targetIndex = refs.findIndex((ref) => ref.shapeId === targetShapeId)
  const current = refs.map((ref) => ({ ...ref }))
  if (targetIndex < 0) return { status: 'missing', refs: current }

  const target = refs[targetIndex]
  if ((target.kind === 'text') !== (replacement.kind === 'text')) {
    return { status: 'kind-mismatch', refs: current }
  }
  if (
    target.shapeId === replacement.shapeId
    || contentKey(target) === contentKey(replacement)
  ) {
    return { status: 'unchanged', refs: current }
  }

  const replacementKey = contentKey(replacement)
  const duplicateIndex = refs.findIndex((ref, index) => (
    index !== targetIndex
    && (ref.shapeId === replacement.shapeId || contentKey(ref) === replacementKey)
  ))
  if (duplicateIndex >= 0) {
    return { status: 'duplicate', refs: current, duplicateIndex }
  }

  current[targetIndex] = { ...replacement }
  return { status: 'replaced', refs: current }
}

function cleanPromptWhitespace(value: string): string {
  return value
    .replace(/,\s+(и|and)(?=\s|[,.!?]|$)/gi, ' $1')
    .replace(/,\s*,/g, ',')
    .replace(/\b(and|и)\s+(and|и)\b/gi, '$1')
    .replace(/\s+([,.:!?])/g, '$1')
    .replace(/  +/g, ' ')
    .trim()
}

function updateReferenceTagsOnRemove(text: string, removedNumber: number): string {
  const updated = text.replace(
    /@([a-zA-Zа-яА-Я#_]+)?(\d+)/gi,
    (fullMatch, prefix: string | undefined, rawNumber: string) => {
      const number = Number.parseInt(rawNumber, 10)
      if (number === removedNumber) return ''
      if (number > removedNumber) return `@${prefix ?? ''}${number - 1}`
      return fullMatch
    },
  )
  return cleanPromptWhitespace(updated)
}

export function removeComposerReference(
  refs: SelectionRef[],
  text: string,
  shapeId: string,
): { refs: SelectionRef[]; text: string } {
  const media = mediaReferences(refs)
  const removedNumber = media.findIndex((ref) => ref.shapeId === shapeId) + 1
  return {
    refs: refs.filter((ref) => ref.shapeId !== shapeId).map((ref) => ({ ...ref })),
    text:
      removedNumber > 0
        ? updateReferenceTagsOnRemove(text, removedNumber)
        : text,
  }
}

export function detectReferenceMention(
  text: string,
  caret: number,
): ReferenceMention | null {
  const match = /@(\S*)$/.exec(text.slice(0, caret))
  if (!match) return null
  return { query: match[1], start: caret - match[0].length }
}

export function referenceMentionCandidates(
  refs: SelectionRef[],
  query: string,
): SelectionRef[] {
  const normalized = query.toLowerCase()
  return mediaReferences(refs).filter((ref) =>
    ref.label.toLowerCase().includes(normalized),
  )
}

export function clampMentionIndex(
  currentIndex: number,
  candidateCount: number,
): number {
  return Math.max(0, Math.min(currentIndex, Math.max(candidateCount - 1, 0)))
}

export function insertReferenceTag(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  number: number,
  mentionStart?: number,
): { text: string; caret: number } {
  const start = mentionStart ?? selectionStart
  const before = text.slice(0, start)
  const after = text.slice(selectionEnd)
  const prefix = before && !/\s$/.test(before) ? `${before} ` : before
  const suffix = after
    ? (/^\s/.test(after) ? after : ` ${after}`)
    : ' '
  const tag = `@${number}`
  return {
    text: `${prefix}${tag}${suffix}`,
    caret: prefix.length + tag.length + 1,
  }
}

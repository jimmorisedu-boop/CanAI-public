// Кто из выбранных объектов — исходник, а кто кандидаты на сравнение.
// Спрашивать пользователя не нужно: каждая генерация помнит своих референсов в
// `CanvasItem.referenceIds` (пишется при запуске в PromptBar и переносится в
// готовый объект в canvasStore.resolveJob), а импортированный файл отличается
// от генерации отсутствием `prompt`.

export type LineageItem = {
  id: string
  kind: string
  prompt?: string
  referenceIds?: string[]
}

export type BaselineReason =
  | 'lineage' // один из выбранных записан в референсах у остальных
  | 'import' // единственный не-генерация среди выбранных
  | 'siblings' // общий родитель нашёлся вне выбора и подтянут
  | 'order' // ничего не известно — первый по порядку
  | 'empty'

export type BaselinePick = {
  baselineId: string | null
  candidateIds: string[]
  reason: BaselineReason
  // true — исходник не выбирали, мы добавили его сами по родословной
  pulledIn: boolean
}

export function isComparable(item: { kind: string }): boolean {
  return item.kind === 'image' || item.kind === 'video'
}

// Все объекты, сделанные из этого исходника. Даёт кнопку «Взять все его
// генерации (N)» — иначе кандидатов пришлось бы искать глазами по холсту.
export function descendantsOf(baselineId: string, all: LineageItem[]): string[] {
  return all
    .filter((item) => isComparable(item) && item.id !== baselineId)
    .filter((item) => (item.referenceIds ?? []).includes(baselineId))
    .map((item) => item.id)
}

export function pickBaseline(
  selected: LineageItem[],
  // поиск объекта вне выбора (по холсту и архиву) — для случая «сёстры»
  lookup: (id: string) => LineageItem | undefined = () => undefined,
): BaselinePick {
  const items = selected.filter(isComparable)
  if (items.length === 0) {
    return { baselineId: null, candidateIds: [], reason: 'empty', pulledIn: false }
  }

  // 1. Прямая родословная: чей id стоит в референсах у других выбранных
  const referenced = new Set<string>()
  for (const item of items) {
    for (const refId of item.referenceIds ?? []) referenced.add(refId)
  }
  const parentInside = items.find((item) => referenced.has(item.id))
  if (parentInside) return split(parentInside.id, items, 'lineage', false)

  // 2. Смешение импорта и генераций: импорт (без промпта) — исходник.
  //    Если импортов несколько, это правило молчит: угадывать нельзя.
  const imports = items.filter((item) => !item.prompt)
  if (imports.length === 1 && items.length > 1) {
    return split(imports[0].id, items, 'import', false)
  }

  // 3. Сёстры: общий родитель есть, но его не выбрали — подтянем сами
  const commonParent = findCommonParent(items, lookup)
  if (commonParent) {
    return {
      baselineId: commonParent,
      candidateIds: items.map((item) => item.id),
      reason: 'siblings',
      pulledIn: true,
    }
  }

  // 4. Ничего не известно — первый по порядку выбора
  return split(items[0].id, items, 'order', false)
}

function split(
  baselineId: string,
  items: LineageItem[],
  reason: BaselineReason,
  pulledIn: boolean,
): BaselinePick {
  return {
    baselineId,
    candidateIds: items.filter((item) => item.id !== baselineId).map((item) => item.id),
    reason,
    pulledIn,
  }
}

// Общий родитель — тот, что стоит в референсах У ВСЕХ выбранных и при этом
// реально существует (мог быть удалён; тогда правило не срабатывает).
function findCommonParent(
  items: LineageItem[],
  lookup: (id: string) => LineageItem | undefined,
): string | null {
  const first = items[0]?.referenceIds ?? []
  if (first.length === 0) return null
  for (const candidateId of first) {
    const inAll = items.every((item) => (item.referenceIds ?? []).includes(candidateId))
    if (!inAll) continue
    const parent = lookup(candidateId)
    if (parent && isComparable(parent)) return candidateId
  }
  return null
}

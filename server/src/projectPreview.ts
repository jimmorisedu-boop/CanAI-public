export interface ProjectPreview {
  src: string
  kind: 'image' | 'video'
}
const LOCAL_MEDIA = /^\/media\/[A-Za-z0-9._-]+(?:\?[^#\s]*)?$/

/** Сколько объектов на доске. Нужно списку корзины: по строке «Без названия,
 *  удалено 6 августа» невозможно понять, лежит там 65 картинок или ничего, —
 *  и решение «удалять или нет» приходилось принимать вслепую, восстанавливая
 *  доску ради одного взгляда (вопрос пользователя 21.08.2026). */
export function snapshotItemCount(snapshot: unknown): number {
  const items = (snapshot as { items?: unknown } | null)?.items
  return Array.isArray(items) ? items.length : 0
}

export function projectPreviewFromSnapshot(snapshot: unknown): ProjectPreview | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const items = (snapshot as { items?: unknown }).items
  if (!Array.isArray(items)) return null
  for (const value of items) {
    if (!value || typeof value !== 'object') continue
    const item = value as { kind?: unknown; src?: unknown }
    if ((item.kind !== 'image' && item.kind !== 'video') || typeof item.src !== 'string') continue
    if (!LOCAL_MEDIA.test(item.src)) continue
    return { src: item.src, kind: item.kind }
  }
  return null
}

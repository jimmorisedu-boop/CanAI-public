// Сторож на молчаливую потерю материала.
//
// 20.08.2026 два оплаченных результата (картинка и видео) появились на холсте,
// но в сохранённой доске их не оказалось — ни в project.json, ни в одной
// резервной копии. Механизм поймать не удалось: и обычное сохранение, и уход с
// доски во время генерации записываются верно. Значит, ловить надо в момент
// записи: если доска УХУДШИЛАСЬ (объектов стало меньше, а вместе с ними ушли
// ссылки на медиа), это надо записать в лог с именами файлов — тогда при
// следующей жалобе будет видно, когда именно и что именно пропало.
//
// Уменьшение само по себе НЕ ошибка: человек удаляет объекты каждый день.
// Поэтому это запись-хлебная крошка, а не отказ в сохранении.

const MEDIA_LINK = /\/media\/([A-Za-z0-9._-]+)/g
/** Сколько имён файлов писать в строку лога: полный список бесполезен. */
const MAX_NAMES = 6

export interface SnapshotShrink {
  /** Объектов было (холст + архив). */
  before: number
  /** Объектов стало. */
  after: number
  /** Файлы, ссылок на которые в доске больше нет. */
  lostFiles: string[]
}

function countObjects(doc: unknown): number {
  if (!doc || typeof doc !== 'object') return 0
  const raw = doc as { items?: unknown; archive?: unknown }
  const items = Array.isArray(raw.items) ? raw.items.length : 0
  // Архив считаем вместе с холстом: отправка объекта в архив уменьшает items,
  // но материал при этом никуда не делся, и поднимать из-за неё тревогу нельзя.
  const archive = Array.isArray(raw.archive) ? raw.archive.length : 0
  return items + archive
}

function mediaFiles(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(MEDIA_LINK)) found.add(match[1]!)
  return found
}

/** Что потеряла доска между прошлой и новой записью. null — терять нечего. */
export function describeSnapshotShrink(previousText: string | null, next: unknown): SnapshotShrink | null {
  if (!previousText) return null
  let previous: unknown
  try { previous = JSON.parse(previousText) } catch { return null }

  const before = countObjects(previous)
  const after = countObjects(next)
  const wasFiles = mediaFiles(previousText)
  const nowFiles = mediaFiles(JSON.stringify(next ?? null))
  const lostFiles = [...wasFiles].filter((name) => !nowFiles.has(name))

  // Тревожит только потеря: меньше объектов ИЛИ пропавшие ссылки на файлы.
  if (after >= before && lostFiles.length === 0) return null
  return { before, after, lostFiles }
}

export function snapshotShrinkMessage(projectId: string, shrink: SnapshotShrink): string {
  const names = shrink.lostFiles.slice(0, MAX_NAMES).join(', ')
  const tail = shrink.lostFiles.length > MAX_NAMES ? ` and ${shrink.lostFiles.length - MAX_NAMES}` : ''
  const files = shrink.lostFiles.length > 0 ? `; no more links to: ${names}${tail}` : ''
  return `board ${projectId}: objects ${shrink.before} → ${shrink.after}${files}`
}

import { archiveTitle } from '../konva/archive'
import type { ArchivedItem } from '../konva/types'

// Упорядочивание и поиск в архиве — чистые функции (тесты рядом).
// Пользователь выбрал «сортировка + поиск» вместо ручных папок: ничего не надо
// раскладывать руками, нужное находится за секунду.

export type ArchiveSort = 'new' | 'old' | 'name' | 'kind' | 'size'

export const ARCHIVE_SORTS: Array<{ value: ArchiveSort; label: string }> = [
  { value: 'new', label: 'Newest first' },
  { value: 'old', label: 'Oldest first' },
  { value: 'name', label: 'By name' },
  { value: 'kind', label: 'By type' },
  { value: 'size', label: 'By size' },
]

const KIND_ORDER: Record<ArchivedItem['kind'], number> = { image: 0, video: 1, audio: 2, text: 3, link: 4 }

// Поиск идёт по имени, тексту, промпту и модели: так находится и «тот кадр
// с котом», и «всё, что делал Seedance».
export function archiveSearchText(entry: ArchivedItem): string {
  return [entry.name, entry.text, entry.prompt, entry.modelId].filter(Boolean).join(' ').toLowerCase()
}

export function filterArchive(entries: ArchivedItem[], query: string): ArchivedItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  const words = q.split(/\s+/)
  return entries.filter((entry) => {
    const haystack = archiveSearchText(entry)
    return words.every((word) => haystack.includes(word))
  })
}

// sizes — байты по src (грузятся лениво, см. archiveSizes). Неизвестный размер
// уходит в конец: иначе непрогруженные записи всплыли бы наверх нулями.
export function sortArchive(
  entries: ArchivedItem[],
  mode: ArchiveSort,
  sizes?: Map<string, number>,
): ArchivedItem[] {
  const copy = [...entries]
  const byName = (a: ArchivedItem, b: ArchivedItem) =>
    archiveTitle(a).localeCompare(archiveTitle(b), 'en-US', { numeric: true, sensitivity: 'base' })
  const sizeOf = (entry: ArchivedItem): number => {
    if (entry.kind === 'text') return entry.text?.length ?? 0
    const known = entry.src ? sizes?.get(entry.src) : undefined
    return known ?? -1
  }

  switch (mode) {
    case 'old':
      return copy.sort((a, b) => a.archivedAt - b.archivedAt)
    case 'name':
      return copy.sort(byName)
    case 'kind':
      return copy.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byName(a, b))
    case 'size':
      return copy.sort((a, b) => {
        const sa = sizeOf(a)
        const sb = sizeOf(b)
        if (sa < 0 && sb < 0) return b.archivedAt - a.archivedAt
        if (sa < 0) return 1
        if (sb < 0) return -1
        return sb - sa
      })
    case 'new':
    default:
      return copy.sort((a, b) => b.archivedAt - a.archivedAt)
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

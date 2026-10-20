import { toCanvasItem } from '../konva/archive'
import type { ArchivedItem } from '../konva/types'
import { downloadItemsAsZip, type ZipResult } from '../konva/zipExport'

// Скачивание из архива. Пачка — тем же zip'ом, что и выделение на холсте
// (общий модуль zipExport), одиночная запись — просто файлом, без архива.

export async function downloadArchiveZip(entries: ArchivedItem[]): Promise<ZipResult> {
  // Архив доски и выделение с холста — разные пачки, и в имени файла это
  // видно: внутри у них разная раскладка.
  return downloadItemsAsZip(entries.map(toCanvasItem), 'archive')
}

export function downloadArchiveEntry(entry: ArchivedItem): void {
  const a = document.createElement('a')
  if (entry.kind === 'text') {
    const blob = new Blob([entry.text ?? ''], { type: 'text/plain;charset=utf-8' })
    a.href = URL.createObjectURL(blob)
    a.download = `${(entry.name || (entry.text ?? 'text').slice(0, 40)).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'text'}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(a.href)
    return
  }
  if (!entry.src) return
  a.href = entry.src
  a.download = entry.name || 'canai'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

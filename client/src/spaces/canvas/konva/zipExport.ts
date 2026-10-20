import JSZip from 'jszip'
import type { CanvasItem } from './types'
import { reportOnboardingSuccess } from '../onboardingEvents'
import { exportEntryPath } from '../exportNaming'
import { api } from '../../../api'
import { canvasItemExtension, canvasItemFileName } from './mediaFileName'
import type { ProjectRef } from '../../../types'

async function itemBlob(item: CanvasItem): Promise<Blob | null> {
  if (item.kind === 'text') {
    return item.text?.trim() ? new Blob([item.text], { type: 'text/plain;charset=utf-8' }) : null
  }
  if (!item.src) return null
  try {
    const res = await fetch(item.src)
    if (!res.ok) return null
    return await res.blob()
  } catch {
    return null
  }
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  reportOnboardingSuccess('export')
  a.remove()
  URL.revokeObjectURL(url)
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export interface ZipResult {
  ok: number
  failed: number
}

export interface DownloadResult extends ZipResult {
  delivery?: 'shared' | 'downloaded' | 'zip'
  cancelled?: boolean
}

export interface FileShareTarget {
  canShare?(data: ShareData): boolean
  share(data: ShareData): Promise<void>
}

function browserFileShare(): FileShareTarget | null {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return null
  return navigator
}

function cancelledShare(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}


/**
 * Сообщает серверу, что эти кадры вывезли наружу.
 *
 * ⚠️ Зачем: панель руководителя без такого сигнала считает АКТИВНОСТЬ — сколько
 * человек нагенерировал. Накрутить попытки просто, и команда начнёт крутить
 * барабан вместо работы; накрутить дошедшее до сдачи нельзя.
 *
 * ⚠️ Вызывается ПОСЛЕ сборки архива и ничего не ждёт: файлы у человека уже
 * есть, и сбой отметки не имеет права ни задержать скачивание, ни показать
 * ошибку. Метрика недосчитается — это несравнимо дешевле.
 */
function reportExported(items: CanvasItem[]): void {
  const jobIds = [...new Set(items.map((item) => item.sourceJobId).filter((id): id is string => Boolean(id)))]
  void api.reportGenerationOutcome(jobIds, 'exported')
}

/**
 * Планшетная доставка файлов.
 *
 * Один файл отдаём системному меню iPadOS: изображение там можно сохранить в
 * «Фото», а любой поддерживаемый тип — в «Файлы». Если Web Share с файлами не
 * поддерживается, скачиваем сам файл обычной ссылкой. ZIP нужен только пачке.
 */
export async function downloadItems(
  items: CanvasItem[],
  shareTarget: FileShareTarget | null = browserFileShare(),
): Promise<DownloadResult> {
  const exportable = items.filter((item) => item.kind !== 'link')
  if (exportable.length !== 1) {
    const result = await downloadItemsAsZip(exportable)
    return result.ok > 0 ? { ...result, delivery: 'zip' } : result
  }

  const item = exportable[0]
  const blob = await itemBlob(item)
  if (!blob) return { ok: 0, failed: 1 }
  const filename = canvasItemFileName(item, undefined, blob.type)

  if (shareTarget) {
    try {
      const file = new File([blob], filename, {
        type: blob.type || item.mime || 'application/octet-stream',
      })
      const data: ShareData = { files: [file], title: filename }
      if (!shareTarget.canShare || shareTarget.canShare(data)) {
        await shareTarget.share(data)
        reportOnboardingSuccess('export')
        reportExported([item])
        return { ok: 1, failed: 0, delivery: 'shared' }
      }
    } catch (error) {
      if (cancelledShare(error)) return { ok: 0, failed: 0, cancelled: true }
      // Safari может знать navigator.share, но отказать конкретному MIME или
      // потерять transient activation на долгой загрузке. Файл всё равно
      // должен сохраниться, поэтому ниже остаётся обычный download.
    }
  }

  triggerDownload(blob, filename)
  reportExported([item])
  return { ok: 1, failed: 0, delivery: 'downloaded' }
}

// Фича 1: выделенное — плоский архив, имена по названию объекта (с дедупом).
export async function downloadItemsAsZip(
  items: CanvasItem[],
  // Что это за пачка: «выделение» с холста или «архив» доски. Уточнение стоит
  // в имени файла, потому что внутри у них разная раскладка.
  part = 'selection',
): Promise<ZipResult> {
  const exportable = items.filter((item) => item.kind !== 'link')
  const blobs = await Promise.all(exportable.map(itemBlob))
  const zip = new JSZip()
  const usedNames = new Set<string>()
  let ok = 0
  let failed = 0

  exportable.forEach((item, i) => {
    const blob = blobs[i]
    if (!blob) {
      failed++
      return
    }
    const originalName = canvasItemFileName(item, `file-${i + 1}`, blob.type)
    const dot = originalName.lastIndexOf('.')
    const base = dot > 0 ? originalName.slice(0, dot) : originalName
    const suffix = dot > 0 ? originalName.slice(dot) : ''
    let name = originalName
    let n = 2
    while (usedNames.has(name)) {
      name = `${base} (${n})${suffix}`
      n++
    }
    usedNames.add(name)
    zip.file(name, blob)
    ok++
  })

  if (ok === 0) return { ok, failed }
  // ⚠️ Имя доски, а не имя программы — то же правило, что у экспорта по меткам
  // ниже. Починили его когда-то ТОЛЬКО там, и «CanAI-выделение-<дата>» осталось
  // жить на второй кнопке (жалоба 19.09.2026: «мы уже делали, почему опять»).
  triggerDownload(await zip.generateAsync({ type: 'blob' }), archiveName(openBoard, part))
  reportExported(exportable)
  return { ok, failed }
}

export interface MarkedZipResult extends ZipResult {
  groups: number
}

// Экспорт по меткам: раскладка по ПАПКАМ ТИПА (Картинки/Видео/Звук/Текст),
// имя файла — «<метка>-<номер>_<название доски>» (см. exportNaming.ts).
//
// Номер выдаёт СЕРВЕР и запоминает: иначе каждый экспорт начинал бы отсчёт с
// единицы, и в папке пользователя оказывались бы два «1-1_моя свалка.png».
/** Выдача номеров вынесена в зависимость: без неё экспорт не проверить в
 *  тесте, где нет ни окна, ни сервера. */
export type ExportNumberProvider = (
  projectId: string,
  groups: Array<{ mark: number; count: number }>,
) => Promise<{ board: string; starts: Record<string, number> }>

export type ExportNumberReserver = (
  project: ProjectRef,
  groups: Array<{ mark: number; count: number }>,
) => Promise<{ board: string; starts: Record<string, number> }>

export function reserveExportNumbersForProject(
  project: ProjectRef,
  groups: Array<{ mark: number; count: number }>,
  local: ExportNumberProvider = api.reserveExportNumbers,
  cloud: ExportNumberProvider = api.reserveExportNumbers,
): Promise<{ board: string; starts: Record<string, number> }> {
  return local(project.id, groups)
}

export async function downloadMarkedAsZip(
  items: CanvasItem[],
  project: ProjectRef | string,
  reserve: ExportNumberReserver = reserveExportNumbersForProject,
): Promise<MarkedZipResult> {
  const marked = items.filter((i): i is CanvasItem & { mark: number } => i.kind !== 'link' && i.mark != null)
  const blobs = await Promise.all(marked.map(itemBlob))

  const byMark = new Map<number, Array<{ item: CanvasItem; blob: Blob }>>()
  marked.forEach((item, i) => {
    const blob = blobs[i]
    if (!blob) return
    const group = byMark.get(item.mark)
    if (group) group.push({ item, blob })
    else byMark.set(item.mark, [{ item, blob }])
  })

  const groups = [...byMark.entries()].sort((a, b) => a[0] - b[0])
  if (groups.length === 0) return { ok: 0, failed: marked.length, groups: 0 }

  // Номера занимаем ОДНИМ запросом до сборки архива: если сервер недоступен,
  // честнее не собрать архив вовсе, чем выдать файлы с повторной нумерацией.
  const { board, starts } = await reserve(
    typeof project === 'string' ? { source: 'local', id: project } : project,
    groups.map(([mark, group]) => ({ mark, count: group.length })),
  )

  const zip = new JSZip()
  let ok = 0
  for (const [mark, group] of groups) {
    const start = starts[String(mark)] ?? 1
    group.forEach(({ item, blob }, i) => {
      zip.file(exportEntryPath({
        kind: item.kind,
        mark,
        number: start + i,
        board,
        extension: canvasItemExtension(item, blob.type),
      }), blob)
      ok++
    })
  }

  const failed = marked.length - ok
  if (ok === 0) return { ok, failed, groups: groups.length }
  // ⚠️ Имя доски, а не имя программы: в папке загрузок таких архивов
  // десятки, и «CanAI-экспорт» не отличает один от другого.
  triggerDownload(await zip.generateAsync({ type: 'blob' }), archiveName(board))
  reportExported(marked)
  return { ok, failed, groups: groups.length }
}

// Имя открытой доски для подписи архива.
//
// ⚠️ Ставит его `CanvasSpace` (на планшете — `TabletBoard`): он единственный
// знает, что открыто. Пропом сюда не дотянуться — скачивание зовут из панели
// над выделением, из контекстного меню и из архива, то есть из глубины Konva,
// куда доска не доходит. Тот же приём, что у `setBoardUploadTarget`.
//
// ⚠️ Пусто — архив назовётся «доска», но НЕ именем программы: человеку нужно
// знать, ОТКУДА архив, а как называется программа он и так знает.
let openBoard = ''

export function setExportBoardName(name: string): void {
  openBoard = name.trim()
}

/**
 * Имя архива — по доске.
 *
 * ⚠️ Раньше все архивы звались «CanAI-экспорт-<дата>»: в папке загрузок их
 * десятки, и по имени не отличить один от другого. Название программы человек
 * и так знает — ему нужно знать, ОТКУДА этот архив.
 *
 * Дату оставляем: с одной доски выгружают не по разу.
 */
export function archiveName(board: string, part?: string): string {
  const clean = board.replace(/[\/:*?"<>|]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return `${clean || 'board'} — ${part ? `${part} — ` : ''}${stamp()}.zip`
}

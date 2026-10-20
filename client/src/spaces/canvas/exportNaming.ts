import type { ItemKind } from './konva/types'

// Как называются файлы в архиве экспорта (решение пользователя 18.08.2026).
//
// Имя: «<метка>-<номер>_<название доски>.<расширение>» — 1-1_моя свалка.png,
// 1-2_моя свалка.png, 2-1_моя свалка.png. Номер НЕ начинается с единицы на
// каждом экспорте: его выдаёт сервер и запоминает (см. exportNumbers.ts на
// сервере), поэтому второй экспорт той же метки продолжает нумерацию, а двух
// одинаково названных файлов не появляется никогда.
//
// Раскладка по папкам — по ТИПУ материала, а не по метке: метка уже стоит в
// имени, и папка на каждую метку дробила бы архив на десятки почти пустых
// каталогов.

const FOLDERS: Record<ItemKind, string> = {
  image: "Images",
  video: "Video",
  audio: "Audio",
  text: "Text",
  // ссылка в экспорт не попадает (у неё нет своего файла), но тип обязан быть
  // назван — иначе новый вид объекта молча уехал бы в чужую папку
  link: "Links",
}

export function exportFolderFor(kind: ItemKind): string {
  return FOLDERS[kind] ?? "Other"
}

/** Имя доски в имени файла. Сервер отдаёт уже вычищенное, но клиент не должен
 *  зависеть от его аккуратности: своё имя файла — своя ответственность. */
export function safeExportBoardName(raw: string | null | undefined): string {
  const cleaned = (raw ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 60) || "board"
}

export function exportFileName(input: {
  mark: number
  number: number
  board: string
  extension: string
}): string {
  const board = safeExportBoardName(input.board)
  return `${input.mark}-${input.number}_${board}.${input.extension}`
}

/** Путь внутри архива целиком: папка типа + имя файла. */
export function exportEntryPath(input: {
  kind: ItemKind
  mark: number
  number: number
  board: string
  extension: string
}): string {
  return `${exportFolderFor(input.kind)}/${exportFileName(input)}`
}

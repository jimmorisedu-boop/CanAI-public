import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { MEDIA_TYPES } from './mediaTypes.js'

// Раскладка data/media ПО ДОСКАМ — чтобы материал доски можно было найти
// руками, а не глазами по свалке из тысячи имён (просьба пользователя
// 18.08.2026). Внутри доски — по типу содержимого:
//
//   media/
//     Моя свалка/картинки|видео|звук|прочее/
//     Трейлер/…
//     общее/…            ← нужен нескольким доскам или пока ничей
//
// ⚠️ ССЫЛКИ ПРИ ЭТОМ НЕ МЕНЯЮТСЯ. В досках, макросах, диалогах и публикациях
// лежит `/media/<имя файла>` без папки. Переписывать это во всех файлах
// пользователя — риск потерять материал ради вида на диске, а «при обновлении
// файлы не должны пропасть» — прямое требование. Поэтому имя файла остаётся
// единственным ключом, а ГДЕ он лежит, помнит индекс (см. ниже).
//
// ⚠️ Принадлежность доске НЕ известна в момент записи: файл сохраняется до
// того, как объект окажется на холсте, а генерация про доску вообще не знает.
// Поэтому пишем всегда в `общее/`, а раскладывает потом sortMediaByBoards — по
// РЕАЛЬНЫМ ссылкам в досках. Ссылка и есть правда о принадлежности; угадывать
// её при записи значило бы разложить неверно, а потом искать не там.

export const MEDIA_SHARED_FOLDER = 'general'

export const MEDIA_TYPE_FOLDERS = {
  image: 'images',
  video: 'video',
  audio: 'audio',
  other: 'other',
} as const

export type MediaTypeFolder = typeof MEDIA_TYPE_FOLDERS[keyof typeof MEDIA_TYPE_FOLDERS]

const FOLDER_BY_EXT = new Map<string, MediaTypeFolder>()
for (const type of MEDIA_TYPES) {
  const folder = type.mime.startsWith('image/')
    ? MEDIA_TYPE_FOLDERS.image
    : type.mime.startsWith('video/')
      ? MEDIA_TYPE_FOLDERS.video
      : type.mime.startsWith('audio/')
        ? MEDIA_TYPE_FOLDERS.audio
        : MEDIA_TYPE_FOLDERS.other
  FOLDER_BY_EXT.set(type.ext, folder)
  for (const alias of type.extAliases ?? []) FOLDER_BY_EXT.set(alias, folder)
}

/** Имя файла из ссылки: без папок и без ?v=<mtime> внешнего редактора. */
export function mediaFileName(src: string): string {
  return path.basename(src.split('?')[0])
}

/** Папка типа внутри папки доски. */
export function mediaTypeFolder(name: string): MediaTypeFolder {
  const ext = path.extname(mediaFileName(name)).replace('.', '').toLowerCase()
  return FOLDER_BY_EXT.get(ext) ?? MEDIA_TYPE_FOLDERS.other
}

/**
 * Имя папки доски. Берём ИМЯ доски, а не id: папку открывает человек, и
 * «Трейлер» ему говорит больше, чем «673d3c02-2adf-…».
 */
export function boardFolderName(board: { id: string; name?: string | null }): string {
  const cleaned = (board.name ?? '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return cleaned || `board ${board.id.slice(0, 6)}`
}

/**
 * Развести доски по папкам.
 *
 * Доски нередко называются одинаково («Без названия»), поэтому второй и
 * следующим дописываем короткий id: иначе их материал смешался бы в одной
 * папке — то есть «найти руками» перестало бы работать ровно там, где нужнее.
 */
export function boardFolderNames(
  boards: ReadonlyArray<{ id: string; name?: string | null }>,
): Map<string, string> {
  const taken = new Set<string>([MEDIA_SHARED_FOLDER.toLowerCase()])
  const out = new Map<string, string>()
  for (const board of boards) {
    let folder = boardFolderName(board)
    if (taken.has(folder.toLowerCase())) folder = `${folder} (${board.id.slice(0, 6)})`
    taken.add(folder.toLowerCase())
    out.set(board.id, folder)
  }
  return out
}

/** Куда файл кладут при записи: доска ещё не известна (см. шапку модуля). */
export function mediaPathIn(root: string, name: string): string {
  const file = mediaFileName(name)
  return path.join(root, MEDIA_SHARED_FOLDER, mediaTypeFolder(file), file)
}

export function mediaTargetPath(name: string): string {
  return mediaPathIn(config.mediaDir, name)
}

export async function mediaWritePathIn(root: string, name: string): Promise<string> {
  const target = mediaPathIn(root, name)
  await fs.mkdir(path.dirname(target), { recursive: true })
  return target
}

export async function mediaWritePath(name: string): Promise<string> {
  return mediaWritePathIn(config.mediaDir, name)
}

// ── где лежит файл ────────────────────────────────────────────────────────
//
// Папка доски из имени НЕ выводится, поэтому нужен индекс «имя → путь». Он
// строится обходом media и живёт в памяти; при промахе пересобирается — файл
// мог появиться или переехать в обход этого процесса.

const MAX_DEPTH = 3
const index = new Map<string, string>()
const indexedRoots = new Set<string>()

function scan(root: string, depth: number): void {
  let entries: fsSync.Dirent[]
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      // .link-preview-* — рабочие каталоги извлечения превью, не медиа
      if (depth < MAX_DEPTH && !entry.name.startsWith('.')) scan(full, depth + 1)
      continue
    }
    if (!entry.isFile() || entry.name.endsWith('.tmp')) continue
    // Первый найденный побеждает: дубликат имени в двух папках возможен только
    // как след неудавшегося переноса, и взять любой из них одинаково верно.
    if (!index.has(entry.name)) index.set(entry.name, full)
  }
}

function rebuildIndex(root: string): void {
  for (const [name, file] of [...index]) {
    if (file.startsWith(root)) index.delete(name)
  }
  scan(root, 0)
  indexedRoots.add(root)
}

/** Запомнить только что записанный файл — чтобы чтение не ждало пересборки. */
export function noteMediaFile(file: string): void {
  index.set(path.basename(file), file)
}

/** Забыть файл: удалён или переехал. */
export function forgetMediaFile(name: string): void {
  index.delete(path.basename(name))
}

/**
 * Где файл лежит на самом деле.
 *
 * Порядок важен: индекс → пересборка (файл мог появиться только что) → корень
 * media (там остаются файлы, записанные до раскладки, и те, чей перенос не
 * удался). Если нигде — отдаём путь по раскладке, чтобы ошибка «файл не
 * найден» показывала то место, где его и надо искать.
 */
export function resolveMediaIn(root: string, name: string): string {
  const file = mediaFileName(name)
  const known = index.get(file)
  if (known && known.startsWith(root) && fsSync.existsSync(known)) return known

  rebuildIndex(root)
  const found = index.get(file)
  if (found && found.startsWith(root) && fsSync.existsSync(found)) return found

  const flat = path.join(root, file)
  if (fsSync.existsSync(flat)) return flat
  return mediaPathIn(root, file)
}

// Асинхронный близнец resolveMediaIn для запросного пути: синхронная версия
// на промахе пересобирает индекс readdirSync'ом всего дерева media и блокирует
// event loop — серия запросов к несуществующим /media/<имя> подвешивала сервер.
let indexRebuildInFlight: Promise<void> | null = null

async function scanAsync(root: string, depth: number): Promise<void> {
  let entries: Array<fsSync.Dirent>
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH && !entry.name.startsWith('.')) await scanAsync(full, depth + 1)
      continue
    }
    if (!entry.isFile() || entry.name.endsWith('.tmp')) continue
    if (!index.has(entry.name)) index.set(entry.name, full)
  }
}

async function rebuildIndexAsync(root: string): Promise<void> {
  // single-flight: параллельные промахи ждут одну пересборку, а не десять
  if (indexRebuildInFlight) return indexRebuildInFlight
  indexRebuildInFlight = (async () => {
    for (const [name, file] of [...index]) {
      if (file.startsWith(root)) index.delete(name)
    }
    await scanAsync(root, 0)
    indexedRoots.add(root)
  })().finally(() => {
    indexRebuildInFlight = null
  })
  return indexRebuildInFlight
}

async function fileMissing(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return false
  } catch {
    return true
  }
}

export async function resolveMediaInAsync(root: string, name: string): Promise<string> {
  const file = mediaFileName(name)
  const known = index.get(file)
  if (known && known.startsWith(root) && !await fileMissing(known)) return known

  await rebuildIndexAsync(root)
  const found = index.get(file)
  if (found && found.startsWith(root) && !await fileMissing(found)) return found

  const flat = path.join(root, file)
  if (!await fileMissing(flat)) return flat
  return mediaPathIn(root, file)
}

/** Папки, в которых может лежать медиа: корень, папки досок и их подпапки. */
export async function mediaRootsIn(root: string): Promise<string[]> {
  const out = [root]
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const boardDir = path.join(root, entry.name)
    out.push(boardDir)
    const inner = await fs.readdir(boardDir, { withFileTypes: true }).catch(() => [])
    for (const sub of inner) {
      if (sub.isDirectory() && !sub.name.startsWith('.')) out.push(path.join(boardDir, sub.name))
    }
  }
  return out
}

export interface SortMediaInput {
  root: string
  /** Доски в порядке индекса: id, имя и имена файлов, на которые доска ссылается. */
  boards: ReadonlyArray<{ id: string; name?: string | null; files: readonly string[] }>
}

export interface SortMediaResult {
  moved: number
  skipped: number
}

/**
 * Разложить медиа по папкам досок.
 *
 * Идемпотентно и безопасно: только переносы, ничего не удаляем и не
 * перетираем. Файл, на который ссылается РОВНО ОДНА доска, уезжает к ней;
 * нужный нескольким или никому — в «общее». Это же и миграция при обновлении:
 * старые файлы из корня разъезжаются по местам, ссылки остаются прежними,
 * поэтому у клиента ничего не пропадает.
 */
export async function sortMediaByBoards(input: SortMediaInput): Promise<SortMediaResult> {
  const folders = boardFolderNames(input.boards)
  const owners = new Map<string, string[]>()
  for (const board of input.boards) {
    for (const raw of board.files) {
      const name = mediaFileName(raw)
      const list = owners.get(name)
      if (list) { if (!list.includes(board.id)) list.push(board.id) }
      else owners.set(name, [board.id])
    }
  }

  let moved = 0
  let skipped = 0
  for (const dir of await mediaRootsIn(input.root)) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.tmp')) continue
      const from = path.join(dir, entry.name)
      const ownerIds = owners.get(entry.name) ?? []
      const boardFolder = ownerIds.length === 1 ? folders.get(ownerIds[0]) : undefined
      const to = path.join(
        input.root,
        boardFolder ?? MEDIA_SHARED_FOLDER,
        mediaTypeFolder(entry.name),
        entry.name,
      )
      if (from === to) continue
      let occupied = false
      try {
        await fs.access(to)
        occupied = true
      } catch {
        // место свободно
      }
      // Никогда не перетираем: чужой файл важнее аккуратности раскладки.
      if (occupied) {
        skipped++
        continue
      }
      try {
        await fs.mkdir(path.dirname(to), { recursive: true })
        await fs.rename(from, to)
        noteMediaFile(to)
        moved++
      } catch {
        // Файл занят другой программой (Фотошоп держит копию) — оставляем как
        // есть: чтение найдёт его индексом там, где он лежит.
        skipped++
      }
    }
  }
  // Пустые папки после переездов только мешают глазам.
  for (const dir of (await mediaRootsIn(input.root)).reverse()) {
    if (dir === input.root) continue
    await fs.rmdir(dir).catch(() => {})
  }
  rebuildIndex(input.root)
  return { moved, skipped }
}

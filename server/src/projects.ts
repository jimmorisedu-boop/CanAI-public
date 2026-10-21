import { createHash, randomUUID } from 'node:crypto'
import { describeSnapshotShrink, snapshotShrinkMessage } from './snapshotShrink.js'
import { logNote } from './log.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { DurableFileMissingError, readDurableJson } from './durableJsonRecovery.js'
import { projectPreviewFromSnapshot, snapshotItemCount, type ProjectPreview } from './projectPreview.js'
import { redeliverProjectJobs } from './runner.js'

// Доски (проекты). Каждая доска — отдельный снапшот холста в
// data/projects/<id>/project.json. Индекс досок — data/projects.json.
// Ноды-черновик, макросы, настройки и media остаются общими на всё
// приложение. Всё лежит внутри data/ и переезжает вместе с папкой проекта.

const dataDir = path.dirname(config.projectFile)
const projectsDir = path.join(dataDir, 'projects')
const indexFile = path.join(dataDir, 'projects.json')
const trashDir = path.join(dataDir, 'trash')
const promptChatsDir = path.join(dataDir, 'prompt-chats')

export interface ProjectMeta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  revision: number
  pinned: boolean
}

/**
 * Кто писал доску ПОДРЯД, начиная с ревизии `base` (не включая её).
 *
 * `key` — ключ сеанса одной вкладки (тот же conflictKey, что она шлёт с каждой
 * записью), либо 'server' — результат поставил сам сервер, либо 'external' —
 * файл доски изменили снаружи.
 *
 * ⚠️ Нужен, чтобы отличать ДВЕ разные беды, которые снаружи выглядят одинаково.
 * Вкладка сохранила доску, сервер записал, а ответ до неё не дошёл (сорвалось
 * соединение, истекли 30 секунд ожидания, сервер упал сразу после записи).
 * Вкладка повторяет запись с прежним номером ревизии — и раньше получала
 * конфликтную копию, написанную «из-за другой вкладки», которой не было вовсе.
 * Если после этого номера доску писала только она сама, спорить не с кем.
 */
interface ProjectWriter {
  key: string
  base: number
}

interface StoredProjectMeta extends ProjectMeta {
  /** SHA-256 точного project.json, которому соответствует revision в индексе. */
  snapshotFingerprint?: string
  writer?: ProjectWriter
}

/** Кто писал доску последним — для объяснения конфликта в журнале. */
export type LastWriter =
  | { kind: 'other-tab'; key: string; base: number }
  | { kind: 'server' }
  | { kind: 'external' }
  | { kind: 'unknown' }

export interface ConflictRecoveryProject {
  id: string
  name: string
  revision: number
}

export interface ProjectPatch {
  name?: string
  pinned?: boolean
}

// id используем в путях — принимаем только безопасный набор символов
export function isSafeProjectId(id: string): boolean {
  return /^[A-Za-z0-9_-]{6,64}$/.test(id)
}

function projectDir(id: string): string {
  return path.join(projectsDir, id)
}

function projectFileFor(id: string): string {
  return path.join(projectDir(id), 'project.json')
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function parseProjectMeta(value: unknown): StoredProjectMeta | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<StoredProjectMeta>
  if (
    typeof raw.id !== 'string' ||
    !isSafeProjectId(raw.id) ||
    typeof raw.name !== 'string' ||
    typeof raw.createdAt !== 'number' ||
    typeof raw.updatedAt !== 'number'
  ) return null
  const revision = Number.isInteger(raw.revision) && (raw.revision ?? 0) >= 0 ? raw.revision! : 0
  const writer = parseProjectWriter(raw.writer, revision)
  const snapshotFingerprint = typeof raw.snapshotFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(raw.snapshotFingerprint)
    ? raw.snapshotFingerprint
    : undefined
  return {
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    revision,
    pinned: raw.pinned === true,
    ...(snapshotFingerprint ? { snapshotFingerprint } : {}),
    ...(writer ? { writer } : {}),
  }
}

function parseProjectWriter(value: unknown, revision: number): ProjectWriter | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { key?: unknown; base?: unknown }
  if (typeof raw.key !== 'string' || !/^[0-9a-z-]{1,64}$/.test(raw.key)) return undefined
  if (!Number.isInteger(raw.base) || (raw.base as number) < 0 || (raw.base as number) > revision) return undefined
  return { key: raw.key, base: raw.base as number }
}

/** Ключ сеанса вкладки, если он годный; чужое и пустое — не ключ. */
function sessionKey(value?: string): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null
}

function lastWriterOf(meta: StoredProjectMeta): LastWriter {
  const writer = meta.writer
  if (!writer) return { kind: 'unknown' }
  if (writer.key === 'server') return { kind: 'server' }
  if (writer.key === 'external') return { kind: 'external' }
  return { kind: 'other-tab', key: writer.key, base: writer.base }
}

function publicProjectMeta(meta: StoredProjectMeta): ProjectMeta {
  return {
    id: meta.id,
    name: meta.name,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    revision: meta.revision,
    pinned: meta.pinned,
  }
}

function parseProjectIndex(raw: string): StoredProjectMeta[] {
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('projects.json: expected an array')
  const normalized = parsed.map(parseProjectMeta)
  if (normalized.some((p) => p === null)) throw new Error('projects.json: invalid entry boards')
  return normalized as StoredProjectMeta[]
}

async function readIndex(): Promise<StoredProjectMeta[]> {
  try {
    return (await readDurableJson({
      file: indexFile,
      label: 'projects.json',
      parse: parseProjectIndex,
    })).value
  } catch (error) {
    if (error instanceof DurableFileMissingError) return []
    throw error
  }
}

async function writeIndex(list: StoredProjectMeta[]): Promise<void> {
  const tmp = `${indexFile}.tmp`
  try {
    await fs.copyFile(indexFile, `${indexFile}.bak`)
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
  await fs.writeFile(tmp, JSON.stringify(list, null, 2))
  await fs.rename(tmp, indexFile)
}

function fingerprintSnapshot(snapshotText: string | null): string {
  const hash = createHash('sha256')
  hash.update(snapshotText === null ? 'missing\0' : 'snapshot\0')
  if (snapshotText !== null) hash.update(snapshotText)
  return hash.digest('hex')
}

/**
 * Если процесс завершился после rename(project.json), но до rename индекса,
 * файл уже новый, а revision и fingerprint ещё старые. Сначала фиксируем это
 * состояние как отдельную ревизию; тогда вкладка со старой revision попадёт в
 * штатный conflict/recovery flow и не сможет затереть переживший сбой снимок.
 */
async function reconcileSnapshotFingerprint(
  index: StoredProjectMeta[],
  meta: StoredProjectMeta,
  snapshotText: string | null,
): Promise<void> {
  const actual = fingerprintSnapshot(snapshotText)
  if (meta.snapshotFingerprint === undefined) {
    // Одноразовая миграция старого индекса. Записываем baseline до следующей
    // замены project.json, чтобы уже первый save после обновления был защищён.
    meta.snapshotFingerprint = actual
    await writeIndex(index)
    return
  }
  if (meta.snapshotFingerprint === actual) return
  meta.snapshotFingerprint = actual
  // Файл доски изменили в обход нас — после этого ни одна вкладка не вправе
  // считать последнюю запись своей.
  meta.writer = { key: 'external', base: meta.revision }
  meta.revision++
  meta.updatedAt = Date.now()
  await writeIndex(index)
}

// Все «прочитал-изменил-записал» индекса — строго по очереди: параллельные
// операции (автосейв холста и создание/переименование доски) читали один и
// тот же индекс, и вторая запись затирала первую — доска исчезала из списка.
let indexQueue: Promise<unknown> = Promise.resolve()
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexQueue.then(fn, fn)
  indexQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

// ── роллинг-бэкапы холста ────────────────────────────────────────────────
// Помимо мгновенного .bak (перезаписывается каждым сейвом) держим до 20 копий
// с таймстампами в data/projects/<id>/backups/ — не чаще раза в 5 минут.
// Два подряд плохих сохранения больше не уничтожают последнюю хорошую версию.
// GC media бэкапы не читает: они защищают от битого JSON, не от чистки картинок.
const MAX_BACKUPS = 20
const BACKUP_EVERY_MS = 5 * 60 * 1000

async function backupSnapshot(id: string): Promise<void> {
  try {
    const dir = path.join(projectDir(id), 'backups')
    await fs.mkdir(dir, { recursive: true })
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('project-')).sort()

    // время берём из имени файла: mtime не годится — copyFile на Windows
    // сохраняет mtime исходника, а не момент создания копии
    const newest = files[files.length - 1]
    if (newest) {
      const stamp = newest
        .slice('project-'.length, -'.json'.length)
        .replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z')
      const takenAt = Date.parse(stamp)
      if (Number.isFinite(takenAt) && Date.now() - takenAt < BACKUP_EVERY_MS) return
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.copyFile(projectFileFor(id), path.join(dir, `project-${stamp}.json`))

    const excess = files.length + 1 - MAX_BACKUPS
    for (const f of files.slice(0, Math.max(0, excess))) {
      await fs.unlink(path.join(dir, f))
    }
  } catch {
    // первого project.json может ещё не существовать — это нормально
  }
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 80)
}

function normalizeConflictKey(value?: string): string {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : randomUUID()
}

function conflictCopyName(sourceName: string, at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return cleanName(
    `${sourceName} — conflict copy ${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`,
  )
}

// При первом запуске новой версии: если индекса ещё нет, создаём его и,
// если рядом лежит старый одиночный data/project.json — переносим его в
// первую доску (чтобы холст пользователя не потерялся).
export async function ensureProjects(): Promise<void> {
  return withIndexLock(async () => {
    await fs.mkdir(projectsDir, { recursive: true })
    const hadIndex = await fs.access(indexFile).then(
      () => true,
      (err) => {
        if (isNotFound(err)) return false
        throw err
      },
    )
    // Существующий пустой индекс — осознанное состояние после удаления
    // последней доски. Начальную доску/legacy-миграцию делаем только когда
    // projects.json ещё вообще не создавался.
    await readIndex()
    // readIndex may have restored a missing primary from projects.json.bak.
    // Check again so a valid backup never gets mistaken for a brand-new install.
    const indexExists = hadIndex || await fs.access(indexFile).then(
      () => true,
      (err) => {
        if (isNotFound(err)) return false
        throw err
      },
    )
    if (indexExists) return

    const now = Date.now()
    const id = randomUUID()
    await fs.mkdir(projectDir(id), { recursive: true })

    const legacy = config.projectFile
    const hasLegacy = await fs.access(legacy).then(() => true, () => false)
    if (hasLegacy) {
      try {
        await fs.rename(legacy, projectFileFor(id))
      } catch {
        await fs.copyFile(legacy, projectFileFor(id)).catch(() => {})
        await fs.unlink(legacy).catch(() => {})
      }
    }

    await writeIndex([{ id, name: 'Untitled', createdAt: now, updatedAt: now, revision: 0, pinned: false }])
  })
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const list = await readIndex()
  return list.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(publicProjectMeta)
}

export async function createProject(name: string, initialSnapshot?: unknown): Promise<ProjectMeta> {
  return withIndexLock(async () => {
    const index = await readIndex()
    const now = Date.now()
    const id = randomUUID()
    const destination = projectDir(id)
    await fs.mkdir(destination, { recursive: true })
    const meta: StoredProjectMeta = {
      id,
      name: cleanName(name) || 'Untitled',
      createdAt: now,
      updatedAt: now,
      revision: 0,
      pinned: false,
    }
    index.push(meta)
    try {
      if (initialSnapshot !== undefined) {
        // Пока снимок не записан, id отсутствует в опубликованном индексе.
        // Общий путь записи сохраняет revision/fingerprint и откат при сбое.
        await writeSnapshotLocked(index, meta, id, initialSnapshot, null)
      } else {
        await writeIndex(index)
      }
      return publicProjectMeta(meta)
    } catch (error) {
      // Windows может кратко держать свежий файл (антивирус/индексатор).
      // Повторы не дают откату оставить неиндексированную папку UUID.
      await fs.rm(destination, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }).catch(() => {})
      throw error
    }
  })
}

export async function updateProject(id: string, patch: ProjectPatch): Promise<ProjectMeta | null> {
  return withIndexLock(async () => {
    const index = await readIndex()
    const meta = index.find((p) => p.id === id)
    if (!meta) return null
    if (patch.name !== undefined) {
      const name = cleanName(patch.name) || meta.name
      if (name !== meta.name) {
        meta.name = name
        meta.updatedAt = Date.now()
      }
    }
    if (patch.pinned !== undefined) meta.pinned = patch.pinned
    await writeIndex(index)
    return publicProjectMeta(meta)
  })
}

export function renameProject(id: string, name: string): Promise<ProjectMeta | null> {
  return updateProject(id, { name })
}

export async function deleteProject(id: string): Promise<void> {
  return withIndexLock(async () => {
    const index = await readIndex()
    await writeIndex(index.filter((p) => p.id !== id))
    if (isSafeProjectId(id)) {
      await fs.rm(projectDir(id), { recursive: true, force: true }).catch(() => {})
    }
  })
}

export interface TrashedProjectMeta extends ProjectMeta {
  trashedAt: number
  /** Первая картинка или видео доски — чтобы её узнавали в лицо, а не по имени
   *  «Без названия». Может отсутствовать: на доске бывает только текст. */
  preview?: ProjectPreview | null
  /** Сколько объектов было на доске в момент удаления. */
  itemCount?: number
}

interface StoredTrashedProjectMeta extends TrashedProjectMeta {
  snapshotFingerprint?: string
}

function publicTrashedProjectMeta(meta: StoredTrashedProjectMeta): TrashedProjectMeta {
  return {
    ...publicProjectMeta(meta),
    trashedAt: meta.trashedAt,
    ...(meta.preview !== undefined ? { preview: meta.preview } : {}),
    ...(meta.itemCount !== undefined ? { itemCount: meta.itemCount } : {}),
  }
}

function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Unsafe Trash operation path')
  }
}

async function rebindPromptChatProjectId(root: string, projectId: string): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await rebindPromptChatProjectId(absolute, projectId)
    } else if (entry.isFile() && entry.name === 'meta.json') {
      const parsed = JSON.parse(await fs.readFile(absolute, 'utf8')) as Record<string, unknown>
      if (parsed.version === 2 && typeof parsed.projectId === 'string') {
        parsed.projectId = projectId
        const tmp = `${absolute}.tmp`
        await fs.writeFile(tmp, JSON.stringify(parsed, null, 2))
        await fs.rename(tmp, absolute)
      }
    }
  }
}

export async function trashProjectFiles(id: string): Promise<TrashedProjectMeta | null> {
  if (!isSafeProjectId(id)) return null
  return withIndexLock(async () => {
    const index = await readIndex()
    const meta = index.find((project) => project.id === id)
    if (!meta) return null
    const destination = path.join(trashDir, id)
    assertInside(trashDir, destination)
    await fs.mkdir(trashDir, { recursive: true })
    await fs.rm(destination, { recursive: true, force: true })
    await fs.mkdir(destination, { recursive: true })
    try {
      await fs.rename(projectDir(id), path.join(destination, 'project'))
      await fs.rename(
        path.join(promptChatsDir, id),
        path.join(destination, 'prompt-chat'),
      ).catch((error) => {
        if (!isNotFound(error)) throw error
      })
      for (const suffix of ['', '.bak']) {
        await fs.rename(
          path.join(promptChatsDir, `${id}.json${suffix}`),
          path.join(destination, `prompt-chat.json${suffix}`),
        ).catch((error) => {
          if (!isNotFound(error)) throw error
        })
      }
      const trashed: StoredTrashedProjectMeta = { ...meta, trashedAt: Date.now() }
      await fs.writeFile(path.join(destination, 'meta.json'), JSON.stringify(trashed, null, 2))
      await writeIndex(index.filter((project) => project.id !== id))
      return publicTrashedProjectMeta(trashed)
    } catch (error) {
      await fs.rename(path.join(destination, 'project'), projectDir(id)).catch(() => {})
      await fs.rename(
        path.join(destination, 'prompt-chat'),
        path.join(promptChatsDir, id),
      ).catch(() => {})
      for (const suffix of ['', '.bak']) {
        await fs.rename(
          path.join(destination, `prompt-chat.json${suffix}`),
          path.join(promptChatsDir, `${id}.json${suffix}`),
        ).catch(() => {})
      }
      throw error
    }
  })
}

export async function listTrashedProjectFiles(): Promise<TrashedProjectMeta[]> {
  try {
    const entries = await fs.readdir(trashDir, { withFileTypes: true })
    const projects = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(trashDir, entry.name, 'meta.json'), 'utf8'))
        const meta = parseProjectMeta(parsed)
        if (!meta || typeof parsed.trashedAt !== 'number') return null
        // Медиа при удалении доски НЕ переезжает: оно остаётся в data/media,
        // поэтому ссылка из снимка в корзине по-прежнему открывается.
        const snapshot = await fs
          .readFile(path.join(trashDir, entry.name, 'project', 'project.json'), 'utf8')
          .then((text) => JSON.parse(text) as unknown)
          .catch(() => null)
        return publicTrashedProjectMeta({
          ...meta,
          trashedAt: parsed.trashedAt,
          preview: projectPreviewFromSnapshot(snapshot),
          itemCount: snapshotItemCount(snapshot),
        })
      } catch {
        return null
      }
    }))
    return projects.filter((project): project is TrashedProjectMeta => Boolean(project))
      .sort((a, b) => b.trashedAt - a.trashedAt)
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

export async function restoreTrashedProjectFiles(id: string): Promise<ProjectMeta | null> {
  if (!isSafeProjectId(id)) return null
  return withIndexLock(async () => {
    const source = path.join(trashDir, id)
    assertInside(trashDir, source)
    let trashed: StoredTrashedProjectMeta
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(source, 'meta.json'), 'utf8')) as Record<string, unknown>
      const meta = parseProjectMeta(parsed)
      if (!meta || typeof parsed.trashedAt !== 'number') throw new Error('Board metadata in Trash is corrupted')
      trashed = { ...meta, trashedAt: parsed.trashedAt }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    const index = await readIndex()
    const restoredId = index.some((project) => project.id === trashed.id) ? randomUUID() : trashed.id
    const restored: StoredProjectMeta = {
      id: restoredId,
      name: cleanName(trashed.name) || 'Untitled',
      createdAt: trashed.createdAt,
      updatedAt: Date.now(),
      // Восстановление — новая версия состояния: вкладки, открытые до удаления,
      // должны получить конфликт, а не суметь перезаписать возвращённую доску.
      revision: trashed.revision + 1,
      pinned: trashed.pinned === true,
      ...(trashed.snapshotFingerprint ? { snapshotFingerprint: trashed.snapshotFingerprint } : {}),
    }
    const restoredPromptChatDir = path.join(promptChatsDir, restoredId)
    let indexWritten = false
    let movedProject = false
    let movedPromptChat = false
    const movedLegacySuffixes: string[] = []
    try {
      await fs.mkdir(projectsDir, { recursive: true })
      await fs.rename(path.join(source, 'project'), projectDir(restoredId))
      movedProject = true
      await fs.mkdir(promptChatsDir, { recursive: true })
      try {
        await fs.rename(path.join(source, 'prompt-chat'), restoredPromptChatDir)
        movedPromptChat = true
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      if (movedPromptChat && restoredId !== trashed.id) {
        await rebindPromptChatProjectId(restoredPromptChatDir, restoredId)
      }
      for (const suffix of ['', '.bak']) {
        try {
          await fs.rename(
            path.join(source, `prompt-chat.json${suffix}`),
            path.join(promptChatsDir, `${restoredId}.json${suffix}`),
          )
          movedLegacySuffixes.push(suffix)
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
      }
      index.push(restored)
      await writeIndex(index)
      indexWritten = true
      await fs.rm(source, { recursive: true, force: true })
      await redeliverProjectJobs(restoredId)
      return publicProjectMeta(restored)
    } catch (error) {
      // Ð’ Ð¸Ð½Ð´ÐµÐºÑÐµ ÐµÑ‰Ñ‘ Ð½ÐµÑ‚ Ð´Ð¾ÑÐºÐ¸ â€” Ð²Ð¾Ð·Ð²Ñ€Ð°Ñ‰Ð°ÐµÐ¼ Ð²ÑÑ‘ Ð² ÐºÐ¾Ñ€Ð·Ð¸Ð½Ñƒ, Ñ‡Ñ‚Ð¾Ð±Ñ‹ Ð²Ð¾ÑÑÑ‚Ð°Ð½Ð¾Ð²Ð»ÐµÐ½Ð¸Ðµ Ð¼Ð¾Ð¶Ð½Ð¾ Ð±Ñ‹Ð»Ð¾ Ð¿Ð¾Ð²Ñ‚Ð¾Ñ€Ð¸Ñ‚ÑŒ.
      if (!indexWritten) {
        for (const suffix of movedLegacySuffixes.reverse()) {
          await fs.rename(
            path.join(promptChatsDir, `${restoredId}.json${suffix}`),
            path.join(source, `prompt-chat.json${suffix}`),
          ).catch(() => {})
        }
        if (movedPromptChat) {
          if (restoredId !== trashed.id) {
            await rebindPromptChatProjectId(restoredPromptChatDir, trashed.id).catch(() => {})
          }
          await fs.rename(restoredPromptChatDir, path.join(source, 'prompt-chat')).catch(() => {})
        }
        if (movedProject) {
          await fs.rename(projectDir(restoredId), path.join(source, 'project')).catch(() => {})
        }
      }
      throw error
    }
  })
}

export async function deleteTrashedProjectFiles(id: string): Promise<boolean> {
  if (!isSafeProjectId(id)) return false
  const destination = path.join(trashDir, id)
  assertInside(trashDir, destination)
  try {
    await fs.access(path.join(destination, 'meta.json'))
  } catch {
    return false
  }
  await fs.rm(destination, { recursive: true, force: true })
  return true
}

export interface ProjectVersion {
  id: string
  createdAt: number
  // сколько объектов было на доске в этот момент и первое медиа для превью
  items?: number
  preview?: string
}

// Одна дата ничего не говорит: выбрать версию по времени нельзя, приходилось
// восстанавливать наугад и плодить копии доски (аудит F-18). Поэтому к каждой
// версии читаем сам снимок и достаём число объектов и первое медиа на превью.
// Файлы это метаданные (медиа лежат ссылками), поэтому чтение дешёвое.
async function describeVersion(file: string): Promise<{ items: number; preview?: string }> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const doc = JSON.parse(raw) as { items?: unknown[] }
    const items = Array.isArray(doc.items) ? doc.items.length : 0
    const preview = raw.match(/"(\/media\/[^"]+)"/)?.[1]
    return preview ? { items, preview } : { items }
  } catch {
    // битый или недочитанный бэкап не должен ронять весь список
    return { items: 0 }
  }
}

export async function listProjectVersionFiles(id: string): Promise<ProjectVersion[] | null> {
  if (!isSafeProjectId(id) || !(await readIndex()).some((project) => project.id === id)) return null
  const dir = path.join(projectDir(id), 'backups')
  try {
    const files = await fs.readdir(dir)
    const versions = files
      .filter((file) => /^project-.*\.json$/.test(file))
      .map((file) => {
        const stamp = file.slice('project-'.length, -'.json'.length)
          .replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z')
        return { id: file, createdAt: Date.parse(stamp) }
      })
      .filter((version) => Number.isFinite(version.createdAt))
      .sort((a, b) => b.createdAt - a.createdAt)
    return Promise.all(
      versions.map(async (version) => ({
        ...version,
        ...(await describeVersion(path.join(dir, version.id))),
      })),
    )
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

export async function importProjectTransferData(
  id: string,
  versions: Array<{ createdAt: number; snapshot: unknown }>,
  metadata: { comments: unknown[]; assistantConversations: unknown[] },
): Promise<void> {
  if (!isSafeProjectId(id)) throw new Error('Invalid imported board ID')
  await withIndexLock(async () => {
    if (!(await readIndex()).some((project) => project.id === id)) {
      throw new Error('Imported board not found')
    }
    const root = projectDir(id)
    const backups = path.join(root, 'backups')
    await fs.mkdir(backups, { recursive: true })
    const selected = versions
      .filter((version) => Number.isFinite(version.createdAt) && version.snapshot != null)
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(-MAX_BACKUPS)
    for (let index = 0; index < selected.length; index += 1) {
      const version = selected[index]!
      const stamp = new Date(version.createdAt + index).toISOString().replace(/[:.]/g, '-')
      const file = path.join(backups, `project-${stamp}.json`)
      const temporary = `${file}.${randomUUID()}.tmp`
      await fs.writeFile(temporary, JSON.stringify(version.snapshot))
      await fs.rename(temporary, file)
    }
    const metadataFile = path.join(root, 'transfer-data.json')
    const temporary = `${metadataFile}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, JSON.stringify({ version: 1, ...metadata }))
    await fs.rename(temporary, metadataFile)
  })
}

export interface ExportedProjectTransferData {
  versions: Array<{ id: string; createdAt: number; snapshot: unknown }>
  metadata: { comments: unknown[]; assistantConversations: unknown[] }
}

/**
 * Читает только переносимую историю доски. Повреждённый отдельный бэкап
 * пропускается: текущий холст уже отправлен отдельно и не должен теряться из-за
 * одной старой версии. Метаданные от прежнего cloud→local копирования также
 * подхватываются, чтобы круговой перенос ничего не выбрасывал.
 */
export async function exportProjectTransferData(id: string): Promise<ExportedProjectTransferData> {
  if (!isSafeProjectId(id) || !(await readIndex()).some((project) => project.id === id)) {
    throw new Error('Local board not found')
  }
  const listed = (await listProjectVersionFiles(id)) ?? []
  const versions: ExportedProjectTransferData['versions'] = []
  for (const version of listed.slice(0, MAX_BACKUPS).reverse()) {
    try {
      const snapshot = JSON.parse(
        await fs.readFile(path.join(projectDir(id), 'backups', version.id), 'utf8'),
      ) as unknown
      versions.push({ id: version.id, createdAt: version.createdAt, snapshot })
    } catch { /* одна повреждённая старая версия не блокирует копию */ }
  }
  let metadata: ExportedProjectTransferData['metadata'] = {
    comments: [],
    assistantConversations: [],
  }
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(projectDir(id), 'transfer-data.json'), 'utf8'),
    ) as Record<string, unknown>
    metadata = {
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      assistantConversations: Array.isArray(parsed.assistantConversations)
        ? parsed.assistantConversations
        : [],
    }
  } catch { /* у обычной локальной доски этого файла нет */ }
  return { versions, metadata }
}

export async function restoreProjectVersionFile(
  id: string,
  versionId: string,
): Promise<ProjectMeta | null> {
  if (!isSafeProjectId(id) || !/^project-[A-Za-z0-9T.-]+\.json$/.test(versionId)) return null
  return withIndexLock(async () => {
    const index = await readIndex()
    const sourceMeta = index.find((project) => project.id === id)
    if (!sourceMeta) return null
    const snapshot = await fs.readFile(path.join(projectDir(id), 'backups', versionId))
    const newId = randomUUID()
    const createdAt = Date.now()
    const versionDate = new Date(
      (await listProjectVersionFiles(id))?.find((version) => version.id === versionId)?.createdAt ?? createdAt,
    ).toLocaleString('en-US')
    const restored: StoredProjectMeta = {
      id: newId,
      name: cleanName(`${sourceMeta.name} — restored ${versionDate}`),
      createdAt,
      updatedAt: createdAt,
      revision: 0,
      pinned: sourceMeta.pinned,
      snapshotFingerprint: fingerprintSnapshot(snapshot.toString('utf8')),
    }
    const destination = projectDir(newId)
    try {
      await fs.mkdir(destination, { recursive: true })
      await fs.writeFile(projectFileFor(newId), snapshot)
      index.push(restored)
      await writeIndex(index)
      return publicProjectMeta(restored)
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  })
}

export interface LoadedProjectSnapshot {
  snapshot: unknown | null
  revision: number
  /** Local media links whose bytes were not found during the read. */
  missingMedia?: string[]
}

export async function loadProjectSnapshot(id: string): Promise<LoadedProjectSnapshot | null> {
  if (!isSafeProjectId(id)) return null
  return withIndexLock(async () => {
    const index = await readIndex()
    const meta = index.find((p) => p.id === id)
    if (!meta) return null
    let snapshotText: string | null = null
    let snapshot: unknown | null = null
    try {
      snapshotText = await fs.readFile(projectFileFor(id), 'utf8')
      snapshot = JSON.parse(snapshotText) as unknown
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    await reconcileSnapshotFingerprint(index, meta, snapshotText)
    return { snapshot, revision: meta.revision }
  })
}

export type SaveProjectResult =
  | { status: 'saved'; revision: number; repeatedFrom?: number }
  | { status: 'not-found' }
  | { status: 'conflict'; revision: number; recoveryProject: ConflictRecoveryProject; lastWriter: LastWriter }

async function saveConflictCopy(
  index: StoredProjectMeta[],
  source: StoredProjectMeta,
  snapshot: unknown,
  conflictKey?: string,
): Promise<ConflictRecoveryProject> {
  const id = `conflict-${normalizeConflictKey(conflictKey)}`
  const destination = projectDir(id)
  const file = projectFileFor(id)
  const tmp = `${file}.tmp`
  const rollbackTmp = `${file}.rollback.tmp`
  const existing = index.find((project) => project.id === id)
  const previousMeta = existing ? { ...existing } : null
  let previousSnapshot: string | null = null
  if (existing) {
    try {
      previousSnapshot = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }

  const createdAt = Date.now()
  const meta: StoredProjectMeta = existing ?? {
    id,
    name: conflictCopyName(source.name, createdAt),
    createdAt,
    updatedAt: createdAt,
    revision: 0,
    pinned: false,
  }
  if (existing) {
    meta.updatedAt = createdAt
    meta.revision++
  } else {
    index.push(meta)
  }

  await fs.mkdir(destination, { recursive: true })
  try {
    const serialized = JSON.stringify(snapshot)
    await fs.writeFile(tmp, serialized)
    await fs.rename(tmp, file)
    meta.snapshotFingerprint = fingerprintSnapshot(serialized)
    await writeIndex(index)
    return { id: meta.id, name: meta.name, revision: meta.revision }
  } catch (error) {
    try {
      if (previousMeta) {
        Object.assign(meta, previousMeta)
        if (previousSnapshot === null) {
          await fs.rm(file, { force: true })
        } else {
          await fs.writeFile(rollbackTmp, previousSnapshot, 'utf8')
          await fs.rename(rollbackTmp, file)
        }
      } else {
        index.splice(index.indexOf(meta), 1)
        await fs.rm(destination, { recursive: true, force: true })
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Could not roll back the conflict copy after saving the index failed',
      )
    }
    throw error
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
    await fs.rm(rollbackTmp, { force: true }).catch(() => {})
  }
}

/** Собственно запись снимка: бэкапы, сторож на похудение, атомарная замена.
 *  Вынесена из saveProjectSnapshot, потому что тем же путём пишет серверная
 *  доставка результата (mutateProjectSnapshot) — двум копиям этой логики
 *  расходиться нельзя. Зовётся ТОЛЬКО внутри withIndexLock. */
async function writeSnapshotLocked(
  index: StoredProjectMeta[],
  meta: StoredProjectMeta,
  id: string,
  snapshot: unknown,
  previousSnapshot: string | null,
  /** Кто пишет: ключ сеанса вкладки, 'server' или null — неизвестно кто. */
  writerKey: string | null = null,
): Promise<number> {
  // Сторож на молчаливую потерю: если доска худеет, записываем это в лог
  // вместе с именами файлов, ссылок на которые больше нет. Само по себе
  // уменьшение законно (человек удаляет объекты), поэтому запись, а не отказ.
  const shrink = describeSnapshotShrink(previousSnapshot, snapshot)
  if (shrink) logNote('project', snapshotShrinkMessage(id, shrink))

  const file = projectFileFor(id)
  // двухуровневая страховка: роллинг-копия раз в 5 минут + мгновенный .bak
  await backupSnapshot(id)
  await fs.copyFile(file, `${file}.bak`).catch(() => {})
  const tmp = `${file}.tmp`
  const rollbackTmp = `${file}.rollback.tmp`
  try {
    const serialized = JSON.stringify(snapshot)
    await fs.writeFile(tmp, serialized)
    await fs.rename(tmp, file)

    meta.updatedAt = Date.now()
    const previousWriter = meta.writer
    meta.revision++
    meta.snapshotFingerprint = fingerprintSnapshot(serialized)
    // Тот же писатель продолжает — точка отсчёта прежняя; новый — с этой записи.
    if (writerKey === null) delete meta.writer
    else if (previousWriter?.key !== writerKey) meta.writer = { key: writerKey, base: meta.revision - 1 }
    await writeIndex(index)
    return meta.revision
  } catch (error) {
    try {
      if (previousSnapshot === null) {
        await fs.rm(file, { force: true })
      } else {
        await fs.writeFile(rollbackTmp, previousSnapshot, 'utf8')
        await fs.rename(rollbackTmp, file)
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Could not roll back snapshot after errors saving index',
      )
    } finally {
      await fs.rm(rollbackTmp, { force: true }).catch(() => {})
    }
    throw error
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

export async function saveProjectSnapshot(
  id: string,
  snapshot: unknown,
  expectedRevision: number,
  conflictKey?: string,
): Promise<SaveProjectResult> {
  if (!isSafeProjectId(id)) return { status: 'not-found' }
  return withIndexLock(async () => {
    const index = await readIndex()
    const meta = index.find((p) => p.id === id)
    if (!meta) return { status: 'not-found' }

    await fs.mkdir(projectDir(id), { recursive: true })
    const file = projectFileFor(id)
    let previousSnapshot: string | null = null
    try {
      previousSnapshot = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    await reconcileSnapshotFingerprint(index, meta, previousSnapshot)
    const key = sessionKey(conflictKey)
    // Ответ на прошлую запись до вкладки не дошёл, и она повторяет её со
    // старым номером. Если после этого номера доску писала только она сама,
    // её нынешний снимок — продолжение тех же записей: спорить не с кем.
    const repeated = key !== null
      && meta.writer?.key === key
      && expectedRevision >= meta.writer.base
      && expectedRevision < meta.revision
    if (meta.revision !== expectedRevision && !repeated) {
      const lastWriter = lastWriterOf(meta)
      const recoveryProject = await saveConflictCopy(index, meta, snapshot, conflictKey)
      return { status: 'conflict', revision: meta.revision, recoveryProject, lastWriter }
    }
    const revision = await writeSnapshotLocked(index, meta, id, snapshot, previousSnapshot, key)
    return repeated ? { status: 'saved', revision, repeatedFrom: expectedRevision } : { status: 'saved', revision }
  })
}

/**
 * Правка снимка доски ПОД ЗАМКОМ.
 *
 * Отличается от saveProjectSnapshot одним, но важным: читает и пишет в одной
 * критической секции, поэтому не может проиграть гонку и не делает
 * конфликтных копий. Ради этого и заведена — серверной доставке результата
 * (canvasDelivery) конфликтная копия была бы не спасением, а мусором:
 * пользователь получил бы вторую доску вместо картинки.
 *
 * `mutate` возвращает null, если делать нечего.
 */
export async function mutateProjectSnapshot(
  id: string,
  mutate: (snapshot: unknown) => unknown | null,
): Promise<'saved' | 'not-found' | 'skipped'> {
  if (!isSafeProjectId(id)) return 'not-found'
  return withIndexLock(async () => {
    const index = await readIndex()
    const meta = index.find((project) => project.id === id)
    if (!meta) return 'not-found'
    let snapshotText: string | null = null
    let snapshot: unknown = null
    try {
      snapshotText = await fs.readFile(projectFileFor(id), 'utf8')
      snapshot = JSON.parse(snapshotText) as unknown
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    await reconcileSnapshotFingerprint(index, meta, snapshotText)
    const next = mutate(snapshot)
    if (next === null || next === undefined) return 'skipped'
    await fs.mkdir(projectDir(id), { recursive: true })
    await writeSnapshotLocked(index, meta, id, next, snapshotText, 'server')
    return 'saved'
  })
}

export async function projectPreview(id: string): Promise<ProjectPreview | null> {
  if (!isSafeProjectId(id)) return null
  try {
    return projectPreviewFromSnapshot(JSON.parse(await fs.readFile(projectFileFor(id), 'utf8')))
  } catch {
    return null
  }
}

// Переходный контракт для старых клиентов.
export async function projectThumb(id: string): Promise<string | null> {
  return (await projectPreview(id))?.src ?? null
}

// пути ко всем project.json — для сборки мусора media
export async function allProjectFiles(): Promise<string[]> {
  const index = await readIndex()
  const files: string[] = []
  for (const project of index) {
    const primary = projectFileFor(project.id)
    files.push(primary, `${primary}.bak`)
    const backupsDir = path.join(projectDir(project.id), 'backups')
    try {
      const backups = await fs.readdir(backupsDir)
      files.push(...backups.filter((name) => /^project-.*\.json$/.test(name)).map((name) => path.join(backupsDir, name)))
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }
  try {
    const trashed = await fs.readdir(trashDir, { withFileTypes: true })
    for (const entry of trashed) {
      if (!entry.isDirectory() || !isSafeProjectId(entry.name)) continue
      const root = path.join(trashDir, entry.name, 'project')
      files.push(path.join(root, 'project.json'), path.join(root, 'project.json.bak'))
      try {
        const backups = await fs.readdir(path.join(root, 'backups'))
        files.push(...backups
          .filter((name) => /^project-.*\.json$/.test(name))
          .map((name) => path.join(root, 'backups', name)))
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  return files
}

/**
 * Что за материал лежит на каждой доске — для раскладки media по папкам.
 *
 * Берём ТОЛЬКО живой project.json: в .bak и роллинг-копиях остаются ссылки на
 * то, что с доски уже убрали, и по ним файл уехал бы к доске, которая его
 * больше не показывает. Уборка мусора смотрит и в копии — это её дело, а не
 * раскладки.
 */
export async function boardMediaFiles(): Promise<Array<{ id: string; name: string; files: string[] }>> {
  const index = await readIndex()
  const boards: Array<{ id: string; name: string; files: string[] }> = []
  for (const project of index) {
    let text: string
    try {
      text = await fs.readFile(projectFileFor(project.id), 'utf8')
    } catch {
      // Доска без холста (только что создана) — материала за ней нет.
      boards.push({ id: project.id, name: project.name, files: [] })
      continue
    }
    const files = new Set<string>()
    for (const match of text.matchAll(/\/media\/([A-Za-z0-9._-]+)/g)) files.add(match[1])
    boards.push({ id: project.id, name: project.name, files: [...files] })
  }
  return boards
}

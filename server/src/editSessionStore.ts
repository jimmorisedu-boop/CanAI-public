import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveMediaIn } from './mediaLayout.js'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type EditSessionState = 'waiting' | 'ready' | 'applied' | 'broken'

export interface StoredEditSessionV2 {
  id: string
  projectId: string
  /**
   * Откуда доска: своя или командная.
   *
   * ⚠️ У командной доски идентификатор живёт на сервере команды, и в локальном
   * индексе досок его НЕ БУДЕТ никогда — сверять с ним такую сессию значит
   * отказывать в правке всегда. Запись без поля считается локальной: так
   * читаются сессии, начатые до появления командных досок.
   */
  boardSource?: 'cloud'
  /** Имя командной доски: локального индекса, где его прочесть, у неё нет. */
  boardName?: string
  sourceItemId: string
  sourceName: string
  fileName: string
  createdAt: number
  expiresAt: number
  lastMtime: number
  appliedMtime: number
  placedItemId: string | null
  state: EditSessionState
  error?: string
}

interface LegacyEditSession {
  id: string
  fileName: string
  createdAt: number
}

interface SessionsDocumentV2 {
  version: 2
  sessions: StoredEditSessionV2[]
  legacy: LegacyEditSession[]
}

interface EditSessionStoreOptions {
  file: string
  mediaDir: string
  now?: () => number
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafeFileName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && path.basename(value) === value
}

function parseLegacy(value: unknown): LegacyEditSession | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<LegacyEditSession>
  if (
    typeof raw.id !== 'string' || raw.id.length === 0 ||
    !isSafeFileName(raw.fileName) ||
    !isFiniteNumber(raw.createdAt)
  ) return null
  return { id: raw.id, fileName: raw.fileName, createdAt: raw.createdAt }
}

function parseSession(value: unknown): StoredEditSessionV2 | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<StoredEditSessionV2>
  if (
    typeof raw.id !== 'string' || raw.id.length === 0 ||
    typeof raw.projectId !== 'string' || raw.projectId.length === 0 ||
    typeof raw.sourceItemId !== 'string' || raw.sourceItemId.length === 0 ||
    typeof raw.sourceName !== 'string' ||
    (raw.boardSource !== undefined && raw.boardSource !== 'cloud') ||
    (raw.boardName !== undefined && typeof raw.boardName !== 'string') ||
    !isSafeFileName(raw.fileName) ||
    !isFiniteNumber(raw.createdAt) ||
    !isFiniteNumber(raw.expiresAt) ||
    !isFiniteNumber(raw.lastMtime) ||
    !isFiniteNumber(raw.appliedMtime) ||
    (raw.placedItemId !== null && typeof raw.placedItemId !== 'string') ||
    !['waiting', 'ready', 'applied', 'broken'].includes(raw.state ?? '') ||
    (raw.error !== undefined && typeof raw.error !== 'string')
  ) return null
  return {
    id: raw.id,
    projectId: raw.projectId,
    ...(raw.boardSource === 'cloud' ? { boardSource: 'cloud' as const } : {}),
    ...(raw.boardName === undefined ? {} : { boardName: raw.boardName }),
    sourceItemId: raw.sourceItemId,
    sourceName: raw.sourceName,
    fileName: raw.fileName,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    lastMtime: raw.lastMtime,
    appliedMtime: raw.appliedMtime,
    placedItemId: raw.placedItemId,
    state: raw.state as EditSessionState,
    ...(raw.error === undefined ? {} : { error: raw.error }),
  }
}

function cloneSession(session: StoredEditSessionV2): StoredEditSessionV2 {
  return { ...session }
}

export class EditSessionStore {
  private readonly file: string
  private readonly mediaDir: string
  private readonly now: () => number
  private document: SessionsDocumentV2 = { version: 2, sessions: [], legacy: [] }
  private loaded = false
  private needsWrite = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: EditSessionStoreOptions) {
    this.file = options.file
    this.mediaDir = options.mediaDir
    this.now = options.now ?? Date.now
  }

  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if (!isNotFound(error)) throw error
      this.document = { version: 2, sessions: [], legacy: [] }
      this.loaded = true
      this.needsWrite = false
      return
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
      throw new Error('edit-sessions.json: invalid document')
    }

    if (parsed.version === 1) {
      const legacy = parsed.sessions.map(parseLegacy)
      if (legacy.some((item) => item === null)) {
        throw new Error('edit-sessions.json: invalid legacy-session')
      }
      this.document = { version: 2, sessions: [], legacy: legacy as LegacyEditSession[] }
      this.loaded = true
      this.needsWrite = true
      return
    }

    if (parsed.version !== 2 || !Array.isArray(parsed.legacy)) {
      throw new Error('edit-sessions.json: unsupported version')
    }
    const sessions = parsed.sessions.map(parseSession)
    const legacy = parsed.legacy.map(parseLegacy)
    if (sessions.some((item) => item === null) || legacy.some((item) => item === null)) {
      throw new Error('edit-sessions.json: invalid entry session')
    }
    this.document = {
      version: 2,
      sessions: sessions as StoredEditSessionV2[],
      legacy: legacy as LegacyEditSession[],
    }
    this.loaded = true
    this.needsWrite = false
  }

  private pruneExpired(): void {
    const now = this.now()
    const sessions = this.document.sessions.filter((session) => session.expiresAt > now)
    const legacy = this.document.legacy.filter((session) => session.createdAt + SESSION_TTL_MS > now)
    if (sessions.length !== this.document.sessions.length || legacy.length !== this.document.legacy.length) {
      this.document = { version: 2, sessions, legacy }
      this.needsWrite = true
    }
  }

  private async persistIfNeeded(): Promise<void> {
    if (!this.needsWrite) return
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(this.document, null, 2))
      await fs.rename(temporary, this.file)
      this.needsWrite = false
    } catch (error) {
      this.loaded = false
      try {
        await fs.unlink(temporary)
      } catch (cleanupError) {
        if (!isNotFound(cleanupError)) {
          // The original persistence error is more useful to the caller.
        }
      }
      throw error
    }
  }

  create(session: StoredEditSessionV2): Promise<StoredEditSessionV2> {
    return this.locked(async () => {
      await this.ensureLoaded()
      this.pruneExpired()
      if (!parseSession(session)) throw new Error('Invalid data session external editor')
      if (this.document.sessions.some((item) => item.id === session.id)) {
        throw new Error(`Session ${session.id} already exists`)
      }
      const created = cloneSession(session)
      this.document.sessions.push(created)
      this.needsWrite = true
      await this.persistIfNeeded()
      return cloneSession(created)
    })
  }

  list(): Promise<StoredEditSessionV2[]> {
    return this.locked(async () => {
      await this.ensureLoaded()
      this.pruneExpired()
      for (const session of this.document.sessions) {
        try {
          // Путь ищет раскладка: копия для редактора лежит в папке по типу
          // (см. mediaLayout), а в сессии хранится только имя файла.
          const stat = await fs.stat(resolveMediaIn(this.mediaDir, session.fileName))
          if (stat.mtimeMs > session.lastMtime) {
            session.lastMtime = stat.mtimeMs
            session.state = 'ready'
            delete session.error
            this.needsWrite = true
          } else if (session.state === 'broken') {
            session.state = session.lastMtime > session.appliedMtime
              ? 'ready'
              : session.placedItemId
                ? 'applied'
                : 'waiting'
            delete session.error
            this.needsWrite = true
          }
        } catch (error) {
          if (!isNotFound(error)) throw error
          if (session.state !== 'broken' || session.error !== 'File external editor not found' && session.error !== 'Файл внешнего редактора не найден') {
            session.state = 'broken'
            session.error = 'File external editor not found'
            this.needsWrite = true
          }
        }
      }
      await this.persistIfNeeded()
      return this.document.sessions.map(cloneSession)
    })
  }

  acknowledge(
    id: string,
    update: { appliedMtime: number; placedItemId: string },
  ): Promise<StoredEditSessionV2 | null> {
    return this.locked(async () => {
      await this.ensureLoaded()
      this.pruneExpired()
      const session = this.document.sessions.find((item) => item.id === id)
      if (!session) {
        await this.persistIfNeeded()
        return null
      }
      if (!isFiniteNumber(update.appliedMtime) || update.appliedMtime > session.lastMtime) {
        throw new Error('Applied version cannot be newer than the file version')
      }
      if (update.appliedMtime <= session.appliedMtime) {
        await this.persistIfNeeded()
        return cloneSession(session)
      }
      session.appliedMtime = update.appliedMtime
      session.placedItemId = update.placedItemId
      session.state = update.appliedMtime < session.lastMtime ? 'ready' : 'applied'
      delete session.error
      this.needsWrite = true
      await this.persistIfNeeded()
      return cloneSession(session)
    })
  }

  markBroken(id: string, error: string): Promise<StoredEditSessionV2 | null> {
    return this.locked(async () => {
      await this.ensureLoaded()
      this.pruneExpired()
      const session = this.document.sessions.find((item) => item.id === id)
      if (!session) {
        await this.persistIfNeeded()
        return null
      }
      session.state = 'broken'
      session.error = error
      this.needsWrite = true
      await this.persistIfNeeded()
      return cloneSession(session)
    })
  }

  remove(id: string): Promise<boolean> {
    return this.locked(async () => {
      await this.ensureLoaded()
      this.pruneExpired()
      const before = this.document.sessions.length
      this.document.sessions = this.document.sessions.filter((item) => item.id !== id)
      const removed = this.document.sessions.length !== before
      if (removed) this.needsWrite = true
      await this.persistIfNeeded()
      return removed
    })
  }

  activeFileNames(): Promise<string[]> {
    return this.locked(async () => {
      await this.ensureLoaded()
      this.pruneExpired()
      await this.persistIfNeeded()
      return [
        ...this.document.sessions.map((session) => session.fileName),
        ...this.document.legacy.map((session) => session.fileName),
      ]
    })
  }
}

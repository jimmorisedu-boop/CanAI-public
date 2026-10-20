import fs from 'node:fs/promises'
import path from 'node:path'
import type { MediaImportTask, MediaImportStatus } from './mediaImportTypes.js'

interface MediaImportDocument {
  version: 1
  tasks: MediaImportTask[]
}

interface MediaImportStoreOptions {
  now?: () => number
  terminalLimit?: number
  terminalMaxAgeMs?: number
}

const TERMINAL = new Set<MediaImportStatus>(['completed', 'error', 'cancelled', 'interrupted'])
const DEFAULT_TERMINAL_LIMIT = 200
const DEFAULT_TERMINAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isDocument(raw: unknown): raw is MediaImportDocument {
  if (!raw || typeof raw !== 'object') return false
  const document = raw as Partial<MediaImportDocument>
  return document.version === 1 && Array.isArray(document.tasks)
}

export class MediaImportStore {
  private readonly file: string
  private readonly now: () => number
  private readonly terminalLimit: number
  private readonly terminalMaxAgeMs: number
  private queue: Promise<void> = Promise.resolve()
  private tasks: MediaImportTask[] | null = null

  constructor(file: string, options: MediaImportStoreOptions = {}) {
    this.file = file
    this.now = options.now ?? Date.now
    this.terminalLimit = options.terminalLimit ?? DEFAULT_TERMINAL_LIMIT
    this.terminalMaxAgeMs = options.terminalMaxAgeMs ?? DEFAULT_TERMINAL_MAX_AGE_MS
  }

  load(): Promise<MediaImportTask[]> {
    return this.lock(async () => clone(await this.ensureLoaded()))
  }

  list(): Promise<MediaImportTask[]> {
    return this.load()
  }

  get(id: string): Promise<MediaImportTask | null> {
    return this.lock(async () => clone((await this.ensureLoaded()).find((task) => task.id === id) ?? null))
  }

  upsert(task: MediaImportTask): Promise<void> {
    return this.lock(async () => {
      const tasks = [...await this.ensureLoaded()]
      const index = tasks.findIndex((candidate) => candidate.id === task.id)
      if (index >= 0) tasks[index] = clone(task)
      else tasks.push(clone(task))
      await this.write(this.prune(tasks))
    })
  }

  save(tasks: MediaImportTask[]): Promise<void> {
    return this.lock(async () => {
      await this.ensureLoaded()
      await this.write(this.prune(clone(tasks)))
    })
  }

  private lock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async ensureLoaded(): Promise<MediaImportTask[]> {
    if (this.tasks) return this.tasks
    const parse = async (file: string): Promise<MediaImportTask[]> => {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
      if (!isDocument(raw)) throw new Error('corrupted document queue import')
      return clone(raw.tasks)
    }
    try {
      this.tasks = await parse(this.file)
      return this.tasks
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.tasks = []
        return this.tasks
      }
      // Основной файл битый — пробуем резервную копию (обновляется при каждой
      // записи) и восстанавливаем из неё основной файл.
      try {
        this.tasks = await parse(`${this.file}.bak`)
        await this.write(this.tasks)
        return this.tasks
      } catch {
        // Ошибку НЕ кэшируем: после ручной починки/удаления файла импорты
        // оживают без перезапуска сервера (раньше loadError прилипал навсегда).
        throw new Error(`File queue import corrupted: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private prune(tasks: MediaImportTask[]): MediaImportTask[] {
    const cutoff = this.now() - this.terminalMaxAgeMs
    const active = tasks.filter((task) => !TERMINAL.has(task.status))
    const terminal = tasks
      .filter((task) => TERMINAL.has(task.status) && task.updatedAt >= cutoff)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, this.terminalLimit)
    const kept = new Set([...active, ...terminal].map((task) => task.id))
    return tasks.filter((task) => kept.has(task.id))
  }

  private async write(tasks: MediaImportTask[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      await fs.copyFile(this.file, `${this.file}.bak`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      const document: MediaImportDocument = { version: 1, tasks }
      await fs.writeFile(tmp, JSON.stringify(document, null, 2), 'utf8')
      await fs.rename(tmp, this.file)
      this.tasks = clone(tasks)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

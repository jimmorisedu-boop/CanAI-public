import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentCheckpointPayload } from '../../../packages/agent-protocol/index.js'
import { AgentProtocolError, checkRelativePath } from './validation.js'
import {
  cloneTask,
  type AgentJournalDocument,
  type AgentJournalEvent,
  type AgentTaskRecord,
} from './types.js'

type EventListener = (event: AgentJournalEvent) => void

function clone<T>(value: T): T {
  return structuredClone(value)
}

export interface JournalMutationResult {
  changed?: boolean
  event?: { type: string; payload: Record<string, unknown> }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export interface JournalOptions {
  workspaceRoot: string
  checkpointRoot: string
  now?: () => number
}

export class AgentTaskJournal {
  private readonly file: string
  private readonly backup: string
  private readonly workspaceRoot: string
  private readonly checkpointRoot: string
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()
  /**
   * Serializes lifecycle/protocol operations for one task across the journal
   * queue and the child-process callback queue.  A journal mutation by itself
   * cannot protect the asynchronous broker call that follows it; this small
   * task lock keeps the state gate and that call in one critical section.
   */
  private readonly taskLocks = new Map<string, Promise<void>>()
  private document: AgentJournalDocument | null = null
  private readonly listeners = new Map<string, Set<EventListener>>()

  constructor(file: string, options: JournalOptions) {
    this.file = file
    this.backup = `${file}.bak`
    this.workspaceRoot = path.resolve(options.workspaceRoot)
    this.checkpointRoot = path.resolve(options.checkpointRoot)
    this.now = options.now ?? Date.now
  }

  async load(): Promise<AgentTaskRecord[]> {
    return this.lock(async () => clone((await this.ensure()).tasks))
  }

  async list(): Promise<AgentTaskRecord[]> {
    return this.load()
  }

  async get(taskId: string): Promise<AgentTaskRecord | null> {
    return this.lock(async () => {
      const task = (await this.ensure()).tasks.find((entry) => entry.taskId === taskId)
      return task ? clone(task) : null
    })
  }

  async findRequest(requestId: string): Promise<AgentTaskRecord | null> {
    return this.lock(async () => {
      const task = (await this.ensure()).tasks.find((entry) => entry.requestId === requestId)
      return task ? clone(task) : null
    })
  }

  async create(task: AgentTaskRecord): Promise<AgentTaskRecord> {
    return this.lock(async () => {
      const current = await this.ensure()
      if (current.tasks.some((entry) => entry.taskId === task.taskId)) {
        throw new Error(`Task ${task.taskId} already exists`)
      }
      const document = clone(current)
      document.tasks.push(clone(task))
      document.events[task.taskId] = []
      await this.write(document)
      return clone(task)
    })
  }

  async mutate(
    taskId: string,
    updater: (task: AgentTaskRecord) => void | JournalMutationResult | Promise<void | JournalMutationResult>,
    event?: { type: string; payload: Record<string, unknown> },
  ): Promise<AgentTaskRecord> {
    return this.lock(async () => {
      const current = await this.ensure()
      const document = clone(current)
      const task = document.tasks.find((entry) => entry.taskId === taskId)
      if (!task) throw new Error('Task not found')
      const mutation = await updater(task)
      if (mutation?.changed === false) return clone(task)
      task.updatedAt = this.now()
      let emitted: AgentJournalEvent | null = null
      const eventSpec = mutation && Object.prototype.hasOwnProperty.call(mutation, 'event')
        ? mutation.event
        : event
      if (eventSpec) {
        emitted = {
          cursor: task.eventCursor + 1,
          taskId,
          type: eventSpec.type,
          at: this.now(),
          payload: clone(eventSpec.payload),
        }
        task.eventCursor = emitted.cursor
        const events = document.events[taskId] ?? (document.events[taskId] = [])
        events.push(emitted)
      }
      await this.write(document)
      if (emitted) this.notify(emitted)
      return clone(task)
    })
  }

  async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chain = previous.then(() => current)
    this.taskLocks.set(taskId, chain)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.taskLocks.get(taskId) === chain) this.taskLocks.delete(taskId)
    }
  }

  async events(taskId: string, after = 0): Promise<AgentJournalEvent[]> {
    return this.lock(async () => clone((await this.ensure()).events[taskId] ?? []).filter((event) => event.cursor > after))
  }

  subscribe(taskId: string, listener: EventListener): () => void {
    let set = this.listeners.get(taskId)
    if (!set) {
      set = new Set()
      this.listeners.set(taskId, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set?.size === 0) this.listeners.delete(taskId)
    }
  }

  checkpointPath(taskId: string, checkpointId: string): string {
    const safeTask = taskId.replace(/[^A-Za-z0-9_-]/gu, '_')
    const safeCheckpoint = checkpointId.replace(/[^A-Za-z0-9_.:-]/gu, '_')
    return path.join(this.checkpointRoot, safeTask, `${safeCheckpoint}.json`)
  }

  async writeCheckpoint(
    task: AgentTaskRecord,
    payload: AgentCheckpointPayload,
    verify: (payload: AgentCheckpointPayload) => Promise<void>,
  ): Promise<string> {
    await verify(payload)
    const file = this.checkpointPath(task.taskId, payload.checkpointId)
    const serialized = JSON.stringify(payload)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      const previous = await fs.readFile(file, 'utf8').catch((error) => {
        if (isNotFound(error)) return null
        throw error
      })
      if (previous !== null) {
        if (previous !== serialized) throw new AgentProtocolError('CHECKPOINT_CONFLICT', 'Checkpoint ID already contains different state')
        return file
      }
      await fs.writeFile(temporary, serialized, 'utf8')
      await fs.rename(temporary, file)
      const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as AgentCheckpointPayload
      await verify(persisted)
      return file
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async ensure(): Promise<AgentJournalDocument> {
    if (this.document) return this.document
    const parse = async (file: string): Promise<AgentJournalDocument> => {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as AgentJournalDocument
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks) || !parsed.events || typeof parsed.events !== 'object') {
        throw new Error('Agent task journal is corrupt')
      }
      // The foundation journal predates staged local-canvas delivery. Keep
      // existing task files readable without treating an omitted optional
      // queue as a corrupt journal.
      for (const task of parsed.tasks) {
        if (!Array.isArray(task.pendingCanvasItems)) task.pendingCanvasItems = []
        if (!Array.isArray(task.llmOperations)) task.llmOperations = []
        if (!Array.isArray(task.generationOperations)) task.generationOperations = []
        if (!Array.isArray(task.mediaRenderOperations)) task.mediaRenderOperations = []
        if (!task.controlReceipts || typeof task.controlReceipts !== 'object') task.controlReceipts = {}
        if (!task.decisionReceipts || typeof task.decisionReceipts !== 'object') task.decisionReceipts = {}
      }
      return parsed
    }
    try {
      this.document = await parse(this.file)
    } catch (error) {
      if (isNotFound(error)) this.document = { version: 1, tasks: [], events: {} }
      else {
        try {
          this.document = await parse(this.backup)
          await this.write(this.document)
        } catch {
          throw new Error(`Agent task journal is corrupt: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    return this.document
  }

  private lock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async write(document: AgentJournalDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await fs.copyFile(this.file, this.backup).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    try {
      await fs.writeFile(temporary, JSON.stringify(document, null, 2), 'utf8')
      await fs.rename(temporary, this.file)
      this.document = document
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private notify(event: AgentJournalEvent): void {
    for (const listener of this.listeners.get(event.taskId) ?? []) {
      try { listener(clone(event)) } catch { /* UI stream must not break the Host */ }
    }
  }
}

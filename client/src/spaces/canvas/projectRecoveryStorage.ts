import type { CanvasDoc } from './konva/types'

const SCHEMA = 1
const KEY_PREFIX = 'canai-project-recovery:v1:'

export interface ProjectRecoveryRecord {
  projectId: string
  snapshot: CanvasDoc
  revision: number
  updatedAt: number
  /**
   * Ключ сеанса вкладки, которая писала этот снимок.
   *
   * ⚠️ Сервер мог записать доску и упасть, не ответив: вкладка перезагружается
   * и досылает несохранённое со старым номером ревизии. Под своим прежним
   * ключом сервер узнаёт её записи и принимает досылку; под новым он видел
   * чужую запись и делал конфликтную копию на ровном месте.
   */
  conflictKey?: string
}

export interface ProjectRecoverySaveResult {
  durable: boolean
  error?: unknown
}

export interface ProjectRecoveryClearResult {
  cleared: boolean
  durable: boolean
  error?: unknown
}

export interface ProjectRecoveryStorage {
  load(projectId: string): ProjectRecoveryRecord | null
  save(record: ProjectRecoveryRecord): ProjectRecoverySaveResult
  clear(projectId: string): ProjectRecoveryClearResult
}

function storageKey(projectId: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(projectId)}`
}

function browserStorage(): Storage | null {
  try {
    if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return null
    const candidate = globalThis.localStorage
    return typeof candidate?.getItem === 'function'
      && typeof candidate.setItem === 'function'
      && typeof candidate.removeItem === 'function'
      ? candidate
      : null
  } catch {
    return null
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function serialize(record: ProjectRecoveryRecord): string {
  return JSON.stringify({
    schema: SCHEMA,
    projectId: record.projectId,
    revision: record.revision,
    updatedAt: record.updatedAt,
    ...(record.conflictKey ? { conflictKey: record.conflictKey } : {}),
    snapshot: record.snapshot,
  })
}

function parse(raw: string | null, projectId: string): ProjectRecoveryRecord | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const snapshot = value.snapshot
    if (
      value.schema !== SCHEMA
      || value.projectId !== projectId
      || !Number.isSafeInteger(value.revision)
      || !Number.isFinite(value.updatedAt)
      || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || (snapshot as Record<string, unknown>).version !== 1
      || !Array.isArray((snapshot as Record<string, unknown>).items)
    ) return null
    return {
      projectId,
      snapshot: clone(snapshot) as CanvasDoc,
      revision: value.revision as number,
      updatedAt: value.updatedAt as number,
      ...(typeof value.conflictKey === 'string' && /^[0-9a-f-]{36}$/i.test(value.conflictKey)
        ? { conflictKey: value.conflictKey }
        : {}),
    }
  } catch {
    return null
  }
}

/**
 * Project recovery persistence for the browser. localStorage is the durable
 * boundary already used by the client; a private in-memory copy keeps edits
 * recoverable when the browser denies or exhausts that storage.
 */
export function createProjectRecoveryStorage(
  storage: Storage | null = browserStorage(),
): ProjectRecoveryStorage {
  const memory = new Map<string, ProjectRecoveryRecord>()

  return {
    load(projectId) {
      const fallback = memory.get(projectId)
      try {
        const durable = parse(storage?.getItem(storageKey(projectId)) ?? null, projectId)
        if (durable && (!fallback || durable.updatedAt > fallback.updatedAt)) return durable
      } catch {
        // Fall through to the memory copy when storage is blocked.
      }
      return fallback ? clone(fallback) : null
    },

    save(record) {
      try {
        // Keep a copy ready before touching the optional browser storage.
        memory.set(record.projectId, clone(record))
      } catch (error) {
        return { durable: false, error }
      }
      try {
        if (!storage) throw new Error("Browser storage unavailable")
        storage.setItem(storageKey(record.projectId), serialize(record))
        memory.delete(record.projectId)
        return { durable: true }
      } catch (error) {
        return { durable: false, error }
      }
    },

    clear(projectId) {
      if (!storage) {
        memory.delete(projectId)
        return { cleared: true, durable: false }
      }
      try {
        storage.removeItem(storageKey(projectId))
        memory.delete(projectId)
        return { cleared: true, durable: true }
      } catch (error) {
        // Keep the memory copy. The durable record may still be present too;
        // retaining both is safer than claiming the recovery was cleared.
        return { cleared: false, durable: false, error }
      }
    },
  }
}

export const browserProjectRecoveryStorage = createProjectRecoveryStorage()

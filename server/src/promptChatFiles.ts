import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isNotFound } from './promptChatValidation.js'

// Атомарная запись и очередь на ключ. Правило проекта: «прочитал-изменил-
// записал» ходит через очередь, иначе параллельные записи теряют друг друга
// (так однажды исчезала доска из индекса).
export const CHUNK_SIZE = 50
export const CHUNK_RE = /^\d{6}\.json$/

export const projectLocks = new Map<string, Promise<unknown>>()
export const conversationLocks = new Map<string, Promise<unknown>>()
export const requestLocks = new Map<string, Promise<unknown>>()

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.copyFile(file, `${file}.bak`).catch((error) => {
      if (!isNotFound(error)) throw error
    })
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(tmp, file)
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

export function withLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = locks.get(key) ?? Promise.resolve()
  const next = current.then(fn, fn)
  const settled = next.then(() => undefined, () => undefined)
  locks.set(key, settled)
  void settled.finally(() => {
    if (locks.get(key) === settled) locks.delete(key)
  })
  return next
}


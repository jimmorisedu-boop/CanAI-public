import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface RuntimeControlDocument {
  version: 1
  port: number
  pid: number
  instanceId: string
  shutdownToken: string
}

function parseControlDocument(value: unknown): RuntimeControlDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const document = value as Partial<RuntimeControlDocument>
  if (
    document.version !== 1 ||
    !Number.isInteger(document.port) ||
    !Number.isInteger(document.pid) ||
    typeof document.instanceId !== 'string' ||
    typeof document.shutdownToken !== 'string'
  ) {
    return null
  }
  return document as RuntimeControlDocument
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export class LifecycleManager {
  readonly instanceId = randomUUID()
  readonly shutdownToken = randomBytes(32).toString('base64url')
  private shutdownStarted = false

  constructor(
    private readonly controlFile: string,
    private readonly port: number,
    private readonly pid = process.pid,
  ) {}

  get shuttingDown(): boolean {
    return this.shutdownStarted
  }

  async publish(): Promise<void> {
    const document: RuntimeControlDocument = {
      version: 1,
      port: this.port,
      pid: this.pid,
      instanceId: this.instanceId,
      shutdownToken: this.shutdownToken,
    }
    await fs.mkdir(path.dirname(this.controlFile), { recursive: true })
    const tmp = `${this.controlFile}.${this.instanceId}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(document), 'utf8')
      await fs.rename(tmp, this.controlFile)
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }

  authorize(token: unknown): boolean {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return false
    return timingSafeEqual(tokenDigest(token), tokenDigest(this.shutdownToken))
  }

  beginShutdown(handler: () => Promise<void>): 'accepted' | 'already-started' {
    if (this.shutdownStarted) return 'already-started'
    this.shutdownStarted = true
    setImmediate(() => {
      void handler()
    })
    return 'accepted'
  }

  async removeControlIfOwned(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.controlFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    let document: RuntimeControlDocument | null = null
    try {
      document = parseControlDocument(JSON.parse(raw))
    } catch {
      return
    }
    if (document?.instanceId !== this.instanceId) return
    await fs.rm(this.controlFile, { force: true })
  }
}

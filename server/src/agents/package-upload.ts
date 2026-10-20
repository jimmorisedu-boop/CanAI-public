import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AgentPackageError } from './package-errors.js'

export const MAX_UPLOADED_PACKAGE_BYTES = 128 * 1024 * 1024
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/u
const SHA256_RE = /^[a-f0-9]{64}$/u
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_UPLOAD_STORE_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 2048
const MAX_REQUEST_ENTRIES = 4096

export interface ArchiveProvenance {
  name?: string
  version?: string
  author?: string
  build?: string
}

export interface ArchiveUpload {
  archiveId: string
  archiveSha: string
  sizeBytes: number
  provenance?: ArchiveProvenance
  createdAt: number
}

interface UploadDocument {
  version: 1
  archives: Record<string, ArchiveUpload>
  requests: Record<string, { fingerprint: string; response: ArchiveUpload; createdAt: number }>
}

function empty(): UploadDocument { return { version: 1, archives: {}, requests: {} } }
function digest(value: Buffer): string { return crypto.createHash('sha256').update(value).digest('hex') }
function text(value: unknown, max = 200): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function safeId(value: unknown): value is string { return typeof value === 'string' && ID_RE.test(value) && !RESERVED_KEYS.has(value) }
function invalidStore(): never { throw new AgentPackageError('UPLOAD_STORE_INVALID', 'ZIP upload storage is corrupt', 500) }

function storedProvenance(value: unknown): ArchiveProvenance | undefined {
  if (value === undefined) return undefined
  if (!record(value)) return invalidStore()
  const result: ArchiveProvenance = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'name' && key !== 'version' && key !== 'author' && key !== 'build') return invalidStore()
    if (!text(entry)) return invalidStore()
    result[key as keyof ArchiveProvenance] = entry
  }
  return Object.keys(result).length ? result : invalidStore()
}

function storedArchive(value: unknown, expectedId?: string): ArchiveUpload {
  if (!record(value)) return invalidStore()
  const archiveId = value.archiveId
  const archiveSha = value.archiveSha
  const sizeBytes = value.sizeBytes
  const createdAt = value.createdAt
  if (!safeId(archiveId) || (expectedId !== undefined && archiveId !== expectedId)) return invalidStore()
  if (typeof archiveSha !== 'string' || !SHA256_RE.test(archiveSha)) return invalidStore()
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_UPLOADED_PACKAGE_BYTES) return invalidStore()
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0) return invalidStore()
  const provenance = storedProvenance(value.provenance)
  const allowed = new Set(['archiveId', 'archiveSha', 'sizeBytes', 'createdAt', ...(provenance ? ['provenance'] : [])])
  if (Object.keys(value).some((key) => !allowed.has(key))) return invalidStore()
  return { archiveId, archiveSha, sizeBytes, ...(provenance ? { provenance } : {}), createdAt }
}

function sameArchive(left: ArchiveUpload, right: ArchiveUpload): boolean {
  return left.archiveId === right.archiveId && left.archiveSha === right.archiveSha && left.sizeBytes === right.sizeBytes
    && left.createdAt === right.createdAt && JSON.stringify(left.provenance ?? null) === JSON.stringify(right.provenance ?? null)
}

function parseDocument(value: unknown): UploadDocument {
  if (!record(value) || value.version !== 1 || !record(value.archives) || !record(value.requests)) return invalidStore()
  const archiveEntries = Object.entries(value.archives)
  const requestEntries = Object.entries(value.requests)
  if (archiveEntries.length > MAX_ARCHIVE_ENTRIES || requestEntries.length > MAX_REQUEST_ENTRIES) return invalidStore()
  const archives: Record<string, ArchiveUpload> = {}
  for (const [archiveId, entry] of archiveEntries) {
    if (!safeId(archiveId)) return invalidStore()
    archives[archiveId] = storedArchive(entry, archiveId)
  }
  const requests: UploadDocument['requests'] = {}
  for (const [requestId, entry] of requestEntries) {
    if (!safeId(requestId) || !record(entry) || typeof entry.fingerprint !== 'string' || !SHA256_RE.test(entry.fingerprint)
      || typeof entry.createdAt !== 'number' || !Number.isSafeInteger(entry.createdAt) || entry.createdAt <= 0) return invalidStore()
    const response = storedArchive(entry.response)
    const archive = archives[response.archiveId]
    if (!archive || !sameArchive(archive, response)) return invalidStore()
    const allowed = new Set(['fingerprint', 'response', 'createdAt'])
    if (Object.keys(entry).some((key) => !allowed.has(key))) return invalidStore()
    requests[requestId] = { fingerprint: entry.fingerprint, response, createdAt: entry.createdAt }
  }
  return { version: 1, archives, requests }
}

function normalizeProvenance(value: unknown): ArchiveProvenance | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentPackageError('SOURCE_INVALID', 'provenance must be an object')
  const source = value as Record<string, unknown>
  const result: ArchiveProvenance = {}
  for (const key of ['name', 'version', 'author', 'build'] as const) if (source[key] !== undefined) {
    if (!text(source[key])) throw new AgentPackageError('SOURCE_INVALID', `provenance.${key} is invalid`)
    result[key] = source[key] as string
  }
  return Object.keys(result).length ? result : undefined
}

async function atomicWrite(file: string, document: UploadDocument): Promise<void> {
  const temporary = `${file}.${process.pid}-${crypto.randomUUID()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  try { await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file) }
  finally { await fs.unlink(temporary).catch(() => undefined) }
}

export class AgentPackageUploadStore {
  private document = empty()
  private loaded = false
  private tail: Promise<void> = Promise.resolve()
  private readonly uploadsDir: string

  constructor(private readonly root: string) { this.uploadsDir = path.resolve(root, 'uploads') }

  async load(): Promise<void> { await this.serialized(async () => {
    this.document = await this.readDocument()
    this.loaded = true
  }) }

  async upload(requestId: string, archive: Buffer, provenance?: unknown): Promise<ArchiveUpload> {
    return this.serialized(async () => {
      if (!this.loaded) await this.loadUnlocked()
      if (!safeId(requestId)) throw new AgentPackageError('REQUEST_INVALID', 'requestId is invalid')
      if (!Buffer.isBuffer(archive) || archive.length === 0) throw new AgentPackageError('ARCHIVE_INVALID', 'ZIP upload is empty', 400)
      if (archive.length > MAX_UPLOADED_PACKAGE_BYTES) throw new AgentPackageError('ARCHIVE_TOO_LARGE', 'ZIP upload exceeds the limit', 413)
      const normalized = normalizeProvenance(provenance)
      const archiveSha = digest(archive)
      const fingerprint = digest(Buffer.from(JSON.stringify({ archiveSha, provenance: normalized ?? null })))
      const prior = this.document.requests[requestId]
      if (prior) { if (prior.fingerprint !== fingerprint) throw new AgentPackageError('REQUEST_REUSE', 'requestId was already used for another upload', 409); return prior.response }
      const archiveId = `upload-${crypto.randomUUID()}`
      const response: ArchiveUpload = { archiveId, archiveSha, sizeBytes: archive.length, ...(normalized ? { provenance: normalized } : {}), createdAt: Date.now() }
      await fs.mkdir(this.uploadsDir, { recursive: true })
      const file = this.fileFor(archiveId)
      const temporary = `${file}.${process.pid}-${crypto.randomUUID()}.tmp`
      try { await fs.writeFile(temporary, archive, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file) }
      finally { await fs.unlink(temporary).catch(() => undefined) }
      const next = structuredClone(this.document)
      next.archives[archiveId] = response
      next.requests[requestId] = { fingerprint, response, createdAt: Date.now() }
      try {
        await atomicWrite(path.resolve(this.root, 'uploads.json'), next)
      } catch (error) {
        // The binary and its receipt are one durable unit.  A failed receipt
        // write must not leave an unreferenced upload or an in-memory success
        // that a retry could replay as if it had been committed.
        await fs.unlink(file).catch(() => undefined)
        throw error
      }
      this.document = next
      return response
    })
  }

  async read(archiveId: string): Promise<{ metadata: ArchiveUpload; bytes: Buffer }> {
    return this.serialized(async () => {
      if (!this.loaded) await this.loadUnlocked()
      if (!safeId(archiveId)) throw new AgentPackageError('SOURCE_INVALID', 'archiveId is invalid')
      const metadata = this.document.archives[archiveId]
      if (!metadata || !SHA256_RE.test(metadata.archiveSha)) throw new AgentPackageError('ARCHIVE_NOT_FOUND', 'ZIP upload was not found', 404)
      const file = this.fileFor(archiveId)
      const stat = await fs.stat(file).catch(() => null)
      if (!stat?.isFile() || stat.size !== metadata.sizeBytes || stat.size > MAX_UPLOADED_PACKAGE_BYTES) throw new AgentPackageError('ARCHIVE_INTEGRITY_INVALID', 'Saved ZIP upload is corrupt', 409)
      const bytes = await fs.readFile(file)
      if (digest(bytes) !== metadata.archiveSha) throw new AgentPackageError('ARCHIVE_INTEGRITY_INVALID', 'Saved ZIP upload changed', 409)
      return { metadata, bytes }
    })
  }

  private fileFor(archiveId: string): string {
    const file = path.resolve(this.uploadsDir, `${archiveId}.zip`)
    if (!file.startsWith(`${this.uploadsDir}${path.sep}`)) throw new AgentPackageError('UPLOAD_PATH_INVALID', 'ZIP upload path is invalid', 500)
    return file
  }

  private async loadUnlocked(): Promise<void> {
    this.document = await this.readDocument()
    this.loaded = true
  }

  private async readDocument(): Promise<UploadDocument> {
    const file = path.resolve(this.root, 'uploads.json')
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size > MAX_UPLOAD_STORE_BYTES) return invalidStore()
      const raw = await fs.readFile(file, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > MAX_UPLOAD_STORE_BYTES) return invalidStore()
      try { return parseDocument(JSON.parse(raw) as unknown) }
      catch (error) { if (error instanceof AgentPackageError) throw error; return invalidStore() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return empty()
      if (error instanceof AgentPackageError) throw error
      return invalidStore()
    }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }
}

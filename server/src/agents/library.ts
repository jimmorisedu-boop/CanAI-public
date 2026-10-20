import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentPackageCheckView, AgentPackageInstallationView, AgentPackageSourceView } from '../../../packages/agent-protocol/index.js'
import type { ResolvedGitSource } from './package-source.js'
import type { PackageRuntimePin, PackageSourceView } from './packages.js'

export type InstallationStatus = 'ready' | 'disabled' | 'failed' | 'unsupported' | 'removed'

export type LibrarySource = PackageSourceView

export interface LibraryInstallation extends Omit<AgentPackageInstallationView, 'source' | 'runtime'> {
  rootRelative: string
  stateRelative: string
  permissions: string[]
  source: LibrarySource
  runtime: PackageRuntimePin
  trustConfirmed: true
}

export interface LibraryCheck extends Omit<AgentPackageCheckView, 'source'> {
  source: LibrarySource
  stagingRelative: string
  archiveSha: string
  treeSha: string
  createdAt: number
}

export interface LibraryRequestReceipt {
  action: string
  fingerprint: string
  response: unknown
  createdAt: number
}

export interface AgentLibraryDocument {
  version: 1
  revision: number
  installations: Record<string, LibraryInstallation>
  active: Record<string, string>
  checks: Record<string, LibraryCheck>
  requests: Record<string, LibraryRequestReceipt>
}

export interface LibraryTransactionResult<T> { value: T; revision: number }

function emptyDocument(): AgentLibraryDocument {
  return { version: 1, revision: 0, installations: {}, active: {}, checks: {}, requests: {} }
}

function clone<T>(value: T): T { return structuredClone(value) }

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SHA256_RE = /^[0-9a-f]{64}$/u
const SHA1_RE = /^[0-9a-f]{40}$/u
const SOURCE_RE = /^https:\/\/github\.com\/[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/u
const PACKAGE_ID_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u
const VERSION_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
}

function finiteTime(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }

function validSource(value: unknown): value is LibraryInstallation['source'] {
  const source = record(value)
  if (!source) return false
  if (source.kind === 'git') {
    if (typeof source.canonicalUrl !== 'string' || !SOURCE_RE.test(source.canonicalUrl)) return false
    if (!text(source.requestedRef, 256) || !SHA1_RE.test(String(source.resolvedSha))) return false
  } else if (source.kind === 'archive') {
    if (!ID_RE.test(String(source.archiveId)) || !SHA256_RE.test(String(source.archiveSha))) return false
    if (source.treeSha !== undefined && !SHA256_RE.test(String(source.treeSha))) return false
    if (source.provenance !== undefined && !record(source.provenance)) return false
  } else return false
  return source.subdir === undefined || (typeof source.subdir === 'string' && source.subdir.length <= 240 && !source.subdir.includes('\\') && !source.subdir.split('/').some((part) => !part || part === '.' || part === '..'))
}

function validRuntime(value: unknown): value is LibraryInstallation['runtime'] {
  const runtime = record(value)
  if (!runtime || !text(runtime.version, 64) || !text(runtime.integrity, 256) || !text(runtime.environmentId, 256)) return false
  // Older Node pins were written before the discriminant was persisted.  They
  // are safe to interpret as Node here and are normalized on the next load;
  // Python pins must keep their complete discriminated shape.
  if (runtime.kind === undefined || runtime.kind === 'node') return true
  return runtime.kind === 'python' && text(runtime.executableRelative, 240) && SHA256_RE.test(String(runtime.stdlibIntegrity)) && SHA256_RE.test(String(runtime.treeSha)) && SHA256_RE.test(String(runtime.archiveSha))
}

function validateInstallation(value: unknown, key: string): value is LibraryInstallation {
  const installation = record(value)
  if (!installation || installation.installationId !== key || !ID_RE.test(key) || !text(installation.packageId, 128) || !PACKAGE_ID_RE.test(installation.packageId) || !text(installation.version, 128) || !VERSION_RE.test(installation.version) || !SHA256_RE.test(String(installation.packageSha))) return false
  if (!validSource(installation.source) || !validRuntime(installation.runtime)) return false
  if (!['ready', 'disabled', 'failed', 'unsupported', 'removed'].includes(String(installation.status)) || typeof installation.active !== 'boolean') return false
  if (installation.rootRelative !== `agents/packages/${key}` || installation.stateRelative !== `agents/state/${key}`) return false
  if (!Array.isArray(installation.permissions) || installation.permissions.length > 32 || installation.permissions.some((permission) => !text(permission, 128))) return false
  return installation.trustConfirmed === true && finiteTime(installation.createdAt) && finiteTime(installation.updatedAt)
}

function validManifest(value: unknown): boolean {
  const manifest = record(value)
  const runtime = manifest && record(manifest.runtime)
  const lifecycle = manifest && record(manifest.lifecycle)
  return Boolean(manifest && text(manifest.id, 128) && PACKAGE_ID_RE.test(manifest.id) && text(manifest.version, 128) && VERSION_RE.test(manifest.version) && manifest.protocolVersion === '1.0' &&
    Array.isArray(manifest.taskTypes) && manifest.taskTypes.length > 0 && manifest.taskTypes.every((task) => {
      const item = record(task)
      return Boolean(item && text(item.id, 128) && text(item.label, 160) && text(item.description, 512) && Array.isArray(item.outputKinds) && item.outputKinds.every((kind) => text(kind, 64)))
    }) && Array.isArray(manifest.permissions) && manifest.permissions.every((permission) => text(permission, 128)) &&
    lifecycle && lifecycle.resume === true && lifecycle.cancel === true && (lifecycle.pause === 'checkpoint' || lifecycle.pause === 'immediate') &&
    runtime && (runtime.kind === 'node' || runtime.kind === 'python') && text(runtime.version, 64) && text(runtime.entrypoint, 256) && (runtime.dependencies === 'stdlib' || runtime.dependencies === 'lockfile'))
}

function validTrust(value: unknown): boolean {
  const trust = record(value)
  return Boolean(trust && trust.explicitTrustRequired === true && Array.isArray(trust.requiredPermissions) && trust.requiredPermissions.length <= 32 && trust.requiredPermissions.every((permission) => text(permission, 128)) && text(trust.disclaimer, 2_000))
}

function validateCheck(value: unknown, key: string): value is LibraryCheck {
  const check = record(value)
  if (!check || check.checkId !== key || !ID_RE.test(key) || !validSource(check.source) || !validManifest(check.manifest)) return false
  if (!SHA256_RE.test(String(check.packageSha)) || typeof check.supported !== 'boolean' || !Array.isArray(check.issues) || check.issues.length > 128 || !check.issues.every((issue) => {
    const item = record(issue)
    return Boolean(item && text(item.code, 128) && text(item.message, 2_000) && (item.path === undefined || text(item.path, 256)) && (item.severity === 'error' || item.severity === 'warning'))
  }) || !validTrust(check.trust)) return false
  if (check.stagingRelative !== `agents/staging/${key}` || !SHA256_RE.test(String(check.archiveSha)) || !SHA256_RE.test(String(check.treeSha)) || !finiteTime(check.createdAt)) return false
  return true
}

function validCheckReceipt(value: unknown): boolean {
  const check = record(value)
  return Boolean(check && ID_RE.test(String(check.checkId)) && validSource(check.source) && validManifest(check.manifest) && SHA256_RE.test(String(check.packageSha)) && typeof check.supported === 'boolean' && Array.isArray(check.issues) && validTrust(check.trust) && Number.isSafeInteger(check.revision) && Number(check.revision) >= 0)
}

function validateDocument(value: unknown): AgentLibraryDocument {
  const parsed = record(value)
  if (!parsed || parsed.version !== 1 || typeof parsed.revision !== 'number' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0) throw new Error('agent-library.json version invalid')
  const installations = record(parsed.installations)
  const active = record(parsed.active)
  const checks = record(parsed.checks)
  const requests = record(parsed.requests)
  if (!installations || !active || !checks || !requests) throw new Error('agent-library.json maps invalid')
  for (const [key, value] of Object.entries(installations)) if (!validateInstallation(value, key)) throw new Error('agent-library.json installation invalid')
  for (const [packageId, installationId] of Object.entries(active)) {
    if (!text(packageId, 128) || typeof installationId !== 'string' || !validateInstallation(installations[installationId], installationId) || installations[installationId].packageId !== packageId || installations[installationId].status !== 'ready' || installations[installationId].active !== true) throw new Error('agent-library.json active pointer invalid')
  }
  for (const [key, value] of Object.entries(checks)) if (!validateCheck(value, key)) throw new Error('agent-library.json check invalid')
  for (const [key, value] of Object.entries(requests)) {
    const request = record(value)
    if (!ID_RE.test(key) || !request || !['check', 'install', 'update', 'enable', 'disable', 'rollback', 'remove'].includes(String(request.action)) || !SHA256_RE.test(String(request.fingerprint)) || !finiteTime(request.createdAt) || request.response === undefined) throw new Error('agent-library.json request invalid')
    if (request.action === 'check' && !validCheckReceipt(request.response)) throw new Error('agent-library.json check receipt invalid')
    if (request.action !== 'check') {
      const response = record(request.response)
      if (!response || !validateInstallation(response, String(response.installationId)) || !Number.isSafeInteger(response.revision) || Number(response.revision) < 0) throw new Error('agent-library.json installation receipt invalid')
    }
  }
  return { version: 1, revision: parsed.revision, installations: installations as Record<string, LibraryInstallation>, active: active as Record<string, string>, checks: checks as Record<string, LibraryCheck>, requests: requests as Record<string, LibraryRequestReceipt> }
}

function migrateLegacyNodeRuntimePins(document: AgentLibraryDocument): { document: AgentLibraryDocument; changed: boolean } {
  const migrated = clone(document)
  let changed = false
  const normalize = (value: unknown): void => {
    const installation = record(value)
    const runtime = installation && record(installation.runtime)
    if (!runtime || runtime.kind !== undefined) return
    installation.runtime = { kind: 'node', version: runtime.version, integrity: runtime.integrity, environmentId: runtime.environmentId }
    changed = true
  }
  for (const installation of Object.values(migrated.installations)) normalize(installation)
  for (const request of Object.values(migrated.requests)) if (request.action !== 'check') normalize(request.response)
  return { document: migrated, changed }
}

function fingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)).digest('hex')
}

async function writeAtomic(file: string, document: AgentLibraryDocument): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}-${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, file)
  } finally { await fs.unlink(temporary).catch(() => undefined) }
}

export class AgentPackageLibrary {
  private document = emptyDocument()
  private loaded = false
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    await this.serialized(() => this.loadUnlocked())
  }

  private async loadUnlocked(): Promise<void> {
    try {
      const stat = await fs.stat(this.file)
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('agent-library.json exceeds limit')
      const loaded = validateDocument(JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown)
      const migration = migrateLegacyNodeRuntimePins(loaded)
      this.document = migration.document
      if (migration.changed) await writeAtomic(this.file, this.document)
    } catch (error) {
      if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== 'ENOENT') throw new Error('agent-library.json is corrupt')
      this.document = emptyDocument()
    }
    this.loaded = true
  }

  isLoaded(): boolean { return this.loaded }
  snapshot(): AgentLibraryDocument { return clone(this.document) }
  currentRevision(): number { return this.document.revision }

  async transaction<T>(expectedRevision: number | undefined, operation: (draft: AgentLibraryDocument, nextRevision: number) => Promise<T> | T): Promise<LibraryTransactionResult<T>> {
    return this.serialized(() => this.transactionUnlocked(expectedRevision, operation))
  }

  async transactionUnlocked<T>(expectedRevision: number | undefined, operation: (draft: AgentLibraryDocument, nextRevision: number) => Promise<T> | T): Promise<LibraryTransactionResult<T>> {
    if (!this.loaded) await this.loadUnlocked()
    if (expectedRevision !== undefined && expectedRevision !== this.document.revision) throw new Error('LIBRARY_REVISION_STALE')
    const draft = clone(this.document)
    const nextRevision = this.document.revision + 1
    const value = await operation(draft, nextRevision)
    draft.revision = nextRevision
    await writeAtomic(this.file, draft)
    this.document = draft
    return { value, revision: nextRevision }
  }

  async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  static fingerprint(value: unknown): string { return fingerprint(value) }

  static sourceView(source: ResolvedGitSource): LibraryInstallation['source'] {
    return {
      kind: 'git', canonicalUrl: source.canonicalUrl, requestedRef: source.requestedRef, resolvedSha: source.resolvedSha,
      ...(source.subdir ? { subdir: source.subdir } : {}),
    }
  }

  static archiveSourceView(input: { archiveId: string; archiveSha: string; treeSha?: string; subdir?: string; provenance?: Record<string, string> }): LibraryInstallation['source'] {
    return { kind: 'archive', archiveId: input.archiveId, archiveSha: input.archiveSha, ...(input.treeSha ? { treeSha: input.treeSha } : {}), ...(input.subdir ? { subdir: input.subdir } : {}), ...(input.provenance ? { provenance: input.provenance } : {}) }
  }
}

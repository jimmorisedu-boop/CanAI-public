import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { AgentInputSchemaView, AgentPackageSourceView, AgentPackageSummary } from '../../../packages/agent-protocol/index.js'
import { serverRootDir } from '../config.js'
import { AgentProtocolError, AgentProtocolValidator } from './validation.js'
import { packageTreeIntegrity } from './package-archive.js'
import type { PythonRuntimeMetadata } from './python-runtime.js'

export type PackageSourceView = AgentPackageSourceView | (Omit<AgentPackageSourceView, 'kind'> & { kind: 'archive'; archiveId: string; archiveSha?: string; treeSha?: string; provenance?: Record<string, string> })
export type PackageRuntimePin = { kind: 'node'; version: string; integrity: string; environmentId: string } | (PythonRuntimeMetadata & { archiveSha: string })

export interface AgentManifest {
  schemaVersion: 1
  id: string
  name: string
  description: string
  version: string
  protocolVersion: '1.0'
  runtime: {
    kind: 'node' | 'python'
    version: string
    entrypoint: { kind: 'file'; path: string } | { kind: 'module'; module: string }
    dependencies: { kind: 'stdlib' } | { kind: 'lockfile'; path: string }
    maxParallelTasks: number
  }
  taskTypes: Array<{
    id: string
    label: string
    description: string
    inputSchema: string
    outputKinds: string[]
    generation?: { kinds: Array<'image' | 'video' | 'audio'>; maxCalls: number }
    llmCalls?: number
  }>
  permissions: string[]
  connections: Array<{ id: string; label: string; kind: string; required: boolean }>
  lifecycle: { pause: 'checkpoint' | 'immediate'; resume: true; cancel: true }
}

export interface AgentPackage {
  root: string
  manifest: AgentManifest
  packageSha: string
  entrypoint: string
  entrypointKind: 'file' | 'module'
  entrypointModule?: string
  handshake: 'ready' | 'failed'
  handshakeError?: string
  inputValidators: Map<string, ValidateFunction>
  inputSchemaViews?: Map<string, AgentInputSchemaView>
  installationId?: string
  status?: 'ready' | 'disabled' | 'failed' | 'unsupported'
  active?: boolean
  source?: PackageSourceView
  runtime?: PackageRuntimePin
}

function sha256(values: Buffer[]): string {
  const hash = crypto.createHash('sha256')
  for (const value of values) hash.update(value)
  return hash.digest('hex')
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new AgentProtocolError('MANIFEST_INVALID', `${label} is missing`)
  return value
}

export function normalizeManifest(raw: Record<string, unknown>): AgentManifest {
  const runtime = raw.runtime as Record<string, unknown>
  const entrypoint = runtime.entrypoint as Record<string, unknown>
  const dependencies = runtime.dependencies as Record<string, unknown>
  const taskTypes = Array.isArray(raw.taskTypes) ? raw.taskTypes : []
  return {
    schemaVersion: 1,
    id: string(raw.id, 'id'),
    name: string(raw.name, 'name'),
    description: string(raw.description, 'description'),
    version: string(raw.version, 'version'),
    protocolVersion: '1.0',
    runtime: {
      kind: runtime.kind as AgentManifest['runtime']['kind'],
      version: string(runtime.version, 'runtime.version'),
      entrypoint: entrypoint.kind === 'file'
        ? { kind: 'file', path: string(entrypoint.path, 'runtime.entrypoint.path') }
        : { kind: 'module', module: string(entrypoint.module, 'runtime.entrypoint.module') },
      dependencies: dependencies.kind === 'stdlib'
        ? { kind: 'stdlib' }
        : { kind: 'lockfile', path: string(dependencies.path, 'runtime.dependencies.path') },
      maxParallelTasks: Number(runtime.maxParallelTasks),
    },
    taskTypes: taskTypes.map((task) => {
      const value = task as Record<string, unknown>
      const generationRaw = value.generation && typeof value.generation === 'object' ? value.generation as Record<string, unknown> : undefined
      const generation = generationRaw && Array.isArray(generationRaw.kinds) && typeof generationRaw.maxCalls === 'number'
        ? {
            kinds: generationRaw.kinds.map(String) as Array<'image' | 'video' | 'audio'>,
            maxCalls: Number(generationRaw.maxCalls),
          }
        : undefined
      const llmCalls = typeof value.llmCalls === 'number' ? Number(value.llmCalls) : undefined
      return {
        id: string(value.id, 'taskTypes.id'),
        label: string(value.label, 'taskTypes.label'),
        description: string(value.description, 'taskTypes.description'),
        inputSchema: string(value.inputSchema, 'taskTypes.inputSchema'),
        outputKinds: Array.isArray(value.outputKinds) ? value.outputKinds.map(String) : [],
        ...(generation ? { generation } : {}),
        ...(typeof llmCalls === 'number' ? { llmCalls } : {}),
      }
    }),
    permissions: Array.isArray(raw.permissions) ? raw.permissions.map(String) : [],
    connections: Array.isArray(raw.connections) ? raw.connections.map((value) => {
      const entry = value as Record<string, unknown>
      return { id: string(entry.id, 'connections.id'), label: string(entry.label, 'connections.label'), kind: String(entry.kind), required: entry.required === true }
    }) : [],
    lifecycle: raw.lifecycle as AgentManifest['lifecycle'],
  }
}

export class AgentPackageRegistry {
  private readonly packages = new Map<string, AgentPackage>()
  private readonly installations = new Map<string, AgentPackage>()
  private readonly inputAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })

  constructor(
    private readonly validator = new AgentProtocolValidator(),
    private readonly bundledRoot = path.join(serverRootDir, 'src', 'agents', 'bundled'),
  ) { addFormats(this.inputAjv) }

  async loadBundled(): Promise<void> {
    this.packages.clear()
    this.installations.clear()
    const entries = await fs.readdir(this.bundledRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const root = path.join(this.bundledRoot, entry.name)
      const manifestPath = path.join(root, 'canai.agent.json')
      try {
        const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown
        const validated = this.validator.assertManifest(raw)
        const manifest = normalizeManifest(validated)
        const entrypoint = manifest.runtime.entrypoint.kind === 'file'
          ? path.resolve(root, manifest.runtime.entrypoint.path)
          : ''
        if (entrypoint && !entrypoint.startsWith(`${path.resolve(root)}${path.sep}`)) {
          throw new AgentProtocolError('MANIFEST_INVALID', 'entrypoint is outside the package')
        }
        const inputValidators = new Map<string, ValidateFunction>()
        const inputSchemaViews = new Map<string, AgentInputSchemaView>()
        for (const taskType of manifest.taskTypes) {
          const schemaPath = path.resolve(root, taskType.inputSchema)
          if (!schemaPath.startsWith(`${path.resolve(root)}${path.sep}`)) throw new AgentProtocolError('MANIFEST_INVALID', 'inputSchema is outside the package')
          const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8')) as object
          inputValidators.set(taskType.id, this.inputAjv.compile(schema))
          const { formForSchema } = await import('./package-check.js')
          const form = formForSchema(schema)
          if (form) inputSchemaViews.set(taskType.id, form)
        }
        const bytes = [Buffer.from(JSON.stringify(raw)), ...(entrypoint ? [await fs.readFile(entrypoint)] : [])]
        for (const taskType of manifest.taskTypes) bytes.push(await fs.readFile(path.resolve(root, taskType.inputSchema)))
        const pkg: AgentPackage = {
          root,
          manifest,
          packageSha: sha256(bytes), entrypointKind: manifest.runtime.entrypoint.kind,
          entrypoint,
          handshake: entrypoint ? 'ready' : 'failed',
          ...(entrypoint ? {} : { handshakeError: 'Node package must have a file entrypoint' }),
          inputValidators,
          inputSchemaViews,
          active: true,
        }
        if (this.packages.has(manifest.id)) throw new AgentProtocolError('MANIFEST_INVALID', `Duplicate package ID: ${manifest.id}`)
        this.packages.set(manifest.id, pkg)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const fallbackId = `invalid.${entry.name}`
        this.packages.set(fallbackId, {
          root,
          manifest: {
            schemaVersion: 1,
            id: fallbackId,
            name: entry.name,
            description: 'Invalid agent package',
            version: '0.0.0',
            protocolVersion: '1.0',
            runtime: { kind: 'node', version: '20.0', entrypoint: { kind: 'file', path: '' }, dependencies: { kind: 'stdlib' }, maxParallelTasks: 1 },
            taskTypes: [], permissions: [], connections: [], lifecycle: { pause: 'checkpoint', resume: true, cancel: true },
          },
          packageSha: '', entrypoint: '', entrypointKind: 'file', handshake: 'failed', handshakeError: message,
          inputValidators: new Map(), status: 'failed',
          active: false,
        })
      }
    }
  }

  async registerInstalled(input: {
    installationId: string
    root: string
    packageSha: string
    status: 'ready' | 'disabled'
    source: PackageSourceView
    runtime: PackageRuntimePin
    inputSchemaViews?: Map<string, AgentInputSchemaView>
    active?: boolean
  }): Promise<AgentPackage> {
    const loaded = await this.loadRoot(input.root)
    const tree = await packageTreeIntegrity(input.root)
    if (tree.packageSha !== input.packageSha) throw new AgentProtocolError('PACKAGE_INTEGRITY_INVALID', 'Installed packageSha does not match the file tree')
    const pkg = { ...loaded, packageSha: input.packageSha, installationId: input.installationId, status: input.status, source: input.source, runtime: input.runtime, inputSchemaViews: input.inputSchemaViews, active: input.status === 'ready' && input.active !== false }
    this.installations.set(input.installationId, pkg)
    if (input.status === 'ready' && input.active !== false) this.packages.set(pkg.manifest.id, pkg)
    return pkg
  }

  async loadInstalled(records: Array<{
    installationId: string
    root: string
    packageSha: string
    status: 'ready' | 'disabled'
    source: PackageSourceView
    runtime: PackageRuntimePin
    active?: boolean
  }>): Promise<void> {
    for (const record of records) {
      try { await this.registerInstalled(record) }
      catch { /* A failed persisted installation is not made active on restore. */ }
    }
  }

  setActive(packageId: string, installationId?: string): void {
    if (!installationId) { this.packages.delete(packageId); return }
    const pkg = this.installations.get(installationId)
    if (!pkg || pkg.manifest.id !== packageId) throw new AgentProtocolError('PACKAGE_NOT_FOUND', 'Package installation was not found')
    pkg.status = 'ready'
    pkg.active = true
    this.packages.set(packageId, pkg)
  }

  setDisabled(packageId: string, installationId: string): void {
    const pkg = this.installations.get(installationId)
    if (!pkg || pkg.manifest.id !== packageId) throw new AgentProtocolError('PACKAGE_NOT_FOUND', 'Package installation was not found')
    pkg.status = 'disabled'
    pkg.active = false
    if (this.packages.get(packageId)?.installationId === installationId) this.packages.delete(packageId)
  }

  removeInstallation(installationId: string): void {
    const pkg = this.installations.get(installationId)
    if (!pkg) return
    if (this.packages.get(pkg.manifest.id)?.installationId === installationId) this.packages.delete(pkg.manifest.id)
    this.installations.delete(installationId)
  }

  list(): AgentPackage[] { return [...this.packages.values()] }

  getInstallation(installationId: string): AgentPackage | undefined { return this.installations.get(installationId) }

  get(id: string): AgentPackage {
    const pkg = this.packages.get(id)
    if (!pkg) throw new AgentProtocolError('INPUT_INVALID', `Package ${id} not found`)
    if (pkg.handshake !== 'ready') throw new AgentProtocolError('PROTOCOL_UNSUPPORTED', pkg.handshakeError ?? 'Package is not ready')
    return pkg
  }

  getPinned(task: { packageId: string; packageVersion: string; packageSha: string; installationId?: string }): AgentPackage {
    const candidate = task.installationId ? this.installations.get(task.installationId) : this.packages.get(task.packageId)
    const fallback = candidate ?? [...this.installations.values()].find((pkg) => pkg.manifest.id === task.packageId && pkg.manifest.version === task.packageVersion && pkg.packageSha === task.packageSha)
    if (!fallback || fallback.manifest.id !== task.packageId || fallback.manifest.version !== task.packageVersion || fallback.packageSha !== task.packageSha || fallback.handshake !== 'ready') {
      throw new AgentProtocolError('PACKAGE_PIN_MISMATCH', 'Pinned agent package version is no longer available')
    }
    return fallback
  }

  assertTaskInput(pkg: AgentPackage, taskType: string, input: Record<string, unknown>): void {
    const validate = pkg.inputValidators.get(taskType)
    if (!validate) throw new AgentProtocolError('INPUT_INVALID', `Input schema for ${taskType} was not loaded`)
    if (!validate(input)) throw new AgentProtocolError('INPUT_INVALID', `input does not pass schema ${taskType}: ${(validate.errors ?? []).map((error) => error.message).join('; ')}`)
  }

  summary(pkg: AgentPackage): AgentPackageSummary {
    return {
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      description: pkg.manifest.description,
      version: pkg.manifest.version,
      packageSha: pkg.packageSha,
      protocolVersion: pkg.manifest.protocolVersion,
      taskTypes: pkg.manifest.taskTypes.map(({ id, label, description, outputKinds, generation, llmCalls }) => ({
        id, label, description, outputKinds,
        ...(generation ? { generation: { kinds: [...generation.kinds], maxCalls: generation.maxCalls } } : {}),
        ...(typeof llmCalls === 'number' ? { llmCalls } : {}),
        ...(pkg.inputSchemaViews?.get(id) ? { inputSchema: pkg.inputSchemaViews.get(id) } : {}),
      })),
      permissions: [...pkg.manifest.permissions],
      lifecycle: pkg.manifest.lifecycle,
      handshake: pkg.handshake,
      ...(pkg.handshakeError ? { handshakeError: pkg.handshakeError } : {}),
      ...(pkg.installationId ? { installationId: pkg.installationId } : {}),
      ...(pkg.status ? { status: pkg.status } : {}),
      ...(pkg.installationId ? { active: pkg.active === true } : { active: true }),
      ...(pkg.source ? { source: pkg.source } : {}),
      ...(pkg.runtime ? { runtime: pkg.runtime } : {}),
    } as AgentPackageSummary
  }

  private async loadRoot(root: string): Promise<AgentPackage> {
    const manifestPath = path.join(root, 'canai.agent.json')
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown
    const manifest = normalizeManifest(this.validator.assertManifest(raw))
    const entrypoint = manifest.runtime.entrypoint.kind === 'file'
      ? path.resolve(root, manifest.runtime.entrypoint.path)
      : path.resolve(root, manifest.runtime.entrypoint.module.replace(/\./gu, path.sep), '__main__.py')
    if (entrypoint && !entrypoint.startsWith(`${path.resolve(root)}${path.sep}`)) throw new AgentProtocolError('MANIFEST_INVALID', 'entrypoint is outside the package')
    const inputValidators = new Map<string, ValidateFunction>()
    for (const taskType of manifest.taskTypes) {
      const schemaPath = path.resolve(root, taskType.inputSchema)
      if (!schemaPath.startsWith(`${path.resolve(root)}${path.sep}`)) throw new AgentProtocolError('MANIFEST_INVALID', 'inputSchema is outside the package')
      const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8')) as object
      inputValidators.set(taskType.id, this.inputAjv.compile(schema))
    }
    const bytes = [Buffer.from(JSON.stringify(raw)), ...(entrypoint ? [await fs.readFile(entrypoint)] : [])]
    for (const taskType of manifest.taskTypes) bytes.push(await fs.readFile(path.resolve(root, taskType.inputSchema)))
    return { root, manifest, packageSha: sha256(bytes), entrypoint, entrypointKind: manifest.runtime.entrypoint.kind, ...(manifest.runtime.entrypoint.kind === 'module' ? { entrypointModule: manifest.runtime.entrypoint.module } : {}), handshake: entrypoint ? 'ready' : 'failed', ...(entrypoint ? {} : { handshakeError: 'Package entrypoint was not found' }), inputValidators }
  }
}

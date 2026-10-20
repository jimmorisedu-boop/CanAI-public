import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentPackageCheckRequest, AgentPackageCheckView, AgentPackageInstallRequest, AgentPackageInstallationView,
  AgentPackageLibraryView, AgentPackageManageRequest, AgentPackageSummary,
} from '../../../packages/agent-protocol/index.js'
import { AgentPackageError } from './package-errors.js'
import { packageTreeIntegrity } from './package-archive.js'
import { checkPackage, supportedPackage, type RuntimeMetadata } from './package-check.js'
import { AgentPackageLibrary, type LibraryInstallation } from './library.js'
import { AgentPackageRegistry } from './packages.js'
import type { GitSourceTransport } from './package-source.js'
import { createDefaultPackageProbe, type PackageProbeRunner } from './package-probe.js'
import { detectRuntimeMetadata, inspectPythonRuntime, installPythonRuntime, type PythonRuntimeMetadata } from './package-runtime.js'
import { AgentProtocolValidator } from './validation.js'
import { AgentPackageUploadStore } from './package-upload.js'
import { managePackage } from './package-manager-manage.js'
import { checkPackageSource } from './package-manager-check.js'
import {
  archiveSourceView,
  checkedCapabilities,
  launchFor,
  packageRoot,
  runtimePin,
  sameRuntimePin,
  sourceIdentity,
  sourceView,
} from './package-manager-support.js'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/u

export interface PackageManagerOptions {
  library: AgentPackageLibrary
  registry: AgentPackageRegistry
  source: GitSourceTransport
  validator?: AgentProtocolValidator
  packageRoot: string
  stateRoot: string
  stagingRoot: string
  runtime?: RuntimeMetadata
  pythonRuntime?: PythonRuntimeMetadata
  runtimeDir?: string
  uploads?: AgentPackageUploadStore
  probe?: PackageProbeRunner
  /** Injectable only for isolated tests; production re-hashes the live runtime. */
  runtimeDetector?: () => Promise<RuntimeMetadata>
  /** Injectable only for isolated tests; production re-verifies the portable tree. */
  pythonRuntimeInspector?: (runtimeDir: string) => Promise<Awaited<ReturnType<typeof inspectPythonRuntime>>>
  activeTaskPins?: () => Promise<Set<string>> | Set<string>
  packageLifecycleLock?: <T>(operation: () => Promise<T>) => Promise<T>
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new AgentPackageError('REQUEST_INVALID', `${label} is invalid`)
  return value
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...new Set(left)].length === left.length && left.every((value) => right.includes(value))
}

export class AgentPackageManager {
  private runtime: RuntimeMetadata | undefined
  private pythonRuntime: PythonRuntimeMetadata | undefined
  private readonly probe: PackageProbeRunner
  private initialized = false

  constructor(private readonly options: PackageManagerOptions) {
    this.runtime = options.runtime
    this.pythonRuntime = options.pythonRuntime
    this.probe = options.probe ?? createDefaultPackageProbe(options.validator)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.options.library.load()
    await this.options.uploads?.load()
    this.runtime ??= await (this.options.runtimeDetector?.() ?? detectRuntimeMetadata())
    if (!this.pythonRuntime && this.options.runtimeDir) {
      const status = await this.inspectPortablePython(this.options.runtimeDir)
      if (status.ready) this.pythonRuntime = status.runtime
    }
    await fs.mkdir(this.options.packageRoot, { recursive: true })
    await fs.mkdir(this.options.stateRoot, { recursive: true })
    const document = this.options.library.snapshot()
    const failed: string[] = []
    for (const record of Object.values(document.installations)) {
      if (record.status !== 'ready' && record.status !== 'disabled') continue
      try {
        const runtime = this.runtimeForKind(record.runtime.kind)
        if (!runtime || !sameRuntimePin(runtime, record.runtime)) throw new AgentPackageError('RUNTIME_PIN_MISMATCH', 'Installation requires a different exact portable runtime', 409)
        const root = this.persistedPackageRoot(record.rootRelative)
        const checked = await checkPackage(root, this.options.validator ?? new AgentProtocolValidator(), runtime)
        if (checked.packageSha !== record.packageSha || checked.manifest.id !== record.packageId || checked.manifest.version !== record.version || !supportedPackage(checked)) throw new AgentPackageError('PACKAGE_INTEGRITY_INVALID', 'Saved installation fails the integrity check', 409)
        const views = new Map(checked.manifestView.taskTypes.flatMap((task) => task.inputSchema ? [[task.id, task.inputSchema] as const] : []))
        await this.options.registry.registerInstalled({ installationId: record.installationId, root, packageSha: record.packageSha, status: record.status, source: record.source, runtime: record.runtime, inputSchemaViews: views, active: record.active && document.active[record.packageId] === record.installationId })
      } catch { failed.push(record.installationId) }
    }
    if (failed.length) {
      await this.options.library.transactionUnlocked(document.revision, (draft) => {
        for (const installationId of failed) {
          const record = draft.installations[installationId]
          if (!record) continue
          record.status = 'failed'
          record.active = false
          if (draft.active[record.packageId] === installationId) delete draft.active[record.packageId]
        }
      })
    }
    this.initialized = true
  }

  async list(): Promise<AgentPackageLibraryView> {
    await this.initialize()
    const document = this.options.library.snapshot()
    const active = this.options.registry.list().map((pkg) => {
      const summary = this.options.registry.summary(pkg)
      return pkg.installationId
        ? { ...summary, active: document.active[pkg.manifest.id] === pkg.installationId }
        : { ...summary, active: true }
    })
    const packages = [...active]
    for (const record of Object.values(document.installations)) {
      if (record.status === 'removed' || record.status === 'failed' || record.status === 'unsupported' || record.active) continue
      const pkg = this.options.registry.getInstallation(record.installationId)
      if (pkg) packages.push({ ...this.options.registry.summary(pkg), active: document.active[record.packageId] === record.installationId })
    }
    return { revision: document.revision, packages, installations: Object.values(document.installations).map((record) => ({ ...record })) }
  }

  async uploadArchive(requestId: string, archive: Buffer, provenance?: unknown): Promise<Awaited<ReturnType<AgentPackageUploadStore['upload']>>> {
    await this.initialize()
    if (!this.options.uploads) throw new AgentPackageError('PACKAGE_MANAGER_UNAVAILABLE', 'ZIP upload storage is unavailable', 503)
    return this.options.uploads.upload(requestId, archive, provenance)
  }

  async runtimeStatus(): Promise<ReturnType<typeof inspectPythonRuntime>> {
    await this.initialize()
    if (!this.options.runtimeDir) return { supported: false, ready: false, version: '3.13.16', rootRelative: '', reason: 'Portable runtime directory is not configured' }
    return this.inspectPortablePython(this.options.runtimeDir)
  }

  async installPythonRuntime(): Promise<PythonRuntimeMetadata> {
    await this.initialize()
    if (!this.options.runtimeDir) throw new AgentPackageError('RUNTIME_NOT_CONFIGURED', 'Portable runtime directory is not configured', 503)
    const runtime = await installPythonRuntime({ runtimeDir: this.options.runtimeDir })
    this.pythonRuntime = runtime
    return runtime
  }

  private runtimeForKind(kind: 'node' | 'python'): RuntimeMetadata | PythonRuntimeMetadata | undefined {
    return kind === 'python' ? this.pythonRuntime : this.runtime
  }

  private async inspectPortablePython(runtimeDir: string): Promise<Awaited<ReturnType<typeof inspectPythonRuntime>>> {
    return this.options.pythonRuntimeInspector?.(runtimeDir) ?? inspectPythonRuntime(runtimeDir)
  }

  private async freshRuntimeForKind(kind: 'node' | 'python'): Promise<RuntimeMetadata | PythonRuntimeMetadata> {
    if (kind === 'node') {
      const live = await (this.options.runtimeDetector?.() ?? detectRuntimeMetadata())
      if (!this.runtime || !sameRuntimePin(live, runtimePin(this.runtime))) {
        throw new AgentPackageError('RUNTIME_PIN_MISMATCH', 'Node runtime changed after check; install stopped before probe', 409)
      }
      return live
    }
    if (!this.options.runtimeDir) throw new AgentPackageError('RUNTIME_NOT_READY', 'Portable Python runtime is not configured', 422)
    const status = await this.inspectPortablePython(this.options.runtimeDir)
    if (!status.ready || !status.runtime) throw new AgentPackageError('RUNTIME_NOT_READY', status.reason ?? 'Portable Python runtime failed the recheck', 422)
    if (!this.pythonRuntime || !sameRuntimePin(status.runtime, runtimePin(this.pythonRuntime))) {
      throw new AgentPackageError('RUNTIME_PIN_MISMATCH', 'Portable Python runtime changed after check; install stopped before probe', 409)
    }
    return status.runtime
  }

  private async checkWithRuntime(root: string, preferredRuntime?: RuntimeMetadata | PythonRuntimeMetadata): Promise<Awaited<ReturnType<typeof checkPackage>>> {
    const validator = this.options.validator ?? new AgentProtocolValidator()
    let checked = await checkPackage(root, validator, preferredRuntime ?? this.runtime)
    if (!preferredRuntime && checked.manifest.runtime.kind === 'python' && this.pythonRuntime) checked = await checkPackage(root, validator, this.pythonRuntime)
    return checked
  }

  async check(input: AgentPackageCheckRequest): Promise<AgentPackageCheckView> {
    await this.initialize()
    return checkPackageSource(input, {
      library: this.options.library,
      source: this.options.source,
      stagingRoot: this.options.stagingRoot,
      uploads: this.options.uploads,
      checkWithRuntime: (root) => this.checkWithRuntime(root),
    })
  }

  async install(input: AgentPackageInstallRequest): Promise<AgentPackageInstallationView & { revision: number }> {
    await this.initialize()
    return this.options.library.serialized(async () => {
      const requestId = id(input.requestId, 'requestId')
      const checkId = id(input.checkId, 'checkId')
      const fingerprint = AgentPackageLibrary.fingerprint({ action: 'install', input })
      const document = this.options.library.snapshot()
      const priorReceipt = document.requests[requestId]
      if (priorReceipt) {
        if (priorReceipt.action !== 'install' || priorReceipt.fingerprint !== fingerprint) throw new AgentPackageError('REQUEST_REUSE', 'requestId was already used for another install', 409)
        return priorReceipt.response as AgentPackageInstallationView & { revision: number }
      }
      if (input.expectedRevision !== document.revision) throw new AgentPackageError('LIBRARY_REVISION_STALE', 'Library revision is stale', 409)
      const check = document.checks[checkId]
      if (!check) throw new AgentPackageError('CHECK_NOT_FOUND', 'Check result was not found', 404)
      if (!check.supported) throw new AgentPackageError('PACKAGE_UNSUPPORTED', 'Package does not pass the supported subset; see issues', 422)
      if (input.trustConfirmed !== true || !Array.isArray(input.approvedPermissions) || input.approvedPermissions.some((permission) => typeof permission !== 'string') || !sameSet(input.approvedPermissions, check.trust.requiredPermissions)) throw new AgentPackageError('TRUST_REQUIRED', 'Explicit confirmation of exactly the requested permissions is required', 403)
      const existing = Object.values(document.installations).filter((record) => record.packageId === check.manifest.id && record.status !== 'removed')
      const bundled = this.options.registry.list().some((pkg) => pkg.manifest.id === check.manifest.id && !pkg.installationId)
      const previous = input.priorInstallationId ? document.installations[input.priorInstallationId] : undefined
      if (input.priorInstallationId && (!previous || previous.packageId !== check.manifest.id)) throw new AgentPackageError('SOURCE_TAKEOVER_DENIED', 'priorInstallationId does not belong to this package ID', 409)
      if (!input.priorInstallationId && (bundled || existing.length > 0)) throw new AgentPackageError('SOURCE_TAKEOVER_DENIED', 'An existing package ID requires a matching priorInstallationId', 409)
      if (previous && sourceIdentity(previous.source) !== sourceIdentity(check.source)) {
        // An archive has no stable remote origin.  A new immutable upload may
        // replace an older archive only through the explicit prior-installation
        // update flow; it can never silently take over a Git-origin package.
        const explicitArchiveUpdate = previous.source.kind === 'archive' && check.source.kind === 'archive' && input.priorInstallationId === previous.installationId
        if (!explicitArchiveUpdate) throw new AgentPackageError('SOURCE_TAKEOVER_DENIED', 'Source package ID cannot be changed', 409)
      }
      const staging = path.resolve(this.dataRoot(), check.stagingRelative)
      const preliminary = await this.checkWithRuntime(staging)
      if (preliminary.packageSha !== check.packageSha || !supportedPackage(preliminary)) throw new AgentPackageError('STAGING_CHANGED', 'Staging package changed after check', 409)
      // The check receipt may be old by the time install starts. Re-read the
      // live runtime tree/executable metadata before constructing any probe
      // launch. A mismatch is terminal for this install; never refresh the
      // cached pin and continue with an executable probe.
      const runtime = await this.freshRuntimeForKind(preliminary.manifest.runtime.kind)
      const checked = await this.checkWithRuntime(staging, runtime)
      if (checked.packageSha !== check.packageSha || !supportedPackage(checked)) throw new AgentPackageError('STAGING_CHANGED', 'Staging package changed after check', 409)
      const installationId = `install-${randomUUID()}`
      const probeWorkspace = path.resolve(this.options.stagingRoot, `probe-${installationId}`)
      await this.probe(
        { root: staging, entrypoint: checked.entrypoint, installationId, workspace: probeWorkspace, expectedCapabilities: checkedCapabilities(checked.manifest), launch: launchFor(checked, runtime, this.options.runtimeDir) },
      )
      const afterProbe = await packageTreeIntegrity(staging)
      if (afterProbe.packageSha !== check.packageSha) throw new AgentPackageError('STAGING_CHANGED', 'Probe changed package staging', 409)
      const finalRoot = packageRoot(this.options.packageRoot, installationId)
      let committed = false
      await fs.mkdir(this.options.packageRoot, { recursive: true })
      await fs.rename(staging, finalRoot)
      const source = check.source
      const record: LibraryInstallation = {
        installationId, packageId: checked.manifest.id, version: checked.manifest.version, packageSha: checked.packageSha,
        source,
        runtime: runtimePin(runtime), status: 'ready', active: true,
        createdAt: Date.now(), updatedAt: Date.now(), rootRelative: `agents/packages/${installationId}`, stateRelative: `agents/state/${installationId}`,
        permissions: [...check.trust.requiredPermissions], trustConfirmed: true,
      }
      try {
        await fs.mkdir(path.join(this.dataRoot(), record.stateRelative), { recursive: true })
        const views = new Map(checked.manifestView.taskTypes.flatMap((task) => task.inputSchema ? [[task.id, task.inputSchema] as const] : []))
        await this.options.registry.registerInstalled({ installationId, root: finalRoot, packageSha: record.packageSha, status: 'disabled', source: record.source, runtime: record.runtime, inputSchemaViews: views })
        const savedTransaction = await this.options.library.transactionUnlocked(document.revision, (draft, revision) => {
          for (const existingRecord of Object.values(draft.installations)) {
            if (existingRecord.packageId === record.packageId) existingRecord.active = false
          }
          const saved = { ...record, updatedAt: Date.now(), active: true }
          draft.installations[installationId] = saved
          draft.active[record.packageId] = installationId
          const response = { ...saved, revision }
          draft.requests[requestId] = { action: 'install', fingerprint, response, createdAt: Date.now() }
          return response
        })
        committed = true
        this.options.registry.setActive(record.packageId, installationId)
        return savedTransaction.value
      } catch (error) {
        if (!committed) {
          this.options.registry.removeInstallation(installationId)
          await fs.rename(finalRoot, staging).catch(() => undefined)
        }
        throw error
      }
    })
  }

  async manage(action: 'enable' | 'disable' | 'rollback' | 'remove', input: AgentPackageManageRequest): Promise<AgentPackageInstallationView & { revision: number }> {
    await this.initialize()
    return managePackage(action, input, {
      library: this.options.library,
      registry: this.options.registry,
      activeTaskPins: this.options.activeTaskPins,
      packageLifecycleLock: this.options.packageLifecycleLock,
      revalidate: (target) => this.revalidateInstallation(target),
    })
  }

  private async revalidateInstallation(target: LibraryInstallation): Promise<void> {
    const runtime = this.runtimeForKind(target.runtime.kind)
    if (!runtime || !sameRuntimePin(runtime, target.runtime)) throw new AgentPackageError('RUNTIME_PIN_MISMATCH', 'Installation requires a different exact portable runtime', 409)
    const root = this.persistedPackageRoot(target.rootRelative)
    const checked = await checkPackage(root, this.options.validator ?? new AgentProtocolValidator(), runtime)
    if (checked.packageSha !== target.packageSha || checked.manifest.id !== target.packageId || checked.manifest.version !== target.version || !supportedPackage(checked)) {
      throw new AgentPackageError('PACKAGE_INTEGRITY_INVALID', 'Saved installation fails the integrity recheck', 409)
    }
    const views = new Map(checked.manifestView.taskTypes.flatMap((task) => task.inputSchema ? [[task.id, task.inputSchema] as const] : []))
    await this.options.registry.registerInstalled({
      installationId: target.installationId,
      root,
      packageSha: target.packageSha,
      status: target.status === 'disabled' ? 'disabled' : 'ready',
      source: target.source,
      runtime: target.runtime,
      inputSchemaViews: views,
      active: false,
    })
  }

  private dataRoot(): string { return path.resolve(this.options.packageRoot, '..', '..') }

  private persistedPackageRoot(relative: string): string {
    const root = path.resolve(this.dataRoot(), relative)
    const base = path.resolve(this.options.packageRoot)
    if (!root.startsWith(`${base}${path.sep}`)) throw new AgentPackageError('PACKAGE_PATH_INVALID', 'Saved package path is outside the library', 500)
    return root
  }
}

export function defaultPackageManager(options: Omit<PackageManagerOptions, 'probe'>): AgentPackageManager {
  return new AgentPackageManager({ ...options, probe: createDefaultPackageProbe(options.validator) })
}

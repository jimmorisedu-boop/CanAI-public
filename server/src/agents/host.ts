import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentGenerationCaptureReceipt,
  AgentGenerationCaptureRequest,
  AgentEnvelope,
} from '../../../packages/agent-protocol/index.js'
import type { AgentPackage, AgentPackageRegistry } from './packages.js'
import { AgentTaskJournal } from './journal.js'
import { publicTask, type AgentTaskRecord } from './types.js'
import { AgentToolBroker } from './tools.js'
import { AgentProtocolValidator } from './validation.js'
import { AgentProcessManager, type ManagedProcess } from './host-process.js'
import { AgentProtocolDispatcher } from './host-protocol.js'
import { AgentTaskLifecycle } from './host-lifecycle.js'
import { acknowledgeCanvasDelivery as acknowledgeCanvasDeliveryAfterSave } from './host-delivery.js'
import { verifyCheckpoint as verifyCheckpointFiles } from './host-checkpoint.js'
import { captureGenerationInputs as captureNativeGenerationInputs } from './generation-input-capture.js'
import { packageTreeIntegrity } from './package-archive.js'
import { detectRuntimeMetadata, inspectPythonRuntime, pythonLaunch, type PythonRuntimeMetadata } from './package-runtime.js'
import {
  brokerTask,
  makeHostEnvelope,
  safeEnvironment,
  startPayload,
  writeAgentEnvelope,
  writeHostAck as writeHostAckEnvelope,
  writeToolResult as writeToolResultEnvelope,
  wireReceipt,
} from './host-wire.js'
import { resolveWorkspacePath } from './host-path.js'
import { AgentHostAdmission } from './host-admission.js'
import { createAgentTask } from './host-create.js'
import { AgentPaidRecovery } from './paid-recovery.js'
import {
  AgentHostError,
  type ControlRequest,
  type CreateAgentTaskInput,
  TERMINAL,
  checkIdentifier,
  errorPayload,
} from './host-shared.js'

export { AgentHostError, type CreateAgentTaskInput } from './host-shared.js'

export interface AgentHostOptions {
  journal: AgentTaskJournal
  packages: AgentPackageRegistry
  broker: AgentToolBroker
  workspaceRoot: string
  stateRoot?: string
  mediaDir?: string
  validator?: AgentProtocolValidator
  now?: () => number
  /** Identity is supplied by the desktop Host, never by the browser body. */
  ownerId?: string
  controllerId?: string
  /** Portable runtime root used only after the installed pin is reverified. */
  runtimeDir?: string
  /** Shared with the package manager so lifecycle updates cannot race task pinning. */
  admission?: AgentHostAdmission
}

type AgentLaunch = { kind: 'node' | 'python'; executable: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }

function samePythonPin(actual: PythonRuntimeMetadata, pinned: Extract<NonNullable<AgentPackage['runtime']>, { kind: 'python' }>): boolean {
  return actual.version === pinned.version
    && actual.integrity === pinned.integrity
    && actual.environmentId === pinned.environmentId
    && actual.executableRelative === pinned.executableRelative
    && actual.stdlibIntegrity === pinned.stdlibIntegrity
    && actual.treeSha === pinned.treeSha
    && actual.archiveSha === pinned.archiveSha
}

export class AgentHost {
  private readonly processes: AgentProcessManager
  private readonly protocol: AgentProtocolDispatcher
  private readonly lifecycle: AgentTaskLifecycle
  private readonly now: () => number
  private readonly validator: AgentProtocolValidator
  private readonly admission: AgentHostAdmission
  private readonly paidRecovery: AgentPaidRecovery
  private closing = false

  constructor(private readonly options: AgentHostOptions) {
    this.admission = options.admission ?? new AgentHostAdmission()
    this.now = options.now ?? Date.now
    this.validator = options.validator ?? new AgentProtocolValidator()
    this.paidRecovery = new AgentPaidRecovery({ recover: (task) => this.options.broker.recoverPersisted?.(task) ?? Promise.resolve() })
    this.processes = new AgentProcessManager({
      onLine: (taskId, managed, line) => this.protocol.handleLine(taskId, managed, line),
      onExit: (taskId, managed, code, signal) => this.onExit(taskId, managed, code, signal),
      onProtocolOverflow: (taskId, managed, message) => this.onProtocolOverflow(taskId, managed, message),
    })
    this.protocol = new AgentProtocolDispatcher({
      journal: this.options.journal,
      validator: this.validator,
      broker: this.options.broker,
      now: this.now,
      require: (taskId) => this.require(taskId),
      assertPermission: (task, permission) => this.assertPermission(task, permission),
      sendOrQueue: (taskId, message) => this.sendOrQueue(taskId, message),
      makeHostEnvelope,
      writeEnvelope: (managed, message) => writeAgentEnvelope(this.validator, managed, message),
      writeHostAck: (managed, messageId, cursor) => writeHostAckEnvelope(this.validator, managed, messageId, cursor),
      writeToolResult: (managed, request, receipt) => writeToolResultEnvelope(this.validator, managed, request, receipt),
      wireReceipt,
      startPayload: (task) => startPayload(task, this.options.broker.startAccess?.(task) ?? this.options.broker.llmStartAccess(task)),
      brokerTask: (task) => brokerTask(this.options.workspaceRoot, task),
      verifyCheckpoint: (task, checkpoint) => verifyCheckpointFiles(task, checkpoint, this.options.workspaceRoot),
      failTask: (taskId, error) => this.failTask(taskId, error),
    })
    this.lifecycle = new AgentTaskLifecycle({
      journal: this.options.journal,
      processes: this.processes,
      actorId: () => this.identity(this.options.controllerId, 'local-host-controller'),
      now: this.now,
      require: (taskId) => this.require(taskId),
      cancelExternal: (task) => this.options.broker.cancelExternal(task),
      start: (taskId) => this.start(taskId),
      sendOrQueue: (taskId, message) => this.sendOrQueue(taskId, message),
      makeHostEnvelope,
    })
  }

  async restore(): Promise<void> {
    const tasks = await this.options.journal.load()
    this.paidRecovery.start(tasks)
    for (const task of tasks) {
      if (TERMINAL.has(task.state) || task.state === 'paused') continue
            void this.start(task.taskId).catch(() => undefined)
    }
  }

  async list(): Promise<AgentTaskRecord[]> { return this.options.journal.list() }
  async get(taskId: string): Promise<AgentTaskRecord | null> { return this.options.journal.get(taskId) }

  async create(input: CreateAgentTaskInput): Promise<AgentTaskRecord> {
    return createAgentTask({
      journal: this.options.journal, packages: this.options.packages, broker: this.options.broker,
      workspaceRoot: this.options.workspaceRoot, mediaDir: this.options.mediaDir, admission: this.admission, ownerId: this.options.ownerId,
      controllerId: this.options.controllerId, now: this.now, identity: (value, fallback) => this.identity(value, fallback),
      start: (taskId) => this.start(taskId),
    }, input)
  }

  async start(taskId: string): Promise<AgentTaskRecord> {
    return this.admission.withStartLock(taskId, () => this.admission.withPackageLifecycleLock(() => this.startUnlocked(taskId)))
  }

  private async startUnlocked(taskId: string): Promise<AgentTaskRecord> {
    if (this.closing) return this.require(taskId)
    const task = await this.require(taskId)
    if (TERMINAL.has(task.state)) return task
    if (task.projectRef.source !== 'local') throw new AgentHostError('CLOUD_AGENT_DELIVERY_UNSUPPORTED', 'The local Host cannot execute a shared Cloud task', 409)
        if (this.processes.has(taskId)) return task
    let pkg
    let workspacePath: string
    let launch: AgentLaunch
    try {
      pkg = this.pinnedPackage(task)
      launch = await this.verifyPinnedPackage(pkg)
      this.admission.reservePackage(this.admission.packageKey(pkg), taskId, pkg.manifest.runtime.maxParallelTasks)
      workspacePath = await resolveWorkspacePath(this.options.workspaceRoot, task.workspacePath, true)
    } catch (error) {
      if (error instanceof AgentHostError && error.code === 'PACKAGE_BUSY') throw error
      this.admission.release(taskId)
      await this.failTask(taskId, errorPayload(error))
      throw error
    }
    const executionId = `execution-${crypto.randomUUID()}`
    let running: AgentTaskRecord
    try {
      running = await this.options.journal.withTaskLock(taskId, () => this.options.journal.mutate(taskId, (entry) => {
        if (entry.state !== 'queued' && entry.state !== 'running') throw new AgentHostError('START_ABORTED', 'Task changed before launch', 409)
        entry.currentExecutionId = executionId
        entry.state = 'running'
        entry.revision += 1
        delete entry.error
      }, { type: 'execution.started', payload: { executionId } }))
    } catch (error) {
      this.admission.release(taskId)
      const current = await this.require(taskId)
      if (current.state === 'pausing') {
        return this.options.journal.mutate(taskId, (entry) => {
          if (entry.state === 'pausing') { entry.state = 'paused'; entry.revision += 1 }
        }, { type: 'task.paused', payload: { reason: 'Launch stopped before process creation' } })
      }
      if (current.state === 'cancelling') {
        return this.options.journal.mutate(taskId, (entry) => {
          if (entry.state === 'cancelling') { entry.state = 'cancelled'; entry.revision += 1 }
        }, { type: 'task.cancelled', payload: { reason: 'Launch stopped before process creation' } })
      }
      if (TERMINAL.has(current.state) || error instanceof AgentHostError && error.code === 'START_ABORTED') return current
      await this.failTask(taskId, errorPayload(error))
      throw error
    }
    try { workspacePath = await resolveWorkspacePath(this.options.workspaceRoot, running.workspacePath, true) }
    catch (error) {
      this.admission.release(taskId)
      await this.failTask(taskId, errorPayload(error))
      throw error
    }
    if (this.closing) {
      this.admission.release(taskId)
      return this.require(taskId)
    }
    let managed: ManagedProcess | undefined
    try {
      const packageId = pkg.manifest?.id ?? task.packageId
      const stateRoot = this.options.stateRoot ?? path.join(path.dirname(this.options.workspaceRoot), 'agents', 'state')
      const stateDir = path.resolve(stateRoot, packageId)
      if (this.options.mediaDir && (stateDir === path.resolve(this.options.mediaDir) || stateDir.startsWith(path.resolve(this.options.mediaDir) + path.sep))) {
        throw new AgentHostError('STATE_DIR_INVALID', 'State directory cannot be inside mediaDir', 500)
      }
      await fs.mkdir(stateDir, { recursive: true })
      const current = await this.options.journal.withTaskLock(taskId, async () => {
        const fresh = await this.options.journal.get(taskId)
        if (!fresh || fresh.state !== 'running' || fresh.currentExecutionId !== executionId) return fresh
        managed = this.processes.spawnProcess({ taskId, package: pkg, executionId, cwd: workspacePath, env: safeEnvironment(taskId, executionId, workspacePath, { packageDir: pkg.root, stateDir }), launch })
        return fresh
      })
      if (!current || current.state !== 'running' || current.currentExecutionId !== executionId) {
        this.admission.release(taskId)
        if (current?.state === 'pausing') {
          return this.options.journal.mutate(taskId, (entry) => {
            if (entry.state === 'pausing') { entry.state = 'paused'; entry.revision += 1 }
          }, { type: 'task.paused', payload: { reason: 'Launch stopped before process creation' } })
        }
        if (current?.state === 'cancelling') {
          return this.options.journal.mutate(taskId, (entry) => {
            if (entry.state === 'cancelling') { entry.state = 'cancelled'; entry.revision += 1 }
          }, { type: 'task.cancelled', payload: { reason: 'Launch stopped before process creation' } })
        }
        return current ?? this.require(taskId)
      }
      if (!managed) throw new AgentHostError('START_ABORTED', 'Agent process was not created', 409)
    } catch (error) {
      this.admission.release(taskId)
      await this.failTask(taskId, errorPayload(error))
      throw error
    }
    const managedProcess = managed
    const handshakeTimer = setTimeout(() => {
      if (!managedProcess.hello && this.processes.get(taskId) === managedProcess) {
        managedProcess.closing = true
        managedProcess.child.kill()
        void this.failTask(taskId, { code: 'PROTOCOL_UNSUPPORTED', message: 'Agent did not send hello in time', retryable: false })
      }
    }, 10_000)
    handshakeTimer.unref()
    return running
  }

  async control(taskId: string, action: ControlRequest['action'], request: Omit<ControlRequest, 'action'>): Promise<AgentTaskRecord> {
    return this.lifecycle.control(taskId, action, request)
  }

  async decide(taskId: string, reviewId: string, input: Parameters<AgentTaskLifecycle['decide']>[2], opts: Parameters<AgentTaskLifecycle['decide']>[3] = {}): Promise<AgentTaskRecord> {
    return this.lifecycle.decide(taskId, reviewId, input, opts)
  }

  async acknowledgeCanvasDelivery(projectId: string, snapshot: unknown): Promise<void> {
    return acknowledgeCanvasDeliveryAfterSave({ journal: this.options.journal, protocol: this.protocol, projectId, snapshot })
  }

  async close(): Promise<void> { this.closing = true; this.paidRecovery.close(); await this.processes.close(); this.admission.clear() }
  events(taskId: string, after: number) { return this.options.journal.events(taskId, after) }
  subscribe(taskId: string, listener: Parameters<AgentTaskJournal['subscribe']>[1]) { return this.options.journal.subscribe(taskId, listener) }
  view(task: AgentTaskRecord) { return publicTask(task) }
  llmCatalog() { return this.options.broker.llmCatalog() }
  generationCatalog() { return this.options.broker.generationCatalog() }
  async captureGenerationInputs(request: AgentGenerationCaptureRequest): Promise<AgentGenerationCaptureReceipt[]> {
    return captureNativeGenerationInputs(request, this.options.mediaDir)
  }

  private async require(taskId: string): Promise<AgentTaskRecord> {
    checkIdentifier(taskId, 'taskId')
    const task = await this.options.journal.get(taskId)
    if (!task) throw new AgentHostError('TASK_NOT_FOUND', 'Agent task not found', 404)
    return task
  }

  private identity(value: string | undefined, fallback: string): string {
    return checkIdentifier(value ?? fallback, 'Host identity')
  }

  private pinnedPackage(task: AgentTaskRecord) {
    try { return this.options.packages.getPinned(task) }
    catch { throw new AgentHostError('PACKAGE_PIN_MISMATCH', 'Pinned agent package version is no longer available', 409) }
  }

  private async verifyPinnedPackage(pkg: ReturnType<AgentHost['pinnedPackage']>): Promise<AgentLaunch> {
    if (!pkg.installationId || !pkg.runtime) return { kind: 'node', executable: process.execPath, args: [pkg.entrypoint] }
    try {
      const tree = await packageTreeIntegrity(pkg.root)
      if (tree.packageSha !== pkg.packageSha) throw new Error('package pin changed')
      if (pkg.runtime.kind === 'python') {
        if (!this.options.runtimeDir) throw new Error('portable Python runtime is not configured')
        const status = await inspectPythonRuntime(this.options.runtimeDir)
        if (!status.ready || !status.runtime || !samePythonPin(status.runtime, pkg.runtime)) throw new Error('python runtime pin changed')
        const launch = pythonLaunch(status.runtime, this.options.runtimeDir, pkg.entrypointModule ?? pkg.entrypoint, pkg.entrypointKind === 'module', pkg.root)
        return { kind: 'python', ...launch }
      }
      const runtime = await detectRuntimeMetadata()
      if (runtime.version !== pkg.runtime.version || runtime.integrity !== pkg.runtime.integrity || runtime.environmentId !== pkg.runtime.environmentId) throw new Error('node runtime pin changed')
      return { kind: 'node', executable: process.execPath, args: [pkg.entrypoint] }
    } catch {
      throw new AgentHostError('PACKAGE_PIN_MISMATCH', 'Pinned installation failed the integrity/runtime recheck', 409)
    }
  }

  private assertPermission(task: AgentTaskRecord, permission: string): void {
    const requiredPermission = permission === 'generation.quote' ? 'generation.request' : permission
    const pkg = this.pinnedPackage(task)
    if (!pkg.manifest.permissions.includes(requiredPermission)) {
      throw new AgentHostError('PERMISSION_DENIED', `Package did not request permission ${requiredPermission}`, 403)
    }
  }


  private sendOrQueue(taskId: string, message: AgentEnvelope): void {
    const managed = this.processes.get(taskId)
    if (!managed || !managed.hello) { managed?.pending.push(message); return }
    writeAgentEnvelope(this.validator, managed, message)
  }

  private async failTask(taskId: string, error: { code: string; message: string; retryable: boolean }): Promise<void> {
    const task = await this.options.journal.get(taskId)
    if (!task || TERMINAL.has(task.state)) return
    await this.options.journal.mutate(taskId, (entry) => { entry.state = 'failed'; entry.error = error; entry.revision += 1 }, { type: 'task.failed', payload: { error } })
  }

  private onProtocolOverflow(taskId: string, managed: ManagedProcess, message: string): void {
    managed.closing = true
    managed.child.kill()
    void this.failTask(taskId, { code: 'PROTOCOL_INVALID', message, retryable: false })
  }

  private async onExit(taskId: string, managed: ManagedProcess, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.admission.release(taskId)
    if (this.closing || managed.closing) return
    const task = await this.options.journal.get(taskId)
    if (!task || TERMINAL.has(task.state) || task.state === 'paused') return
    await this.options.journal.mutate(taskId, (entry) => {
      if (entry.state === 'cancelling') entry.state = 'cancelled'
      else if (entry.state === 'pausing') entry.state = 'paused'
      else entry.state = 'queued'
      entry.revision += 1
    }, { type: 'execution.exited', payload: { code, signal } })
    const next = await this.options.journal.get(taskId)
    if (next && next.state === 'queued') setTimeout(() => { void this.start(taskId).catch(() => undefined) }, 25).unref()
  }
}

import { AgentHostError } from './host-shared.js'

export interface AdmissionPackage { manifest: { id: string; runtime: { maxParallelTasks: number } }; installationId?: string }

/** Serializes request creation and reserves one process slot per installed package. */
export class AgentHostAdmission {
  private readonly packageReservations = new Map<string, string>()
  private readonly requestLocks = new Map<string, Promise<void>>()
  private readonly startLocks = new Map<string, Promise<void>>()
  private packageLifecycleLock: Promise<void> = Promise.resolve()

  packageKey(pkg: Pick<AdmissionPackage, 'manifest' | 'installationId'>): string {
    return pkg.installationId ?? `bundled:${pkg.manifest.id}`
  }

  reservePackage(key: string, owner: string, maxParallelTasks: number): void {
    if (maxParallelTasks > 1) return
    const current = this.packageReservations.get(key)
    if (current && current !== owner) throw new AgentHostError('PACKAGE_BUSY', 'A task is already running for this installation', 409)
    this.packageReservations.set(key, owner)
  }

  transferPackage(key: string, from: string, to: string, maxParallelTasks: number): void {
    if (maxParallelTasks > 1) return
    if (this.packageReservations.get(key) !== from) throw new AgentHostError('PACKAGE_BUSY', 'A task is already running for this installation', 409)
    this.packageReservations.set(key, to)
  }

  release(owner: string): void {
    for (const [key, current] of this.packageReservations) if (current === owner) this.packageReservations.delete(key)
  }

  clear(): void { this.packageReservations.clear(); this.requestLocks.clear(); this.startLocks.clear() }

  /** Serializes registry lifecycle changes with Host create/start pinning. */
  async withPackageLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.packageLifecycleLock
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.packageLifecycleLock = previous.then(() => current)
    await previous
    try { return await operation() } finally { release() }
  }

  async withRequestLock<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.requestLocks.get(requestId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chain = previous.then(() => current)
    this.requestLocks.set(requestId, chain)
    await previous
    try { return await operation() } finally {
      release()
      if (this.requestLocks.get(requestId) === chain) this.requestLocks.delete(requestId)
    }
  }

  async withStartLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.startLocks.get(taskId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chain = previous.then(() => current)
    this.startLocks.set(taskId, chain)
    await previous
    try { return await operation() } finally {
      release()
      if (this.startLocks.get(taskId) === chain) this.startLocks.delete(taskId)
    }
  }
}

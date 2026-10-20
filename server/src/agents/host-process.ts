import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentPackage } from './packages.js'
import { AGENT_MAX_MESSAGE_BYTES } from '../../../packages/agent-protocol/index.js'
import { logNote } from '../log.js'

export interface ManagedProcess {
  taskId: string
  child: ChildProcessWithoutNullStreams
  package: AgentPackage
  executionId: string
  buffer: string
  queue: Promise<void>
  hello: boolean
  pending: Array<import('../../../packages/agent-protocol/index.js').AgentEnvelope>
  closing: boolean
  exited: Promise<void>
  resolveExit: () => void
}

export interface AgentProcessCallbacks {
  onLine(taskId: string, managed: ManagedProcess, line: string): void | Promise<void>
  onExit(taskId: string, managed: ManagedProcess, code: number | null, signal: NodeJS.Signals | null): void | Promise<void>
  onProtocolOverflow(taskId: string, managed: ManagedProcess, message: string): void | Promise<void>
}

export interface AgentProcessStart {
  taskId: string
  package: AgentPackage
  executionId: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** Resolved by AgentHost after tree/runtime re-verification. */
  launch: { kind: 'node' | 'python'; executable: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
}

/** Owns child-process plumbing; protocol and task lifecycle stay in separate modules. */
export class AgentProcessManager {
  private readonly processes = new Map<string, ManagedProcess>()
  /** Keep completed process promises until the next execution of that task. */
  private readonly exits = new Map<string, Promise<void>>()

  constructor(private readonly callbacks: AgentProcessCallbacks) {}

  get(taskId: string): ManagedProcess | undefined { return this.processes.get(taskId) }
  has(taskId: string): boolean { return this.processes.has(taskId) }

  spawnProcess(input: AgentProcessStart): ManagedProcess {
    if (this.processes.has(input.taskId)) throw new Error(`Task process ${input.taskId} is already running`)
    if (!input.launch.executable || !input.launch.args.length) throw new Error('Pinned agent launch is invalid')
    const child = spawn(input.launch.executable, input.launch.args, {
      cwd: input.launch.cwd ?? input.cwd,
      // pythonLaunch contributes its hermetic runtime variables, while Host
      // identity/workspace variables remain authoritative from safeEnvironment.
      env: { ...input.env, ...(input.launch.env ?? {}) },
      stdio: 'pipe',
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
    let resolveExit!: () => void
    const exited = new Promise<void>((resolve) => { resolveExit = resolve })
    const managed: ManagedProcess = {
      taskId: input.taskId,
      child,
      package: input.package,
      executionId: input.executionId,
      buffer: '',
      queue: Promise.resolve(),
      hello: false,
      pending: [],
      closing: false,
      exited,
      resolveExit,
    }
    this.processes.set(input.taskId, managed)
    this.exits.set(input.taskId, exited)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.readStdout(input.taskId, managed, chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of String(chunk).split(/\r?\n/u).filter(Boolean)) logNote('agent-stderr', `${input.taskId}: ${line.slice(0, 4_000)}`)
    })
    child.on('error', (error) => logNote('agent-process', `${input.taskId}: ${error.message}`))
    child.stdin.on('error', (error) => {
      if (managed.closing || (error as NodeJS.ErrnoException).code === 'EPIPE' || /EPIPE/u.test(error.message)) return
      logNote('agent-stdin', `${input.taskId}: ${error.message}`)
    })
    child.on('close', (code, signal) => {
      if (this.processes.get(input.taskId) !== managed) {
        managed.resolveExit()
        return
      }
      this.processes.delete(input.taskId)
      managed.queue
        .catch(() => undefined)
        .then(() => this.callbacks.onExit(input.taskId, managed, code, signal))
        .catch(() => undefined)
        .finally(() => managed.resolveExit())
    })
    return managed
  }

  kill(taskId: string): void {
    const managed = this.processes.get(taskId)
    if (!managed) return
    managed.closing = true
    managed.child.kill()
  }

  async close(): Promise<void> {
    const waits: Promise<void>[] = [...this.exits.values()]
    for (const managed of this.processes.values()) {
      managed.closing = true
      managed.child.stdin.destroy()
      managed.child.kill()
      if (!waits.includes(managed.exited)) waits.push(managed.exited)
    }
    await Promise.all(waits)
  }

  private readStdout(taskId: string, managed: ManagedProcess, chunk: string): void {
    managed.buffer += chunk
    if (Buffer.byteLength(managed.buffer, 'utf8') > AGENT_MAX_MESSAGE_BYTES * 2) {
      managed.child.kill()
      void this.callbacks.onProtocolOverflow(taskId, managed, 'Agent produced an NDJSON message that is too long')
      return
    }
    let newline = managed.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = managed.buffer.slice(0, newline).replace(/\r$/u, '')
      managed.buffer = managed.buffer.slice(newline + 1)
      newline = managed.buffer.indexOf('\n')
      if (!line) continue
      if (Buffer.byteLength(line, 'utf8') > AGENT_MAX_MESSAGE_BYTES) {
        void this.callbacks.onProtocolOverflow(taskId, managed, 'Agent message exceeds 256 KiB')
        continue
      }
      managed.queue = managed.queue.then(() => this.callbacks.onLine(taskId, managed, line), () => this.callbacks.onLine(taskId, managed, line))
    }
  }
}

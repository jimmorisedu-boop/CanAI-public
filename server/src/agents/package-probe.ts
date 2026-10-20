import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentEnvelope } from '../../../packages/agent-protocol/index.js'
import { AGENT_MAX_MESSAGE_BYTES } from '../../../packages/agent-protocol/index.js'
import { AgentPackageError } from './package-errors.js'
import { AgentProtocolValidator } from './validation.js'

export interface PackageProbeInput {
  root: string
  entrypoint: string
  installationId: string
  workspace: string
  expectedCapabilities?: string[]
  /** A pinned executable/argv selected by Host; omitted only for bundled Node fixtures. */
  launch?: { kind: 'node' | 'python'; executable: string; args: string[] }
}

export interface PackageProbeResult { hello: AgentEnvelope }
export type PackageProbeRunner = (input: PackageProbeInput) => Promise<PackageProbeResult>

const PROBE_TIMEOUT_MS = 10_000
const PROBE_KILL_TIMEOUT_MS = 5_000

function environment(input: PackageProbeInput): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ['NODE_ENV', 'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT']) {
    if (process.env[key]) result[key] = process.env[key]
  }
  result.NODE_ENV = 'production'
  result.CANAI_AGENT_PROTOCOL_VERSION = '1.0'
  result.CANAI_AGENT_TASK_ID = 'probe'
  result.CANAI_AGENT_EXECUTION_ID = input.installationId
  result.CANAI_AGENT_PACKAGE_DIR = input.root
  result.CANAI_AGENT_WORK_DIR = input.workspace
  result.CANAI_AGENT_WORKSPACE = input.workspace
  result.CANAI_AGENT_STATE_DIR = path.join(input.workspace, 'state')
  if (input.launch?.kind === 'python') {
    result.PYTHONIOENCODING = 'utf-8'
    result.PYTHONNOUSERSITE = '1'
    delete result.PYTHONPATH
  }
  return result
}

async function cleanupWorkspace(workspace: string): Promise<void> {
  const parent = path.dirname(path.resolve(workspace))
  const parentReal = await fs.realpath(parent).catch(() => '')
  const target = path.resolve(workspace)
  if (!parentReal || !target.startsWith(`${parentReal}${path.sep}`)) return
  const stat = await fs.lstat(target).catch(() => null)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return
  await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
}

export function createDefaultPackageProbe(validator = new AgentProtocolValidator()): PackageProbeRunner {
  return async (input) => {
    await fs.mkdir(input.workspace, { recursive: true })
    await fs.mkdir(path.join(input.workspace, 'state'), { recursive: true })
    const launch = input.launch ?? { kind: 'node' as const, executable: process.execPath, args: [input.entrypoint] }
    if (!path.isAbsolute(launch.executable)) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Probe executable must be an absolute pinned path', 409)
    if (launch.kind === 'python' && (!launch.args.includes('-I') || !launch.args.includes('-S') || !launch.args.includes('-B') || !launch.args.includes('-u'))) {
      throw new AgentPackageError('RUNTIME_ARGS_INVALID', 'Python probe must run with -I -S -B -u', 409)
    }
    const child = spawn(launch.executable, launch.args, {
      cwd: input.root,
      env: environment(input),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let settled = false
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    let timer: ReturnType<typeof setTimeout> | undefined
    const terminate = (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        child.stdout?.destroy()
        child.stderr?.destroy()
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        let forceTimer: ReturnType<typeof setTimeout> | undefined
        const teardownTimer = setTimeout(() => {
          clearTimeout(forceTimer)
          reject(new AgentPackageError('PROBE_TEARDOWN_FAILED', 'Probe process did not exit after probe'))
        }, PROBE_KILL_TIMEOUT_MS)
        const finish = () => {
          clearTimeout(forceTimer)
          clearTimeout(teardownTimer)
          child.stdout?.destroy()
          child.stderr?.destroy()
          resolve()
        }
        child.once('exit', finish)
        child.once('close', () => {
          if (child.exitCode !== null || child.signalCode !== null) finish()
        })
        if (!child.killed) child.kill()
        forceTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 1_000)
      })
    }
    const settle = (resolve: (value: PackageProbeResult) => void, reject: (error: unknown) => void, value?: PackageProbeResult, error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.stdout?.removeAllListeners()
      child.stderr?.removeAllListeners()
      void terminate().then(() => {
        if (error) reject(error)
        else if (value) resolve(value)
      }, (teardownError) => reject(error ?? teardownError))
    }
    let result: PackageProbeResult
    try {
      result = await new Promise<PackageProbeResult>((resolve, reject) => {
      const fail = (error: Error) => settle(resolve, reject, undefined, error)
      timer = setTimeout(() => fail(new AgentPackageError('PROBE_TIMEOUT', 'Probe hello was not received in time')), PROBE_TIMEOUT_MS)
      child.once('error', () => fail(new AgentPackageError('PROBE_FAILED', 'Probe process did not start')))
      child.stderr?.on('data', () => undefined)
      child.once('close', () => {
        if (!settled) fail(new AgentPackageError('PROBE_FAILED', 'Probe process exited without hello'))
      })
      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return
        buffer += decoder.write(chunk)
        if (Buffer.byteLength(buffer, 'utf8') > AGENT_MAX_MESSAGE_BYTES) return fail(new AgentPackageError('PROBE_OUTPUT_TOO_LARGE', 'Probe hello exceeds the limit'))
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (!line.trim()) continue
          let raw: unknown
          try { raw = JSON.parse(line) as unknown } catch { return fail(new AgentPackageError('PROBE_PROTOCOL_INVALID', 'Probe process sent invalid JSON')) }
          try {
            const hello = validator.assertEnvelope(raw, 'agent-to-host')
            if (hello.type !== 'hello') continue
            if (hello.taskId !== 'probe' || hello.executionId !== input.installationId) throw new AgentPackageError('PROBE_PROTOCOL_INVALID', 'hello identity does not match probe')
            const payload = hello.payload as Record<string, unknown>
            const versions = payload.supportedProtocolVersions
            if (!Array.isArray(versions) || !versions.includes('1.0')) throw new AgentPackageError('PROTOCOL_UNSUPPORTED', 'Package does not support protocol 1.0')
            if (!Array.isArray(payload.capabilities) || payload.capabilities.some((capability) => typeof capability !== 'string')) throw new AgentPackageError('PROBE_PROTOCOL_INVALID', 'hello.capabilities must be an array of strings')
            for (const capability of input.expectedCapabilities ?? []) if (!payload.capabilities.includes(capability)) throw new AgentPackageError('PROBE_CAPABILITY_MISSING', `hello did not declare capability ${capability}`)
            return settle(resolve, reject, { hello })
          } catch (error) { return fail(error instanceof Error ? error : new AgentPackageError('PROBE_PROTOCOL_INVALID', 'Probe hello is invalid')) }
        }
      })
      })
    } finally { await cleanupWorkspace(input.workspace) }
    return result
  }
}

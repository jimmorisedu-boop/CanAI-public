import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import test from 'node:test'
import { AgentHost } from './host.js'
import { AgentTaskJournal } from './journal.js'
import { AgentPackageLibrary } from './library.js'
import { AgentPackageManager } from './package-manager.js'
import { AgentPackageRegistry } from './packages.js'
import { inspectPythonRuntime } from './package-runtime.js'
import { AgentPackageUploadStore } from './package-upload.js'
import type { GitSourceTransport } from './package-source.js'
import { AgentProtocolValidator } from './validation.js'

const enabled = process.env.CANAI_RUN_PORTABLE_PYTHON_SMOKE === '1'

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(value: Buffer): number {
  let result = 0xffffffff
  for (const byte of value) result = (result >>> 8) ^ CRC32_TABLE[(result ^ byte) & 0xff]!
  return (result ^ 0xffffffff) >>> 0
}

function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const compressed = zlib.deflateRawSync(entry.data)
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30 + name.length + compressed.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    compressed.copy(local, 30 + name.length)
    locals.push(local)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

function smokeArchive(packageId = 'canai.python.smoke', module = false): Buffer {
  const manifest = {
    schemaVersion: 1, id: packageId, name: 'Portable Python smoke', description: 'Harmless stdlib NDJSON fixture', version: '1.0.0', protocolVersion: '1.0',
    // Manifest runtime.version is the supported major.minor line; the
    // verified portable runtime pin carries the exact 3.13.16 patch.
    runtime: { kind: 'python', version: '3.13', entrypoint: module ? { kind: 'module', module: 'canai_adapter' } : { kind: 'file', path: 'agent.py' }, dependencies: { kind: 'stdlib' }, maxParallelTasks: 1 },
    taskTypes: [{ id: 'echo', label: 'Echo', description: 'Writes a Russian stdlib-only NDJSON response.', inputSchema: 'schemas/echo.json', outputKinds: ['text'] }],
    permissions: [], connections: [], lifecycle: { pause: 'checkpoint', resume: true, cancel: true },
  }
  const python = [
    'import json, os, sys',
    'sys.stdout.reconfigure(encoding="utf-8")',
    'task_id = os.environ["CANAI_AGENT_TASK_ID"]',
    'execution_id = os.environ["CANAI_AGENT_EXECUTION_ID"]',
    'sequence = 0',
    'def send(kind, payload):',
    '    global sequence',
    '    sequence += 1',
    '    print(json.dumps({"protocolVersion":"1.0","messageId":"smoke-%d" % sequence,"taskId":task_id,"executionId":execution_id,"type":kind,"payload":payload}, ensure_ascii=False), flush=True)',
    'send("hello", {"supportedProtocolVersions":["1.0"],"capabilities":["resume","cancel","pause.checkpoint"]})',
    'for line in sys.stdin:',
    '    message = json.loads(line)',
    '    if message.get("type") in ("task.start", "task.resume"):',
    '        send("task.progress", {"stageId":"echo","label":"Привет, CanAI","status":"running"})',
    '        send("task.finished", {"outcome":"succeeded","summary":"Привет, CanAI — stdlib NDJSON smoke","artifactIds":[]})',
    '        break',
  ].join('\n') + '\n'
  const schema = JSON.stringify({ type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', minLength: 1 } } })
  return zip([
    { name: 'python-smoke/canai.agent.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    ...(module ? [{ name: 'python-smoke/canai_adapter/__main__.py', data: Buffer.from(python, 'utf8') }] : [{ name: 'python-smoke/agent.py', data: Buffer.from(python, 'utf8') }]),
    { name: 'python-smoke/schemas/echo.json', data: Buffer.from(schema, 'utf8') },
  ])
}

async function waitForTask(host: AgentHost, taskId: string): Promise<NonNullable<Awaited<ReturnType<AgentHost['get']>>>> {
  let latest: Awaited<ReturnType<AgentHost['get']>> = null
  for (let attempt = 0; attempt < 500; attempt += 1) {
    latest = await host.get(taskId)
    if (latest && ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(latest.state)) return latest
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`portable Python smoke timeout: ${latest?.state ?? 'missing'} ${latest?.error?.code ?? ''}`)
}

test('opt-in portable Python ZIP→trust→restart→Host NDJSON smoke', { skip: !enabled, timeout: 120_000 }, async (t) => {
  const runtimeDir = process.env.CANAI_PORTABLE_PYTHON_RUNTIME_DIR
  assert.ok(runtimeDir, 'CANAI_PORTABLE_PYTHON_RUNTIME_DIR is required when CANAI_RUN_PORTABLE_PYTHON_SMOKE=1')
  const status = await inspectPythonRuntime(runtimeDir)
  assert.equal(status.supported, true)
  assert.equal(status.ready, true, status.reason)
  assert.ok(status.runtime)

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-python-smoke-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }))
  const validator = new AgentProtocolValidator()
  const library = new AgentPackageLibrary(path.join(root, 'agent-library.json'))
  const registry = new AgentPackageRegistry(validator, path.join(root, 'bundled'))
  const uploads = new AgentPackageUploadStore(path.join(root, 'agents'))
  const source = { resolve: async () => { throw new Error('portable Python smoke does not use Git') }, download: async () => { throw new Error('portable Python smoke does not use Git') } } as GitSourceTransport
  const manager = new AgentPackageManager({
    library, registry, uploads, source, validator, pythonRuntime: status.runtime, runtimeDir,
    packageRoot: path.join(root, 'agents', 'packages'), stateRoot: path.join(root, 'agents', 'state'), stagingRoot: path.join(root, 'agents', 'staging'),
  })
  const archive = smokeArchive()
  const uploaded = await manager.uploadArchive('portable-python-upload', archive, { name: 'portable-python-smoke' })
  const check = await manager.check({ requestId: 'portable-python-check', source: { kind: 'archive', archiveId: uploaded.archiveId } })
  assert.equal(check.supported, true)
  const installation = await manager.install({ requestId: 'portable-python-install', checkId: check.checkId, expectedRevision: check.revision, trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions })
  assert.equal(installation.status, 'ready')

  const restartedRegistry = new AgentPackageRegistry(validator, path.join(root, 'bundled'))
  const restarted = new AgentPackageManager({
    library: new AgentPackageLibrary(path.join(root, 'agent-library.json')), registry: restartedRegistry, uploads, source, validator, pythonRuntime: status.runtime, runtimeDir,
    packageRoot: path.join(root, 'agents', 'packages'), stateRoot: path.join(root, 'agents', 'state'), stagingRoot: path.join(root, 'agents', 'staging'),
  })
  await restarted.initialize()
  const journal = new AgentTaskJournal(path.join(root, 'agent-tasks.json'), { workspaceRoot: path.join(root, 'workspaces'), checkpointRoot: path.join(root, 'checkpoints') })
  const broker = {
    prepareLlmTask: () => undefined,
    llmStartAccess: () => ({ connections: [], grants: [] }),
    llmCatalog: () => ({ revision: 0, connection: { id: 'local-fal', kind: 'llm', status: 'unavailable' }, defaultModelId: null, models: [] }),
    cancelExternal: async () => {},
  } as never
  const host = new AgentHost({ journal, packages: restartedRegistry, broker, workspaceRoot: path.join(root, 'workspaces'), validator, runtimeDir })
  t.after(() => host.close())
  const task = await host.create({ requestId: 'portable-python-task', packageId: 'canai.python.smoke', taskType: 'echo', instruction: 'Проверить русский NDJSON', input: { message: 'Привет' }, projectRef: { source: 'local', id: 'portable-python-smoke' }, inputs: [] })
  const finished = await waitForTask(host, task.taskId)
  assert.equal(finished.state, 'succeeded', finished.error?.message)
  const finishedSummary = 'Привет, CanAI — stdlib NDJSON smoke'
  const finishedEvent = (await journal.events(task.taskId)).find((event) => event.type === 'task.finished')
  assert.equal(finishedEvent?.payload.summary, finishedSummary)
  const reloadedJournal = new AgentTaskJournal(path.join(root, 'agent-tasks.json'), { workspaceRoot: path.join(root, 'workspaces'), checkpointRoot: path.join(root, 'checkpoints') })
  const reloadedTask = await reloadedJournal.get(task.taskId)
  assert.equal(reloadedTask?.state, 'succeeded')
  const reloadedFinished = (await reloadedJournal.events(task.taskId)).find((event) => event.type === 'task.finished')
  assert.equal(reloadedFinished?.payload.summary, finishedSummary)

  const moduleUpload = await restarted.uploadArchive('portable-python-module-upload', smokeArchive('canai.python.smoke.module', true), { name: 'portable-python-module-smoke' })
  const moduleCheck = await restarted.check({ requestId: 'portable-python-module-check', source: { kind: 'archive', archiveId: moduleUpload.archiveId } })
  assert.equal(moduleCheck.supported, true)
  const moduleInstallation = await restarted.install({ requestId: 'portable-python-module-install', checkId: moduleCheck.checkId, expectedRevision: moduleCheck.revision, trustConfirmed: true, approvedPermissions: moduleCheck.trust.requiredPermissions })
  assert.equal(moduleInstallation.status, 'ready')
  const moduleTask = await host.create({ requestId: 'portable-python-module-task', packageId: 'canai.python.smoke.module', taskType: 'echo', instruction: 'Проверить module entrypoint', input: { message: 'Привет' }, projectRef: { source: 'local', id: 'portable-python-smoke' }, inputs: [] })
  const moduleFinished = await waitForTask(host, moduleTask.taskId)
  assert.equal(moduleFinished.state, 'succeeded', moduleFinished.error?.message)
  const moduleFinishedEvent = (await journal.events(moduleTask.taskId)).find((event) => event.type === 'task.finished')
  assert.equal(moduleFinishedEvent?.payload.summary, finishedSummary)
})

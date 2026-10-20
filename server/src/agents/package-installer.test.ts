import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, it } from 'node:test'
import { AgentPackageLibrary } from './library.js'
import { extractPackageArchive } from './package-archive.js'
import { AgentPackageManager, defaultPackageManager } from './package-manager.js'
import { AgentPackageRegistry } from './packages.js'
import { AgentPackageUploadStore } from './package-upload.js'
import type { GitSourceTransport, ResolvedGitSource } from './package-source.js'
import { AgentProtocolValidator } from './validation.js'
import { AgentHost } from './host.js'
import { AgentHostAdmission } from './host-admission.js'
import { AgentTaskJournal } from './journal.js'
import { AgentToolBroker } from './tools.js'
import type { RuntimeMetadata } from './package-check.js'
import { AGENT_LLM_CONNECTION, AgentLlmBroker, type AgentLlmProvider } from './llm-broker.js'
import { AGENT_GENERATION_CONNECTION } from './generation-broker.js'
import { safeEnvironment } from './host-wire.js'
import { createDefaultPackageProbe } from './package-probe.js'
import type { CatalogModel } from '../../../packages/model-catalog/catalog.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })))
})

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

function zip(entries: Array<{ name: string; data: Buffer; method?: 0 | 8; mode?: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const compressed = entry.method === 8 ? zlib.deflateRawSync(entry.data) : entry.data
    const local = Buffer.alloc(30 + name.length + compressed.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(entry.method ?? 0, 8)
    local.writeUInt32LE(crc32(entry.data), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    compressed.copy(local, 30 + name.length)
    locals.push(local)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.mode ? 0x0314 : 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(entry.method ?? 0, 10)
    central.writeUInt32LE(crc32(entry.data), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(entry.mode ? (entry.mode << 16) >>> 0 : 0, 38)
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

type FixtureConnection = {
  id: string
  label: string
  kind: 'llm' | 'generation' | 'external' | 'browser'
  required: boolean
}

function fixtureArchive(id = 'fixture.agent', version = '1.0.0', options: {
  permissions?: string[]
  connections?: FixtureConnection[]
} = {}): Buffer {
  const manifest = {
    schemaVersion: 1, id, name: 'Fixture', description: 'installer fixture', version, protocolVersion: '1.0',
    runtime: { kind: 'node', version: '20.0', entrypoint: { kind: 'file', path: 'index.mjs' }, dependencies: { kind: 'stdlib' }, maxParallelTasks: 1 },
    taskTypes: [{ id: 'plan', label: 'Plan', description: 'Plan', inputSchema: 'schemas/plan.json', outputKinds: ['plan'] }],
    permissions: options.permissions ?? ['artifact.publish', 'review.request'], connections: options.connections ?? [], lifecycle: { pause: 'checkpoint', resume: true, cancel: true },
  }
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, properties: { theme: { type: 'string', minLength: 1, maxLength: 20 } } }
  return zip([
    { name: 'fixture-root/canai.agent.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: 'fixture-root/index.mjs', data: Buffer.from('process.stdout.write("hello")') },
    { name: 'fixture-root/schemas/plan.json', data: Buffer.from(JSON.stringify(schema)), method: 8 },
  ])
}

function hello(installationId: string) {
  return {
    protocolVersion: '1.0' as const, messageId: 'probe-hello', taskId: 'probe', executionId: installationId, type: 'hello' as const,
    payload: { supportedProtocolVersions: ['1.0'], capabilities: ['resume', 'cancel', 'pause.checkpoint', 'structuredReviews', 'toolBroker'] },
  }
}

async function managerFixture(admission?: AgentHostAdmission, activeTaskPins?: () => Promise<Set<string>>, runtimeDetector?: () => Promise<RuntimeMetadata>) {
  const root = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'canai-installer-'))
  temporaryRoots.push(root)
  let archive = fixtureArchive()
  let resolved: ResolvedGitSource = { kind: 'git', canonicalUrl: 'https://github.com/acme/fixture', requestedRef: 'main', resolvedSha: 'a'.repeat(40), archiveUrl: 'https://api.github.com/repos/acme/fixture/zipball/' + 'a'.repeat(40) }
  const source: GitSourceTransport = { resolve: async () => resolved, download: async () => archive }
  const validator = new AgentProtocolValidator()
  const runtime = { version: '25.2.1', integrity: 'runtime-fixture', environmentId: 'node-fixture' }
  const registry = new AgentPackageRegistry(validator, path.join(root, 'bundled'))
  const library = new AgentPackageLibrary(path.join(root, 'agent-library.json'))
  const uploads = new AgentPackageUploadStore(path.join(root, 'agents'))
  const manager = new AgentPackageManager({
    library, registry, source, validator, runtime,
    packageRoot: path.join(root, 'agents', 'packages'), stateRoot: path.join(root, 'agents', 'state'), stagingRoot: path.join(root, 'agents', 'staging'),
    uploads,
    probe: async ({ installationId }) => ({ hello: hello(installationId) }),
    runtimeDetector: runtimeDetector ?? (async () => runtime),
    ...(admission ? { packageLifecycleLock: <T>(operation: () => Promise<T>) => admission.withPackageLifecycleLock(operation) } : {}),
    ...(activeTaskPins ? { activeTaskPins } : {}),
  })
  return {
    manager, library, root, source, runtime, validator, registry, uploads,
    setArchive(next: Buffer, sha = 'b'.repeat(40)) {
      archive = next
      resolved = { ...resolved, resolvedSha: sha, archiveUrl: 'https://api.github.com/repos/acme/fixture/zipball/' + sha }
    },
  }
}

async function freshManager(fixture: Awaited<ReturnType<typeof managerFixture>>) {
  const restoredLibrary = new AgentPackageLibrary(path.join(fixture.root, 'agent-library.json'))
  const restoredRegistry = new AgentPackageRegistry(fixture.validator, path.join(fixture.root, 'bundled'))
  const restored = new AgentPackageManager({
    library: restoredLibrary, registry: restoredRegistry, source: fixture.source, validator: fixture.validator, runtime: fixture.runtime,
    packageRoot: path.join(fixture.root, 'agents', 'packages'), stateRoot: path.join(fixture.root, 'agents', 'state'), stagingRoot: path.join(fixture.root, 'agents', 'staging'),
    uploads: fixture.uploads,
    probe: async ({ installationId }) => ({ hello: hello(installationId) }),
    runtimeDetector: async () => fixture.runtime,
  })
  return { manager: restored, library: restoredLibrary, registry: restoredRegistry }
}

describe('agent package archive and installer', () => {
  it('keeps the configured portable runtime directory in the default manager factory', async () => {
    const root = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'canai-runtime-config-'))
    temporaryRoots.push(root)
    const runtimeDir = path.join(root, 'runtime')
    let inspected = ''
    const manager = defaultPackageManager({
      library: new AgentPackageLibrary(path.join(root, 'agent-library.json')),
      registry: new AgentPackageRegistry(new AgentProtocolValidator(), path.join(root, 'bundled')),
      source: { resolve: async () => { throw new Error('not used') }, download: async () => { throw new Error('not used') } },
      runtime: { version: '25.2.1', integrity: 'runtime-fixture', environmentId: 'node-fixture' },
      runtimeDir,
      packageRoot: path.join(root, 'packages'), stateRoot: path.join(root, 'state'), stagingRoot: path.join(root, 'staging'),
      pythonRuntimeInspector: async (directory) => {
        inspected = directory
        return { supported: true, ready: false, version: '3.13.16', rootRelative: 'runtime/python-3.13.16', reason: 'RUNTIME_BASELINE_REQUIRED' }
      },
    })
    const status = await manager.runtimeStatus()
    assert.equal(inspected, runtimeDir)
    assert.equal(status.supported, true)
    assert.equal(status.reason, 'RUNTIME_BASELINE_REQUIRED')
  })

  it('rejects traversal, collisions and symlinks before writing', async () => {
    const root = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'canai-archive-'))
    temporaryRoots.push(root)
    await assert.rejects(extractPackageArchive(zip([{ name: 'root/../escape.txt', data: Buffer.from('x') }]), path.join(root, 'out')), { code: 'ARCHIVE_INVALID' })
    await assert.rejects(extractPackageArchive(zip([{ name: 'root/Foo.txt', data: Buffer.from('x') }, { name: 'root/foo.txt', data: Buffer.from('y') }]), path.join(root, 'out')), { code: 'ARCHIVE_INVALID' })
    await assert.rejects(extractPackageArchive(zip([{ name: 'root/link', data: Buffer.from('x'), mode: 0o120000 }]), path.join(root, 'out')), { code: 'ARCHIVE_UNSUPPORTED' })
    const emptyOutput = path.join(root, 'empty-out')
    await extractPackageArchive(zip([{ name: 'root/empty.txt', data: Buffer.alloc(0), method: 8 }]), emptyOutput)
    assert.equal((await fs.stat(path.join(emptyOutput, 'empty.txt'))).size, 0)
  })

  it('rejects a ZIP whose payload bytes no longer match its central-directory CRC', async () => {
    const root = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'canai-archive-crc-'))
    temporaryRoots.push(root)
    const archive = zip([{ name: 'root/index.mjs', data: Buffer.from('hello') }])
    // The local payload is after the 30-byte header and the UTF-8 filename.
    const filenameLength = archive.readUInt16LE(26)
    archive[30 + filenameLength] ^= 0x01
    await assert.rejects(extractPackageArchive(archive, path.join(root, 'out')), { code: 'ARCHIVE_INVALID' })
    assert.equal(await fs.stat(path.join(root, 'out', 'index.mjs')).catch(() => null), null)
  })

  it('checks, probes and installs an immutable pinned package with idempotent retry', async () => {
    const { manager } = await managerFixture()
    const check = await manager.check({ requestId: 'check-request', source: { kind: 'git', url: 'https://github.com/Acme/Fixture', ref: 'main' } })
    assert.equal(check.supported, true)
    assert.equal(check.source.resolvedSha, 'a'.repeat(40))
    assert.equal(check.manifest.taskTypes[0]?.inputSchema?.fields[0]?.kind, 'string')
    const installInput = { requestId: 'install-request', checkId: check.checkId, expectedRevision: check.revision, trustConfirmed: true as const, approvedPermissions: check.trust.requiredPermissions }
    const installation = await manager.install(installInput)
    assert.equal(installation.status, 'ready')
    assert.equal(installation.source.resolvedSha, 'a'.repeat(40))
    assert.deepEqual(await manager.install(installInput), installation)
    const library = await manager.list()
    assert.equal(library.installations?.length, 1)
    await assert.rejects(manager.install({ ...installInput, requestId: 'takeover', expectedRevision: library.revision }), { code: 'SOURCE_TAKEOVER_DENIED' })
  })

  it('rechecks the live Node runtime pin before the install probe', async () => {
    let detectorCalls = 0
    let probeCalls = 0
    const fixture = await managerFixture(undefined, undefined, async () => {
      detectorCalls += 1
      return { kind: 'node' as const, version: '25.2.1', integrity: 'changed-runtime', environmentId: 'changed-environment' }
    })
    const originalProbe = (fixture.manager as unknown as { probe: (input: unknown) => Promise<unknown> }).probe
    ;(fixture.manager as unknown as { probe: (input: unknown) => Promise<unknown> }).probe = async (input) => { probeCalls += 1; return originalProbe(input) }
    const check = await fixture.manager.check({ requestId: 'runtime-race-check', source: { kind: 'git', url: 'https://github.com/acme/fixture' } })
    await assert.rejects(fixture.manager.install({ requestId: 'runtime-race-install', checkId: check.checkId, expectedRevision: check.revision, trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions }), { code: 'RUNTIME_PIN_MISMATCH' })
    assert.equal(detectorCalls, 1)
    assert.equal(probeCalls, 0)
  })

  it('uploads an immutable ZIP, checks and installs it after a fresh manager restart', async () => {
    const fixture = await managerFixture()
    const archive = fixtureArchive('upload.agent', '1.0.0')
    const uploaded = await fixture.manager.uploadArchive('archive-upload', archive, { name: 'uploaded fixture', version: '1.0.0' })
    assert.equal(uploaded.sizeBytes, archive.length)
    assert.deepEqual(await fixture.manager.uploadArchive('archive-upload', archive, { name: 'uploaded fixture', version: '1.0.0' }), uploaded)
    await assert.rejects(fixture.manager.uploadArchive('archive-upload', Buffer.from('different')), { code: 'REQUEST_REUSE' })
    const check = await fixture.manager.check({ requestId: 'archive-check', source: { kind: 'archive', archiveId: uploaded.archiveId } })
    assert.equal(check.source.kind, 'archive')
    assert.equal(check.source.archiveSha, uploaded.archiveSha)
    const installation = await fixture.manager.install({ requestId: 'archive-install', checkId: check.checkId, expectedRevision: check.revision, trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions })
    assert.equal(installation.source.kind, 'archive')
    const restored = await freshManager(fixture)
    await restored.manager.initialize()
    assert.equal((await restored.manager.list()).installations?.find((entry) => entry.installationId === installation.installationId)?.status, 'ready')
  })

  it('checks and installs a Node LLM package with the exact local-fal connection', async () => {
    const fixture = await managerFixture()
    const archive = fixtureArchive('fixture.llm', '1.0.0', {
      permissions: ['llm.request'],
      connections: [{ id: AGENT_LLM_CONNECTION, label: 'Local fal', kind: 'llm', required: true }],
    })
    const uploaded = await fixture.manager.uploadArchive('llm-package-upload', archive, { name: 'LLM fixture', version: '1.0.0' })
    const check = await fixture.manager.check({ requestId: 'llm-package-check', source: { kind: 'archive', archiveId: uploaded.archiveId } })
    assert.equal(check.supported, true)
    assert.deepEqual(check.trust.requiredPermissions, ['llm.request'])
    const installation = await fixture.manager.install({
      requestId: 'llm-package-install', checkId: check.checkId, expectedRevision: check.revision,
      trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions,
    })
    assert.equal(installation.status, 'ready')
    assert.equal(fixture.registry.get('fixture.llm').manifest.permissions.includes('llm.request'), true)
  })

  it('checks and installs a Node generation package with the exact local-fal generation connection', async () => {
    const fixture = await managerFixture()
    const archive = fixtureArchive('fixture.generation', '1.0.0', {
      permissions: ['generation.request'],
      connections: [{ id: AGENT_GENERATION_CONNECTION, label: 'Local fal generation', kind: 'generation', required: true }],
    })
    const uploaded = await fixture.manager.uploadArchive('generation-package-upload', archive, { name: 'Generation fixture', version: '1.0.0' })
    const check = await fixture.manager.check({ requestId: 'generation-package-check', source: { kind: 'archive', archiveId: uploaded.archiveId } })
    assert.equal(check.supported, true)
    assert.deepEqual(check.trust.requiredPermissions, ['generation.request'])
    const installation = await fixture.manager.install({
      requestId: 'generation-package-install', checkId: check.checkId, expectedRevision: check.revision,
      trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions,
    })
    assert.equal(installation.status, 'ready')
    assert.equal(fixture.registry.get('fixture.generation').manifest.permissions.includes('generation.request'), true)
  })

  it('rejects unknown, orphaned and over-cardinalized LLM connections', async () => {
    const fixture = await managerFixture()
    const cases: Array<{ id: string; permissions: string[]; connections: FixtureConnection[]; code: string }> = [
      { id: 'fixture.llm-missing', permissions: ['llm.request'], connections: [], code: 'LLM_CONNECTION_REQUIRED' },
      { id: 'fixture.llm-external', permissions: ['llm.request'], connections: [{ id: 'remote', label: 'Remote', kind: 'external', required: true }], code: 'CONNECTION_UNSUPPORTED' },
      { id: 'fixture.llm-orphan', permissions: [], connections: [{ id: AGENT_LLM_CONNECTION, label: 'Local fal', kind: 'llm', required: true }], code: 'LLM_PERMISSION_REQUIRED' },
      { id: 'fixture.generation-missing', permissions: ['generation.request'], connections: [], code: 'GENERATION_CONNECTION_REQUIRED' },
      { id: 'fixture.generation-orphan', permissions: [], connections: [{ id: AGENT_GENERATION_CONNECTION, label: 'Local fal generation', kind: 'generation', required: true }], code: 'GENERATION_PERMISSION_REQUIRED' },
      { id: 'fixture.llm-many', permissions: ['llm.request'], connections: [
        { id: AGENT_LLM_CONNECTION, label: 'Local fal', kind: 'llm', required: true },
        { id: AGENT_LLM_CONNECTION, label: 'Local fal duplicate', kind: 'llm', required: true },
      ], code: 'CONNECTIONS_UNSUPPORTED' },
    ]
    for (const [index, entry] of cases.entries()) {
      const archive = fixtureArchive(entry.id, '1.0.0', { permissions: entry.permissions, connections: entry.connections })
      const uploaded = await fixture.manager.uploadArchive(`llm-reject-upload-${index}`, archive)
      const check = await fixture.manager.check({ requestId: `llm-reject-check-${index}`, source: { kind: 'archive', archiveId: uploaded.archiveId } })
      assert.equal(check.supported, false, entry.id)
      assert.ok(check.issues.some((issue) => issue.code === entry.code), `${entry.id}: missing ${entry.code}`)
    }
  })

  it('fails Host creation closed for missing consent and stale assistant catalog pins without an LLM submit', async () => {
    const fixture = await managerFixture()
    const archive = fixtureArchive('fixture.llm-host', '1.0.0', {
      permissions: ['llm.request'],
      connections: [{ id: AGENT_LLM_CONNECTION, label: 'Local fal', kind: 'llm', required: true }],
    })
    const uploaded = await fixture.manager.uploadArchive('llm-host-upload', archive, { name: 'LLM Host fixture', version: '1.0.0' })
    const check = await fixture.manager.check({ requestId: 'llm-host-check', source: { kind: 'archive', archiveId: uploaded.archiveId } })
    const installation = await fixture.manager.install({
      requestId: 'llm-host-install', checkId: check.checkId, expectedRevision: check.revision,
      trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions,
    })
    assert.equal(installation.status, 'ready')

    const journal = new AgentTaskJournal(path.join(fixture.root, 'llm-host-journal.json'), {
      workspaceRoot: path.join(fixture.root, 'llm-host-work'), checkpointRoot: path.join(fixture.root, 'llm-host-checkpoints'),
    })
    const catalogModel: CatalogModel = {
      id: 'assistant-test', name: 'Assistant test', kind: 'text', endpoint: 'openrouter/router', lifecycle: 'active',
      defaults: { model: 'test/model' }, textPricing: { inputPerMillion: 1, outputPerMillion: 1, checkedAt: '2026-10-01T00:00:00.000Z' }, contextWindowTokens: 20_000,
    }
    let providerCalls = 0
    const provider: AgentLlmProvider = {
      async submit() { providerCalls += 1; throw new Error('unexpected paid LLM submit') },
      async resume() { providerCalls += 1; throw new Error('unexpected paid LLM resume') },
      async cancel() { providerCalls += 1; throw new Error('unexpected paid LLM cancel') },
    }
    const llm = new AgentLlmBroker({
      journal,
      catalog: { models: () => [catalogModel], defaultModelId: () => catalogModel.id, view: () => ({ revision: 7 }) },
      provider,
      connectionReady: () => true,
    })
    const broker = new AgentToolBroker({ mediaDir: path.join(fixture.root, 'llm-host-media'), workspaceRoot: path.join(fixture.root, 'llm-host-work'), llm })
    const host = new AgentHost({ journal, packages: fixture.registry, broker, workspaceRoot: path.join(fixture.root, 'llm-host-work'), validator: fixture.validator })
    try {
      await assert.rejects(host.create({
        requestId: 'llm-host-no-consent', packageId: 'fixture.llm-host', taskType: 'plan', instruction: 'run', input: { theme: 'llm' },
        projectRef: { source: 'local', id: 'llm-board' },
      }), (error: unknown) => (error as { code?: string }).code === 'LLM_AUTH_REQUIRED')
      await assert.rejects(host.create({
        requestId: 'llm-host-stale-model', packageId: 'fixture.llm-host', taskType: 'plan', instruction: 'run', input: { theme: 'llm' },
        projectRef: { source: 'local', id: 'llm-board' },
        llm: { connectionId: AGENT_LLM_CONNECTION, textTransferConsent: true, maxCostMicros: 10_000, expectedModelId: 'stale-model', expectedCatalogRevision: 7 },
      }), (error: unknown) => (error as { code?: string }).code === 'LLM_MODEL_PIN_MISMATCH')
      assert.equal(providerCalls, 0)
      assert.equal((await journal.list()).length, 0)
    } finally {
      await host.close()
    }
  })

  it('fails closed on a structurally corrupt upload store without rewriting bytes', async () => {
    const root = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'canai-upload-corrupt-'))
    temporaryRoots.push(root)
    const file = path.join(root, 'uploads.json')
    const original = '{"version":1,"archives":null,"requests":null}\n'
    await fs.writeFile(file, original, 'utf8')
    const store = new AgentPackageUploadStore(root)
    await assert.rejects(store.load(), (error: unknown) => error && typeof error === 'object' && (error as { code?: unknown }).code === 'UPLOAD_STORE_INVALID')
    assert.equal(await fs.readFile(file, 'utf8'), original)
    await assert.rejects(store.read('upload-missing'), (error: unknown) => error && typeof error === 'object' && (error as { code?: unknown }).code === 'UPLOAD_STORE_INVALID')
    const corruptReceipt = `{"version":1,"archives":{},"requests":{"receipt":{"fingerprint":"${'a'.repeat(64)}","response":null,"createdAt":1}}}\n`
    await fs.writeFile(file, corruptReceipt, 'utf8')
    const receiptStore = new AgentPackageUploadStore(root)
    await assert.rejects(receiptStore.load(), (error: unknown) => error && typeof error === 'object' && (error as { code?: unknown }).code === 'UPLOAD_STORE_INVALID')
    assert.equal(await fs.readFile(file, 'utf8'), corruptReceipt)
  })

  it('serializes real Host create against disable before the active pin can be removed', async () => {
    const admission = new AgentHostAdmission()
    let hostRef: AgentHost | undefined
    const fixture = await managerFixture(admission, async () => new Set((await hostRef?.list() ?? []).filter((task) => !['cancelled', 'succeeded', 'failed'].includes(task.state)).flatMap((task) => task.installationId ? [task.installationId] : [])))
    const check = await fixture.manager.check({ requestId: 'host-race-check', source: { kind: 'git', url: 'https://github.com/acme/fixture' } })
    const installation = await fixture.manager.install({ requestId: 'host-race-install', checkId: check.checkId, expectedRevision: check.revision, trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions })
    const work = path.join(fixture.root, 'host-work')
    const journal = new AgentTaskJournal(path.join(fixture.root, 'host-journal.json'), { workspaceRoot: work, checkpointRoot: path.join(fixture.root, 'host-checkpoints') })
    const broker = new AgentToolBroker({ mediaDir: path.join(fixture.root, 'media'), workspaceRoot: work })
    const host = new AgentHost({ journal, packages: fixture.registry, broker, workspaceRoot: work, validator: fixture.validator, admission })
    hostRef = host
    try {
      const originalCreate = journal.create.bind(journal)
      let releaseCreate!: () => void
      let enteredCreate!: () => void
      const createEntered = new Promise<void>((resolve) => { enteredCreate = resolve })
      const createReleased = new Promise<void>((resolve) => { releaseCreate = resolve })
      ;(journal as unknown as { create: typeof journal.create }).create = async (task) => {
        enteredCreate()
        await createReleased
        return originalCreate(task)
      }
      const creating = host.create({
        requestId: 'host-race-create', packageId: 'fixture.agent', taskType: 'plan', instruction: 'race', input: { theme: 'race' },
        projectRef: { source: 'local', id: 'race-board' },
      })
      await createEntered
      const disabling = fixture.manager.manage('disable', { requestId: 'host-race-disable', expectedRevision: installation.revision, installationId: installation.installationId })
      const settledWhileCreateHeld = await Promise.race([disabling.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25))])
      assert.equal(settledWhileCreateHeld, false)
      releaseCreate()
      const created = await creating
      await assert.rejects(disabling, (error: unknown) => error && typeof error === 'object' && (error as { code?: unknown }).code === 'PACKAGE_IN_USE')
      let terminal = await journal.get(created.taskId)
      for (let attempt = 0; attempt < 200 && terminal && !['cancelled', 'succeeded', 'failed'].includes(terminal.state); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        terminal = await journal.get(created.taskId)
      }
      assert.ok(terminal && ['cancelled', 'succeeded', 'failed'].includes(terminal.state))
      const disabled = await fixture.manager.manage('disable', { requestId: 'host-race-disable-after', expectedRevision: installation.revision, installationId: installation.installationId })
      const removed = await fixture.manager.manage('remove', { requestId: 'host-race-remove-after', expectedRevision: disabled.revision, installationId: installation.installationId })
      assert.equal(removed.status, 'removed')
    } finally {
      await host.close()
    }
  })

  it('allows an archive-to-archive version update only with an explicit prior pin', async () => {
    const fixture = await managerFixture()
    const firstUpload = await fixture.manager.uploadArchive('archive-update-upload-1', fixtureArchive('archive-update.agent', '1.0.0'))
    const firstCheck = await fixture.manager.check({ requestId: 'archive-update-check-1', source: { kind: 'archive', archiveId: firstUpload.archiveId } })
    const first = await fixture.manager.install({ requestId: 'archive-update-install-1', checkId: firstCheck.checkId, expectedRevision: firstCheck.revision, trustConfirmed: true, approvedPermissions: firstCheck.trust.requiredPermissions })
    const secondUpload = await fixture.manager.uploadArchive('archive-update-upload-2', fixtureArchive('archive-update.agent', '2.0.0'))
    const secondCheck = await fixture.manager.check({ requestId: 'archive-update-check-2', source: { kind: 'archive', archiveId: secondUpload.archiveId } })
    await assert.rejects(fixture.manager.install({ requestId: 'archive-update-no-pin', checkId: secondCheck.checkId, expectedRevision: secondCheck.revision, trustConfirmed: true, approvedPermissions: secondCheck.trust.requiredPermissions }), { code: 'SOURCE_TAKEOVER_DENIED' })
    const second = await fixture.manager.install({ requestId: 'archive-update-install-2', checkId: secondCheck.checkId, expectedRevision: secondCheck.revision, trustConfirmed: true, approvedPermissions: secondCheck.trust.requiredPermissions, priorInstallationId: first.installationId })
    assert.equal(second.version, '2.0.0')
    assert.notEqual(second.source.archiveId, first.source.archiveId)
  })

  it('rejects changed uploaded bytes before extraction or probe', async () => {
    const fixture = await managerFixture()
    const archive = fixtureArchive('integrity.agent')
    const uploaded = await fixture.manager.uploadArchive('archive-integrity-upload', archive)
    await fs.writeFile(path.join(fixture.root, 'agents', 'uploads', `${uploaded.archiveId}.zip`), Buffer.from('changed'))
    await assert.rejects(fixture.manager.check({ requestId: 'archive-integrity-check', source: { kind: 'archive', archiveId: uploaded.archiveId } }), { code: 'ARCHIVE_INTEGRITY_INVALID' })
  })

  it('uses the exact runtime source pin and retains history when disabled', async () => {
    const { manager } = await managerFixture()
    const check = await manager.check({ requestId: 'check-2', source: { kind: 'git', url: 'https://github.com/acme/fixture' } })
    const installation = await manager.install({ requestId: 'install-2', checkId: check.checkId, expectedRevision: check.revision, trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions })
    const disabled = await manager.manage('disable', { requestId: 'disable-2', expectedRevision: installation.revision, installationId: installation.installationId })
    assert.equal(disabled.status, 'disabled')
    const enabled = await manager.manage('enable', { requestId: 'enable-2', expectedRevision: disabled.revision, installationId: installation.installationId })
    assert.equal(enabled.status, 'ready')
    assert.equal(enabled.runtime.integrity, 'runtime-fixture')
  })

  it('rechecks the persisted package tree before re-enabling an installation', async () => {
    const fixture = await managerFixture()
    const check = await fixture.manager.check({ requestId: 'recheck-check', source: { kind: 'git', url: 'https://github.com/acme/fixture' } })
    const installation = await fixture.manager.install({ requestId: 'recheck-install', checkId: check.checkId, expectedRevision: check.revision, trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions })
    const disabled = await fixture.manager.manage('disable', { requestId: 'recheck-disable', expectedRevision: installation.revision, installationId: installation.installationId })
    await fs.appendFile(path.join(fixture.root, 'agents', 'packages', installation.installationId, 'index.mjs'), '\ntampered before enable\n')
    await assert.rejects(fixture.manager.manage('enable', { requestId: 'recheck-enable', expectedRevision: disabled.revision, installationId: installation.installationId }), { code: 'PACKAGE_INTEGRITY_INVALID' })
    const after = await fixture.manager.list()
    assert.equal(after.revision, disabled.revision)
    assert.equal(after.installations?.find((entry) => entry.installationId === installation.installationId)?.status, 'disabled')
  })

  it('keeps the newer active pin when an older version is disabled and removed', async () => {
    const fixture = await managerFixture()
    const firstCheck = await fixture.manager.check({ requestId: 'version-1-check', source: { kind: 'git', url: 'https://github.com/acme/fixture' } })
    const first = await fixture.manager.install({ requestId: 'version-1-install', checkId: firstCheck.checkId, expectedRevision: firstCheck.revision, trustConfirmed: true, approvedPermissions: firstCheck.trust.requiredPermissions })
    fixture.setArchive(fixtureArchive('fixture.agent', '2.0.0'))
    const secondCheck = await fixture.manager.check({ requestId: 'version-2-check', source: { kind: 'git', url: 'https://github.com/acme/fixture' } })
    const second = await fixture.manager.install({ requestId: 'version-2-install', checkId: secondCheck.checkId, expectedRevision: secondCheck.revision, trustConfirmed: true, approvedPermissions: secondCheck.trust.requiredPermissions, priorInstallationId: first.installationId })
    const disabled = await fixture.manager.manage('disable', { requestId: 'version-1-disable', expectedRevision: second.revision, installationId: first.installationId })
    assert.equal(disabled.active, false)
    assert.equal((await fixture.manager.list()).installations?.find((entry) => entry.installationId === second.installationId)?.active, true)
    const removed = await fixture.manager.manage('remove', { requestId: 'version-1-remove', expectedRevision: disabled.revision, installationId: first.installationId })
    assert.equal(removed.status, 'removed')
    const restored = await freshManager(fixture)
    await restored.manager.initialize()
    const view = await restored.manager.list()
    assert.equal(view.installations?.find((entry) => entry.installationId === second.installationId)?.active, true)
    assert.deepEqual(view.packages.filter((entry) => entry.installationId && entry.active !== false).map((entry) => entry.installationId), [second.installationId])
    assert.equal(restored.registry.getPinned({ packageId: second.packageId, packageVersion: second.version, packageSha: second.packageSha, installationId: second.installationId }).installationId, second.installationId)
  })

  it('rejects enabling a failed installation before writing ready state', async () => {
    const fixture = await managerFixture()
    const check = await fixture.manager.check({ requestId: 'failed-check', source: { kind: 'git', url: 'https://github.com/acme/fixture' } })
    const installation = await fixture.manager.install({ requestId: 'failed-install', checkId: check.checkId, expectedRevision: check.revision, trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions })
    await fs.appendFile(path.join(fixture.root, 'agents', 'packages', installation.installationId, 'index.mjs'), '\ntampered\n')
    const restored = await freshManager(fixture)
    await restored.manager.initialize()
    const before = await restored.manager.list()
    const failed = before.installations?.find((entry) => entry.installationId === installation.installationId)!
    assert.equal(failed.status, 'failed')
    await assert.rejects(restored.manager.manage('enable', { requestId: 'failed-enable', expectedRevision: before.revision, installationId: installation.installationId }), (error: unknown) => error && typeof error === 'object' && (error as { code?: unknown }).code === 'INSTALLATION_UNAVAILABLE')
    await assert.rejects(restored.manager.manage('disable', { requestId: 'failed-disable', expectedRevision: before.revision, installationId: installation.installationId }), (error: unknown) => error && typeof error === 'object' && (error as { code?: unknown }).code === 'INSTALLATION_UNAVAILABLE')
    const after = await restored.manager.list()
    assert.equal(after.revision, before.revision)
    assert.equal(after.installations?.find((entry) => entry.installationId === installation.installationId)?.status, 'failed')
  })

  it('restores original staging after a library write failure so install retry is possible', async () => {
    const fixture = await managerFixture()
    const check = await fixture.manager.check({ requestId: 'retry-check', source: { kind: 'git', url: 'https://github.com/acme/fixture' } })
    const input = { requestId: 'retry-install', checkId: check.checkId, expectedRevision: check.revision, trustConfirmed: true as const, approvedPermissions: check.trust.requiredPermissions }
    const originalTransaction = fixture.library.transactionUnlocked.bind(fixture.library)
    const mutableLibrary = fixture.library as unknown as { transactionUnlocked: (expectedRevision: number | undefined, operation: (...args: any[]) => any) => Promise<any> }
    let failOnce = true
    mutableLibrary.transactionUnlocked = async (...args: [number | undefined, (...args: any[]) => any]) => {
      if (failOnce) { failOnce = false; throw new Error('simulated library write failure') }
      return originalTransaction(...args)
    }
    await assert.rejects(fixture.manager.install(input), /simulated library write failure/u)
    const staging = path.join(fixture.root, 'agents', 'staging', check.checkId)
    assert.equal((await fs.stat(staging)).isDirectory(), true)
    assert.equal((await fixture.manager.list()).installations?.length, 0)
    assert.equal((fixture.registry as unknown as { installations: Map<string, unknown> }).installations.size, 0)
    mutableLibrary.transactionUnlocked = originalTransaction
    const installation = await fixture.manager.install(input)
    assert.equal(installation.status, 'ready')
  })

  it('restores an installed pin, schema form and active pointer after a fresh manager', async () => {
    const { manager, root, source, runtime, validator } = await managerFixture()
    const check = await manager.check({ requestId: 'restart-check', source: { kind: 'git', url: 'https://github.com/acme/fixture' } })
    const installation = await manager.install({ requestId: 'restart-install', checkId: check.checkId, expectedRevision: check.revision, trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions })
    const restoredLibrary = new AgentPackageLibrary(path.join(root, 'agent-library.json'))
    const restoredRegistry = new AgentPackageRegistry(validator, path.join(root, 'bundled'))
    const restored = new AgentPackageManager({
      library: restoredLibrary, registry: restoredRegistry, source, validator, runtime,
      packageRoot: path.join(root, 'agents', 'packages'), stateRoot: path.join(root, 'agents', 'state'), stagingRoot: path.join(root, 'agents', 'staging'),
      probe: async ({ installationId }) => ({ hello: hello(installationId) }),
    })
    await restored.initialize()
    const view = await restored.list()
    assert.equal(view.installations?.[0]?.installationId, installation.installationId)
    assert.equal(view.packages.find((pkg) => pkg.installationId === installation.installationId)?.taskTypes[0]?.inputSchema?.fields[0]?.key, 'theme')
    assert.equal(restoredRegistry.getPinned({ packageId: installation.packageId, packageVersion: installation.version, packageSha: installation.packageSha, installationId: installation.installationId })?.installationId, installation.installationId)
  })

  it('fails closed on a corrupt library without overwriting the source file', async () => {
    const root = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'canai-library-corrupt-'))
    temporaryRoots.push(root)
    const file = path.join(root, 'agent-library.json')
    const original = '{"version":1,"revision":0,"installations":{"install-x":{"rootRelative":"../../outside"}}}\n'
    await fs.writeFile(file, original, 'utf8')
    await assert.rejects(new AgentPackageLibrary(file).load(), /agent-library\.json is corrupt/)
    assert.equal(await fs.readFile(file, 'utf8'), original)
  })

  it('supports packages declaring media.read and media.render permissions', async () => {
    const { manager, setArchive } = await managerFixture()
    setArchive(fixtureArchive('fixture.media', '1.0.0', { permissions: ['media.read', 'media.render', 'review.request'] }))
    const check = await manager.check({ requestId: 'check-media', source: { kind: 'git', url: 'https://github.com/acme/fixture' } })
    assert.equal(check.supported, true)
    assert.deepEqual(check.issues, [])
    assert.deepEqual(check.manifest.permissions, ['media.read', 'media.render', 'review.request'])
    const installation = await manager.install({
      requestId: 'install-media', checkId: check.checkId, expectedRevision: check.revision,
      trustConfirmed: true, approvedPermissions: check.trust.requiredPermissions,
    })
    assert.equal(installation.status, 'ready')
  })

  it('passes all 6 documented environment variables to safeEnvironment and package probe', async () => {
    const root = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'canai-env-test-'))
    temporaryRoots.push(root)
    const packageDir = path.join(root, 'pkg')
    const workDir = path.join(root, 'work')
    const stateDir = path.join(root, 'state')
    await fs.mkdir(packageDir, { recursive: true })
    await fs.mkdir(workDir, { recursive: true })
    await fs.mkdir(stateDir, { recursive: true })

    const env = safeEnvironment('task-env-1', 'exec-env-1', workDir, { packageDir, stateDir })
    assert.equal(env.CANAI_AGENT_PROTOCOL_VERSION, '1.0')
    assert.equal(env.CANAI_AGENT_TASK_ID, 'task-env-1')
    assert.equal(env.CANAI_AGENT_EXECUTION_ID, 'exec-env-1')
    assert.equal(env.CANAI_AGENT_PACKAGE_DIR, packageDir)
    assert.equal(env.CANAI_AGENT_WORK_DIR, workDir)
    assert.equal(env.CANAI_AGENT_STATE_DIR, stateDir)
    assert.equal(env.CANAI_AGENT_WORKSPACE, workDir)

    // Probe environment end-to-end with real runner
    const probeScript = path.join(packageDir, 'probe-script.mjs')
    const capturedFile = path.join(root, 'captured-env.json')
    await fs.writeFile(probeScript, `
      import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(capturedFile)}, JSON.stringify(process.env));
      process.stdout.write(JSON.stringify({
        protocolVersion: '1.0',
        messageId: 'probe-hello',
        taskId: 'probe',
        executionId: 'probe-exec-1',
        type: 'hello',
        payload: { supportedProtocolVersions: ['1.0'], capabilities: ['resume', 'cancel', 'pause.checkpoint'] }
      }) + '\\n');
    `)

    const runner = createDefaultPackageProbe(new AgentProtocolValidator())
    const probeResult = await runner({
      root: packageDir,
      entrypoint: probeScript,
      installationId: 'probe-exec-1',
      workspace: workDir,
    })
    assert.equal(probeResult.hello.type, 'hello')
    const captured = JSON.parse(await fs.readFile(capturedFile, 'utf8'))
    assert.equal(captured.CANAI_AGENT_PROTOCOL_VERSION, '1.0')
    assert.equal(captured.CANAI_AGENT_TASK_ID, 'probe')
    assert.equal(captured.CANAI_AGENT_EXECUTION_ID, 'probe-exec-1')
    assert.equal(captured.CANAI_AGENT_PACKAGE_DIR, packageDir)
    assert.equal(captured.CANAI_AGENT_WORK_DIR, workDir)
    assert.equal(captured.CANAI_AGENT_STATE_DIR, path.join(workDir, 'state'))
    assert.equal(captured.CANAI_AGENT_WORKSPACE, workDir)
  })
})

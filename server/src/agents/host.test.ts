import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { CatalogModel } from '../../../packages/model-catalog/catalog.js'
import { GenerationGate } from '../generationGate.js'
import { AgentTaskJournal } from './journal.js'
import { AgentPackageRegistry } from './packages.js'
import { AgentProtocolValidator } from './validation.js'
import { AgentHost, AgentHostError } from './host.js'
import { AgentToolBroker } from './tools.js'
import { AgentPaidRecovery } from './paid-recovery.js'
import { createSharedSpendBudget } from './tool-shared.js'
import {
  AGENT_LLM_CONNECTION,
  AgentLlmBroker,
  type AgentLlmCatalogSource,
  type AgentLlmProvider,
  type AgentLlmProviderResult,
} from './llm-broker.js'
import {
  AGENT_GENERATION_CONNECTION,
  AgentGenerationBroker,
  type AgentGenerationCatalogSource,
  type AgentGenerationJob,
  type AgentGenerationJobRunner,
} from './generation-broker.js'
import { digest } from './generation-broker-helpers.js'
import type { AgentTaskRecord } from './types.js'
import { packageTreeIntegrity } from './package-archive.js'
import { detectRuntimeMetadata } from './package-runtime.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const schemaDir = path.resolve(moduleDir, '../../../docs/agents')
const bundledRoot = path.resolve(moduleDir, 'bundled')

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-host-'))
  const work = path.join(root, 'work')
  const validator = new AgentProtocolValidator(schemaDir)
  const packages = new AgentPackageRegistry(validator, bundledRoot)
  await packages.loadBundled()
  const journal = new AgentTaskJournal(path.join(root, 'journal.json'), { workspaceRoot: work, checkpointRoot: path.join(root, 'checkpoints') })
  const broker = {
    prepareLlmTask() {
      // The bundled demo manifest has no llm.request permission.  Keep the
      // fixture's broker shape aligned with AgentToolBroker without enabling
      // paid LLM access in this offline test.
      return undefined
    },
    llmStartAccess() {
      return { connections: [], grants: [] }
    },
    llmCatalog() {
      return { revision: 0, connection: { id: 'local-fal', kind: 'llm', status: 'unavailable' }, defaultModelId: null, models: [] }
    },
    async cancelExternal() {},
    async execute(task: any, tool: string, args: any, operationId: string) {
      if (tool === 'artifact.publish') {
        const file = await fs.readFile(path.join(task.workspacePath, String(args.path)))
        const artifactId = `artifact-${task.taskId}-${operationId.replace(/[^A-Za-z0-9_-]/gu, '_')}`
        return { result: { artifact: { artifactId, revision: 1, checksum: crypto.createHash('sha256').update(file).digest('hex'), kind: 'plan', caption: String(args.caption), mimeType: String(args.mimeType), sizeBytes: file.length, mediaSrc: `/media/${artifactId}.txt`, provenance: 'generated', text: file.toString('utf8') } } }
      }
      if (tool === 'canvas.create_results') {
        const item = args.items[0]
        return { result: { workspaceId: String(args.workspaceId), items: [{ slotId: String(item.slotId), itemId: `agent-${task.taskId}-${item.slotId}`, revision: 1, artifactId: String(item.artifact.artifactId) }] } }
      }
      throw new Error(`unexpected tool ${tool}`)
    },
  } as unknown as AgentToolBroker
  const host = new AgentHost({ journal, packages, broker, workspaceRoot: work, validator })
  return { root, work, journal, packages, broker, host }
}

async function registerInstalledDemo(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const root = path.join(fixture.root, 'installed-demo')
  await fs.cp(path.join(bundledRoot, 'demo-agent'), root, { recursive: true })
  const tree = await packageTreeIntegrity(root)
  const runtime = await detectRuntimeMetadata()
  const installationId = 'install-host-pin'
  await fixture.packages.registerInstalled({
    installationId, root, packageSha: tree.packageSha, status: 'ready',
    source: { kind: 'git', canonicalUrl: 'https://github.com/acme/demo-agent', requestedRef: 'main', resolvedSha: 'a'.repeat(40) },
    runtime: { ...runtime, kind: 'node' },
  })
  return { root, installationId, packageSha: tree.packageSha }
}

async function waitForTask(host: AgentHost, taskId: string, predicate: (task: NonNullable<Awaited<ReturnType<AgentHost['get']>>>) => boolean): Promise<NonNullable<Awaited<ReturnType<AgentHost['get']>>>> {
  let last: Awaited<ReturnType<AgentHost['get']>> = null
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const task = await host.get(taskId)
    last = task
    if (task && predicate(task)) return task
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`agent task timeout: ${taskId} state=${last?.state} revision=${last?.revision} error=${last?.error?.code ?? 'none'} reviews=${last?.reviews.length ?? 0}`)
}

function request(input: Partial<Parameters<AgentHost['create']>[0]> = {}) {
  return {
    requestId: 'host-test-request', packageId: 'canai.demo', taskType: 'demo-plan', instruction: 'Create a deterministic plan',
    input: { sceneCount: 2, theme: 'test theme' }, projectRef: { source: 'local' as const, id: 'board-host-test' }, ...input,
  }
}

const recoveryLlmModel: CatalogModel = {
  id: 'host-recovery-llm', name: 'Host recovery LLM', kind: 'text', endpoint: 'openrouter/router', lifecycle: 'active',
  defaults: { model: 'host/recovery' }, textPricing: { inputPerMillion: 1, outputPerMillion: 1, checkedAt: '2026-10-01T00:00:00.000Z' }, contextWindowTokens: 20_000,
}
const recoveryGenerationModel: CatalogModel = {
  id: 'host-recovery-image', name: 'Host recovery image', kind: 'image', endpoint: 'host/recovery-image', lifecycle: 'active',
  pricing: { unit: 'image', usd: 0.001 }, params: [{ name: 'quality', label: 'Quality', widget: 'select', options: [{ value: 'fast', label: 'Fast' }] }],
}

class HostRecoveryLlmProvider implements AgentLlmProvider {
  submits = 0
  resumes = 0
  private readonly active = new Set<string>(['host-recovery-request-1'])
  failSubmit = true

  async submit(_model: CatalogModel, _messages: Array<{ role: 'system' | 'user' | 'assistant'; text: string }>, _maxTokens: number, onEnqueued: (requestId: string, endpoint: string) => Promise<void>): Promise<AgentLlmProviderResult> {
    this.submits += 1
    const requestId = `host-recovery-request-${this.submits}`
    this.active.add(requestId)
    await onEnqueued(requestId, 'openrouter/router')
    if (this.failSubmit) throw new Error('simulated interruption after durable LLM request ID')
    return { text: 'unexpected initial result', usage: { inputTokens: 1, outputTokens: 1, costMicros: 1_500 } }
  }

  async resume(_model: CatalogModel, requestId: string): Promise<AgentLlmProviderResult> {
    this.resumes += 1
    assert.ok(this.active.has(requestId))
    return { text: 'recovered LLM result', usage: { inputTokens: 3, outputTokens: 4, costMicros: 1_500 } }
  }

  async cancel(_model: CatalogModel, requestId: string): Promise<void> {
    this.active.delete(requestId)
  }
}

class HostRecoveryGenerationRunner implements AgentGenerationJobRunner {
  creates = 0
  gets = 0
  failGet = true
  readonly jobs = new Map<string, AgentGenerationJob>()

  async create(): Promise<{ jobId: string }> {
    this.creates += 1
    const jobId = `host-recovery-job-${this.creates}`
    this.jobs.set(jobId, {
      id: jobId, status: 'running', result: { url: '/media/host-recovery.png', mime: 'image/png' },
      chargedAmountUsd: 0.001, falRequestId: `host-recovery-fal-${this.creates}`,
    })
    return { jobId }
  }

  get(jobId: string): AgentGenerationJob | undefined {
    this.gets += 1
    if (this.failGet) throw new Error('simulated interruption after durable generation job ID')
    const job = this.jobs.get(jobId)
    return job ? structuredClone(job) : undefined
  }

  async cancel(jobId: string): Promise<void> { assert.ok(this.jobs.has(jobId)) }
}

function recoveryCatalogs(): {
  llm: AgentLlmCatalogSource & { setModel(model: CatalogModel): void }
  generation: AgentGenerationCatalogSource & { setModel(model: CatalogModel): void }
} {
  let llmModel = recoveryLlmModel
  let generationModel = recoveryGenerationModel
  return {
    llm: { models: () => [llmModel], defaultModelId: () => recoveryLlmModel.id, view: () => ({ revision: 11 }), setModel: (model) => { llmModel = model } },
    generation: { models: () => [generationModel], view: () => ({ revision: 11 }), setModel: (model) => { generationModel = model } },
  }
}

async function waitForJournalTask(journal: AgentTaskJournal, taskId: string, predicate: (task: AgentTaskRecord) => boolean): Promise<AgentTaskRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await journal.get(taskId)
    if (task && predicate(task)) return task
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('paid recovery did not settle before timeout')
}

test('bundled agent handshakes offline, publishes real plan, reviews, and creates one result', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })
  const created = await fixture.host.create(request())
  const duplicate = await fixture.host.create(request())
  assert.equal(duplicate.taskId, created.taskId)
  let task = await waitForTask(fixture.host, created.taskId, (entry) => entry.reviews.some((review) => review.status === 'pending'))
  const review = task.reviews.find((entry) => entry.status === 'pending')!
  const planPath = path.join(fixture.work, created.taskId, 'output', 'plan.txt')
  assert.match(await fs.readFile(planPath, 'utf8'), /CanAI demo demo-plan v1/u)
  await assert.rejects(fixture.host.decide(created.taskId, review.reviewId, { requestId: 'empty-comment', expectedRevision: task.revision, revision: review.revision, decision: 'rejected', comment: '' }), (error: unknown) => error instanceof AgentHostError && error.code === 'INPUT_INVALID')
  await assert.rejects(fixture.host.decide(created.taskId, review.reviewId, { requestId: 'stale-review', expectedRevision: task.revision - 1, revision: review.revision, decision: 'approved', comment: '' }), (error: unknown) => error instanceof AgentHostError && error.code === 'REVISION_CONFLICT')
  task = await fixture.host.decide(created.taskId, review.reviewId, { requestId: 'approve-host-test', expectedRevision: task.revision, revision: review.revision, decision: 'approved', comment: '', answers: {} })
  task = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'succeeded')
  assert.equal(task.receipts.filter((receipt) => receipt.status === 'succeeded').length, 2)
  assert.equal(task.artifacts.length, 1)
  assert.equal(task.canvasItems.length, 1)
  assert.equal(task.progress?.stageId, 'plan')
})

test('concurrent identical task creates are one durable request', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })
  const results = await Promise.all(Array.from({ length: 4 }, () => fixture.host.create(request({ requestId: 'parallel-create' }))))
  assert.equal(new Set(results.map((entry) => entry.taskId)).size, 1)
  assert.equal((await fixture.journal.list()).filter((entry) => entry.requestId === 'parallel-create').length, 1)
})

test('installed package tree and runtime pin are rechecked before spawn', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })
  const installed = await registerInstalledDemo(fixture)
  await fs.appendFile(path.join(installed.root, 'index.mjs'), '\n// changed after install\n')
  const created = await fixture.host.create(request({ requestId: 'tampered-installed-package' }))
  const failed = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'failed')
  assert.equal(failed.error?.code, 'PACKAGE_PIN_MISMATCH')
  assert.equal((fixture.host as unknown as { processes: { has(taskId: string): boolean } }).processes.has(created.taskId), false)
})

test('installed package runtime pin is rechecked on resume', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })
  const installed = await registerInstalledDemo(fixture)
  const created = await fixture.host.create(request({ requestId: 'runtime-pin-resume' }))
  let task = await waitForTask(fixture.host, created.taskId, (entry) => entry.reviews.some((review) => review.status === 'pending'))
  await fixture.host.control(created.taskId, 'pause', { requestId: 'runtime-pin-pause', expectedRevision: task.revision, reason: 'pin verification' })
  task = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'paused')
  await fixture.host.close()
  await fs.appendFile(path.join(installed.root, 'index.mjs'), '\n// changed while paused\n')
  const resumedHost = new AgentHost({ journal: fixture.journal, packages: fixture.packages, broker: fixture.broker, workspaceRoot: fixture.work, validator: new AgentProtocolValidator(schemaDir) })
  t.after(() => resumedHost.close())
  await resumedHost.control(created.taskId, 'resume', { requestId: 'runtime-pin-resume-command', expectedRevision: task.revision, reason: 'resume after package change' })
  task = await waitForTask(resumedHost, created.taskId, (entry) => entry.state === 'failed')
  assert.equal(task.error?.code, 'PACKAGE_PIN_MISMATCH')
})

test('concurrent start calls share one task admission', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })
  const created = await fixture.host.create(request({ requestId: 'start-race' }))
  await Promise.all([fixture.host.start(created.taskId), fixture.host.start(created.taskId), fixture.host.start(created.taskId)])
  const task = await waitForTask(fixture.host, created.taskId, (entry) => entry.reviews.some((review) => review.status === 'pending'))
  assert.equal(task.state, 'awaiting_review')
  assert.equal((fixture.host as unknown as { processes: { get(taskId: string): unknown } }).processes.get(created.taskId) !== undefined, true)
})

test('cancel during async pin verification cannot resurrect or spawn the task', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })
  let enterVerification!: () => void
  let releaseVerification!: () => void
  const entered = new Promise<void>((resolve) => { enterVerification = resolve })
  const released = new Promise<void>((resolve) => { releaseVerification = resolve })
  const internals = fixture.host as unknown as { verifyPinnedPackage: (pkg: unknown) => Promise<void> }
  const verify = internals.verifyPinnedPackage.bind(fixture.host)
  internals.verifyPinnedPackage = async (pkg) => { enterVerification(); await released; return verify(pkg) }
  const created = await fixture.host.create(request({ requestId: 'cancel-during-pin-check' }))
  await entered
  const queued = (await fixture.host.get(created.taskId))!
  await fixture.host.control(created.taskId, 'cancel', { requestId: 'cancel-before-spawn', expectedRevision: queued.revision, reason: 'cancel while package is being verified' })
  releaseVerification()
  const cancelled = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'cancelled')
  assert.equal(cancelled.state, 'cancelled')
  assert.equal((fixture.host as unknown as { processes: { has(taskId: string): boolean } }).processes.has(created.taskId), false)
})

test('changes-requested creates a new version and rejection never creates a canvas item', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })
  const created = await fixture.host.create(request({ requestId: 'changes-requested', input: { sceneCount: 2, theme: 'revision' } }))
  let task = await waitForTask(fixture.host, created.taskId, (entry) => entry.reviews.some((review) => review.status === 'pending'))
  let review = task.reviews.find((entry) => entry.status === 'pending')!
  task = await fixture.host.decide(created.taskId, review.reviewId, { requestId: 'request-changes', expectedRevision: task.revision, revision: review.revision, decision: 'changes-requested', comment: 'Please make another deterministic version' })
  task = await waitForTask(fixture.host, created.taskId, (entry) => entry.reviews.filter((entry) => entry.status === 'pending').length === 1 && entry.reviews.length >= 2)
  review = task.reviews.find((entry) => entry.status === 'pending')!
  assert.equal(task.artifacts.length, 2)
  task = await fixture.host.decide(created.taskId, review.reviewId, { requestId: 'reject-version', expectedRevision: task.revision, revision: review.revision, decision: 'rejected', comment: 'Not accepted for the demo' })
  task = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'failed')
  assert.equal(task.canvasItems.length, 0)
  assert.equal(task.reviews.filter((entry) => entry.status === 'rejected').length, 1)
})

test('pause survives process shutdown and resume restores checkpoint/review', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })
  const created = await fixture.host.create(request({ requestId: 'pause-restart', input: { sceneCount: 2, theme: 'pause' } }))
  let task = await waitForTask(fixture.host, created.taskId, (entry) => entry.reviews.some((review) => review.status === 'pending'))
  const pauseRequest = { requestId: 'pause-1', expectedRevision: task.revision, reason: 'test pause' }
  await fixture.host.control(created.taskId, 'pause', pauseRequest)
  task = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'paused')
  assert.ok(task.checkpoint?.checkpointId)
  await fixture.host.close()
  const resumedHost = new AgentHost({ journal: fixture.journal, packages: fixture.packages, broker: fixture.broker, workspaceRoot: fixture.work, validator: new AgentProtocolValidator(schemaDir) })
  t.after(() => resumedHost.close())
  await resumedHost.restore()
  task = await resumedHost.control(created.taskId, 'resume', { requestId: 'resume-1', expectedRevision: task.revision, reason: 'test resume' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  task = (await resumedHost.get(created.taskId))!
  task = await waitForTask(resumedHost, created.taskId, (entry) => entry.state === 'awaiting_review' && entry.reviews.some((review) => review.status === 'pending'))
  const review = task.reviews.find((entry) => entry.status === 'pending')!
  await resumedHost.decide(created.taskId, review.reviewId, { requestId: 'resume-approve', expectedRevision: task.revision, revision: review.revision, decision: 'approved', comment: '' })
  task = await waitForTask(resumedHost, created.taskId, (entry) => entry.state === 'succeeded')
  assert.equal(task.canvasItems.length, 1)
})

test('legacy shared delivery is rejected before local execution', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })
  await assert.rejects(fixture.host.create(request({ requestId: 'cloud-no-local', projectRef: { source: 'cloud' as never, id: 'cloud-board' } })), (error: unknown) => error instanceof AgentHostError && error.code === 'CLOUD_AGENT_DELIVERY_UNSUPPORTED' && error.status === 409)
  assert.deepEqual(await fixture.journal.list(), [])
})

test('attached local board uses pending receipt until the browser snapshot is durable', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) })
  const originalExecute = (fixture.broker.execute as unknown as (...args: any[]) => Promise<any>).bind(fixture.broker)
  ;(fixture.broker as unknown as { execute: (task: any, tool: any, args: any, operationId: string) => Promise<any> }).execute = async (task: any, tool: any, args: any, operationId: string) => {
    const result = await originalExecute(task, tool, args, operationId)
    if (tool === 'canvas.create_results') return { ...result, pending: { waitId: 'canvas-save:test' } }
    return result
  }
  const created = await fixture.host.create(request({ requestId: 'pending-local-delivery' }))
  let task = await waitForTask(fixture.host, created.taskId, (entry) => entry.reviews.some((review) => review.status === 'pending'))
  const review = task.reviews.find((entry) => entry.status === 'pending')!
  task = await fixture.host.decide(created.taskId, review.reviewId, { requestId: 'pending-approve', expectedRevision: task.revision, revision: review.revision, decision: 'approved', comment: '' })
  task = await waitForTask(fixture.host, created.taskId, (entry) => entry.pendingCanvasItems.length === 1)
  const pending = task.pendingCanvasItems[0]!
  assert.equal(task.canvasItems.length, 0)
  assert.equal(task.receipts.find((entry) => entry.operationId === pending.operationId)?.status, 'pending')
  await fixture.host.acknowledgeCanvasDelivery('board-host-test', { items: [{ id: pending.itemId }] })
  task = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'succeeded')
  assert.equal(task.canvasItems.length, 1)
  assert.equal(task.receipts.find((entry) => entry.operationId === pending.operationId)?.status, 'succeeded')
})

test('identical controls are serialized and replay the durable receipt', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) })
  const created = await fixture.host.create(request({ requestId: 'control-race' }))
  const waiting = await waitForTask(fixture.host, created.taskId, (entry) => entry.reviews.some((review) => review.status === 'pending'))
  const pause = { requestId: 'pause-race', expectedRevision: waiting.revision, reason: 'race regression' }
  const [first, second] = await Promise.all([
    fixture.host.control(created.taskId, 'pause', pause),
    fixture.host.control(created.taskId, 'pause', pause),
  ])
  assert.equal(first.revision, second.revision)
  const paused = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'paused')
  const replayed = await fixture.host.control(created.taskId, 'pause', pause)
  assert.equal(replayed.revision, paused.revision)
  assert.equal(replayed.controlReceipts[pause.requestId]?.resultRevision, paused.controlReceipts[pause.requestId]?.resultRevision)
})

test('competing review decisions have one winner and an exact retry replays it', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) })
  const created = await fixture.host.create(request({ requestId: 'decision-race' }))
  const waiting = await waitForTask(fixture.host, created.taskId, (entry) => entry.reviews.some((review) => review.status === 'pending'))
  const review = waiting.reviews.find((entry) => entry.status === 'pending')!
  const decisionA = { requestId: 'decision-race-a', expectedRevision: waiting.revision, revision: review.revision, decision: 'approved' as const, comment: '', answers: {} }
  const decisionB = { requestId: 'decision-race-b', expectedRevision: waiting.revision, revision: review.revision, decision: 'approved' as const, comment: '', answers: {} }
  const outcomes = await Promise.allSettled([
    fixture.host.decide(created.taskId, review.reviewId, decisionA),
    fixture.host.decide(created.taskId, review.reviewId, decisionB),
  ])
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1)
  const rejected = outcomes.find((entry) => entry.status === 'rejected')
  assert.ok(rejected && rejected.status === 'rejected')
  assert.ok(rejected.reason instanceof AgentHostError)
  assert.equal(rejected.reason.code, 'REVISION_CONFLICT')
  const winnerIndex = outcomes.findIndex((entry) => entry.status === 'fulfilled')
  const winnerRequest = winnerIndex === 0 ? decisionA : decisionB
  const current = (await fixture.host.get(created.taskId))!
  const replayed = await fixture.host.decide(created.taskId, review.reviewId, winnerRequest)
  assert.equal(replayed.taskId, created.taskId)
  assert.ok(replayed.decisionReceipts[winnerRequest.requestId])
  assert.equal(replayed.decisions.length, current.decisions.length)
})

test('pending review and paused state reject late side effects, progress, and success', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) })
  const calls: string[] = []
  const originalExecute = (fixture.broker.execute as unknown as (...args: any[]) => Promise<any>).bind(fixture.broker)
  ;(fixture.broker as unknown as { execute: (...args: any[]) => Promise<any> }).execute = async (...args: any[]) => {
    calls.push(String(args[1]))
    return originalExecute(...args)
  }
  const created = await fixture.host.create(request({ requestId: 'late-protocol-gates' }))
  let task = await waitForTask(fixture.host, created.taskId, (entry) => entry.reviews.some((review) => review.status === 'pending'))
  const internals = fixture.host as unknown as {
    protocol: { handleLine(taskId: string, managed: any, line: string): Promise<void> }
    processes: { get(taskId: string): any }
  }
  const managed = internals.processes.get(created.taskId)
  assert.ok(managed)
  calls.length = 0
  const send = (messageId: string, type: string, payload: Record<string, unknown>) => internals.protocol.handleLine(created.taskId, managed, JSON.stringify({
    protocolVersion: '1.0', messageId, taskId: created.taskId, executionId: managed.executionId, type, payload,
  }))
  await send('late-tool', 'tool.request', {
    operationId: 'late-side-effect', tool: 'canvas.create_results', arguments: {
      workspaceId: task.workspaceId,
      items: [{ slotId: 'late', artifact: { artifactId: 'missing', revision: 1, checksum: '0'.repeat(64) }, caption: 'late' }],
    },
  })
  await send('late-progress', 'task.progress', { stageId: 'plan', label: 'late running', status: 'running' })
  await send('late-finish', 'task.finished', { outcome: 'succeeded', summary: 'late', artifactIds: [] })
  task = (await fixture.host.get(created.taskId))!
  assert.equal(task.state, 'awaiting_review')
  assert.equal(calls.filter((tool) => tool === 'canvas.create_results').length, 0)
  assert.equal(task.receipts.some((receipt) => receipt.operationId === 'late-side-effect'), false)

  await fixture.host.control(created.taskId, 'pause', { requestId: 'late-pause', expectedRevision: task.revision, reason: 'gate test' })
  task = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'paused')
  await send('paused-finish', 'task.finished', { outcome: 'succeeded', summary: 'paused late', artifactIds: [] })
  assert.equal((await fixture.host.get(created.taskId))?.state, 'paused')
})

test('review decisions cannot revive paused or cancelled tasks', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) })
  const created = await fixture.host.create(request({ requestId: 'review-state-gates' }))
  let task = await waitForTask(fixture.host, created.taskId, (entry) => entry.reviews.some((review) => review.status === 'pending'))
  let review = task.reviews.find((entry) => entry.status === 'pending')!
  await fixture.host.control(created.taskId, 'pause', { requestId: 'review-state-pause', expectedRevision: task.revision, reason: 'pause before decision' })
  task = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'paused')
  await assert.rejects(
    fixture.host.decide(created.taskId, review.reviewId, { requestId: 'paused-decision', expectedRevision: task.revision, revision: review.revision, decision: 'approved', comment: '' }),
    (error: unknown) => error instanceof AgentHostError && error.code === 'TASK_NOT_RUNNING',
  )

  const resumed = await fixture.host.control(created.taskId, 'resume', { requestId: 'review-state-resume', expectedRevision: task.revision, reason: 'resume for cancel gate' })
  task = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'awaiting_review' && entry.revision >= resumed.revision)
  review = task.reviews.find((entry) => entry.status === 'pending')!
  await fixture.host.control(created.taskId, 'cancel', { requestId: 'review-state-cancel', expectedRevision: task.revision, reason: 'cancel before decision' })
  task = await waitForTask(fixture.host, created.taskId, (entry) => entry.state === 'cancelled')
  await assert.rejects(
    fixture.host.decide(created.taskId, review.reviewId, { requestId: 'cancelled-decision', expectedRevision: task.revision, revision: review.revision, decision: 'approved', comment: '' }),
    (error: unknown) => error instanceof AgentHostError && error.code === 'TASK_NOT_RUNNING',
  )
})

test('Host restore reconciles held cancelled paid operations without starting or publishing the task', async (t) => {
  const base = await createFixture()
  await base.host.close()
  const mediaDir = path.join(base.root, 'media')
  await fs.mkdir(mediaDir, { recursive: true })
  await fs.writeFile(path.join(mediaDir, 'host-recovery.png'), 'fake native recovery bytes')
  const journal = new AgentTaskJournal(path.join(base.root, 'journal.json'), { workspaceRoot: base.work, checkpointRoot: path.join(base.root, 'checkpoints') })
  const catalogs = recoveryCatalogs()
  const llmProvider = new HostRecoveryLlmProvider()
  const generationRunner = new HostRecoveryGenerationRunner()
  const llm = new AgentLlmBroker({ journal, catalog: catalogs.llm, provider: llmProvider, generationGate: new GenerationGate(), connectionReady: () => true })
  const generation = new AgentGenerationBroker({ journal, catalog: catalogs.generation, provider: generationRunner, generationGate: new GenerationGate(), connectionReady: () => true, mediaDir, pollMs: 1 })
  const taskId = 'host-paid-recovery'
  const llmBudget = llm.prepareTask(taskId, 'local', ['llm.request'], {
    connectionId: AGENT_LLM_CONNECTION, textTransferConsent: true, maxCostMicros: 100_000,
    expectedModelId: recoveryLlmModel.id, expectedCatalogRevision: 11,
  })!
  const generationBudget = generation.prepareTask(taskId, 'local', ['generation.request'], {
    connectionId: AGENT_GENERATION_CONNECTION, mediaTransferConsent: true, maxCostMicros: 100_000,
    expectedModelId: recoveryGenerationModel.id, expectedCatalogRevision: 11, artifactRefs: [],
  })!
  const prompt = 'Recover the cancelled task'
  const params = { quality: 'fast' }
  const task: AgentTaskRecord = {
    taskId, requestId: 'host-paid-recovery-request', requestHash: 'host-paid-recovery-hash', packageId: 'test', packageVersion: '1', packageSha: 'a'.repeat(64), protocolVersion: '1.0',
    projectRef: { source: 'local', id: 'host-paid-recovery-board' }, ownerId: 'owner', controllerId: 'controller', taskType: 'paid-recovery', instruction: 'recover', input: {}, inputs: [],
    workspaceId: 'host-paid-recovery-workspace', workspacePath: 'host-paid-recovery', state: 'cancelled', revision: 1, eventCursor: 0, currentMessageAcks: {}, operationIntents: {}, controlReceipts: {}, decisionReceipts: {},
    llmBudget, llmOperations: [], generationBudget, generationOperations: [], spendBudget: createSharedSpendBudget(taskId, llmBudget, generationBudget),
    receipts: [], reviews: [{
      reviewId: 'host-paid-recovery-review', revision: 1, stageId: 'generation', title: 'Generation', question: 'Approve generation', materials: [], decisions: ['approved', 'changes-requested', 'rejected'], status: 'approved', createdAt: 1,
      generationSpec: { kind: 'image', modelId: recoveryGenerationModel.id, catalogRevision: 11, promptHash: digest(prompt), refs: [], paramsHash: digest(params), prompt, params: structuredClone(params), estimateMicros: 1_000 },
    }], decisions: [], artifacts: [], canvasItems: [], pendingCanvasItems: [], createdAt: 1, updatedAt: 1,
  }
  task.llmOperations = [{
    operationId: 'host-llm-recovery', requestId: 'host-llm-recovery', argumentsHash: 'llm-arguments', receiptId: 'host-llm-recovery', status: 'cancelled',
    modelId: recoveryLlmModel.id, catalogRevision: 11, modelSnapshot: structuredClone(recoveryLlmModel), reservedMicros: 1_500,
    providerRequestId: 'host-recovery-request-1', createdAt: 1, updatedAt: 1,
    error: { code: 'LLM_CANCELLED', message: 'cancelled while the provider result was held', retryable: true },
  }]
  task.generationOperations = [{
    operationId: 'host-generation-recovery', requestId: 'host-generation-recovery', argumentsHash: 'generation-arguments', receiptId: 'host-generation-recovery', status: 'cancelled',
    modelId: recoveryGenerationModel.id, catalogRevision: 11, modelSnapshot: structuredClone(recoveryGenerationModel), reservedMicros: 1_000,
    jobId: 'host-recovery-job-1', providerRequestId: 'host-recovery-fal-1', createdAt: 1, updatedAt: 1,
    error: { code: 'GENERATION_CANCELLED', message: 'cancelled while the provider result was held', retryable: true },
  }]
  task.llmOperations.push({
    operationId: 'host-unknown-no-id', requestId: 'host-unknown-no-id', argumentsHash: 'unknown', receiptId: 'host-unknown-no-id', status: 'reserved',
    modelId: recoveryLlmModel.id, catalogRevision: 11, modelSnapshot: structuredClone(recoveryLlmModel), reservedMicros: 1, createdAt: 1, updatedAt: 1,
  })
  task.llmBudget!.calls = 2
  task.llmBudget!.reservedMicros = 1_501
  task.llmBudget!.status = 'blocked'
  task.generationBudget!.calls = 1
  task.generationBudget!.reservedMicros = 1_000
  task.generationBudget!.status = 'blocked'
  task.spendBudget!.calls = 3
  task.spendBudget!.reservedMicros = 2_501
  task.spendBudget!.status = 'blocked'
  generationRunner.jobs.set('host-recovery-job-1', {
    id: 'host-recovery-job-1', status: 'done', result: { url: '/media/host-recovery.png', mime: 'image/png' },
    chargedAmountUsd: 0.001, falRequestId: 'host-recovery-fal-1',
  })
  await journal.create(task)
  catalogs.llm.setModel({ ...recoveryLlmModel, lifecycle: 'disabled', defaults: { model: 'changed/model' }, contextWindowTokens: 1 })
  catalogs.generation.setModel({ ...recoveryGenerationModel, lifecycle: 'disabled', pricing: { unit: 'image', usd: 0.9 }, params: [] })
  llmProvider.failSubmit = false
  generationRunner.failGet = false

  const restartedJournal = new AgentTaskJournal(path.join(base.root, 'journal.json'), { workspaceRoot: base.work, checkpointRoot: path.join(base.root, 'checkpoints') })
  const restartedLlm = new AgentLlmBroker({ journal: restartedJournal, catalog: catalogs.llm, provider: llmProvider, generationGate: new GenerationGate(), connectionReady: () => true })
  const restartedGeneration = new AgentGenerationBroker({ journal: restartedJournal, catalog: catalogs.generation, provider: generationRunner, generationGate: new GenerationGate(), connectionReady: () => true, mediaDir, pollMs: 1 })
  const restartedHost = new AgentHost({
    journal: restartedJournal,
    packages: base.packages,
    broker: new AgentToolBroker({ mediaDir, workspaceRoot: base.work, llm: restartedLlm, generation: restartedGeneration }),
    workspaceRoot: base.work,
    mediaDir,
    validator: new AgentProtocolValidator(schemaDir),
  })
  t.after(async () => { await restartedHost.close(); await base.host.close(); await fs.rm(base.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })
  await restartedHost.restore()
  const recovered = await waitForJournalTask(restartedJournal, taskId, (entry) => entry.llmOperations?.some((operation) => operation.status === 'succeeded') === true
    && entry.generationOperations?.some((operation) => operation.status === 'succeeded') === true
    && entry.llmOperations?.some((operation) => operation.operationId === 'host-unknown-no-id' && operation.status === 'uncertain') === true)
  assert.equal(llmProvider.submits, 0)
  assert.equal(llmProvider.resumes, 1)
  assert.equal(generationRunner.creates, 0)
  assert.equal(recovered.state, 'cancelled')
  assert.deepEqual(recovered.artifacts, [])
  assert.deepEqual(recovered.canvasItems, [])
  assert.equal(recovered.llmBudget!.chargedMicros, 2_500)
  assert.equal(recovered.generationBudget!.chargedMicros, 2_500)
  assert.equal(recovered.spendBudget!.chargedMicros, 2_500)
  assert.equal(recovered.spendBudget!.status, 'blocked')

  await restartedHost.restore()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(llmProvider.submits, 0)
  assert.equal(llmProvider.resumes, 1)
  assert.equal(generationRunner.creates, 0)
  const repeated = (await restartedJournal.get(taskId))!
  assert.equal(repeated.state, 'cancelled')
  assert.equal(repeated.llmOperations!.find((operation) => operation.operationId === 'host-unknown-no-id')!.status, 'uncertain')
})

test('paid recovery retries are bounded and close cancels pending backoff', async (t) => {
  let attempts = 0
  const recovery = new AgentPaidRecovery({
    retryDelaysMs: [0, 100],
    recover: async () => { attempts += 1; throw new Error('provider unavailable') },
  })
  t.after(() => recovery.close())
  const task = { taskId: 'paid-recovery-backoff', llmOperations: [{ status: 'submitted' }], generationOperations: [] } as unknown as AgentTaskRecord
  recovery.start([task])
  for (let tick = 0; tick < 20 && attempts === 0; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(attempts, 1)
  recovery.close()
  await new Promise((resolve) => setTimeout(resolve, 130))
  assert.equal(attempts, 1)
})

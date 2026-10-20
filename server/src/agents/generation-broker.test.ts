import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentLlmBudgetView } from '../../../packages/agent-protocol/index.js'
import type { CatalogModel } from '../../../packages/model-catalog/catalog.js'
import { GenerationGate } from '../generationGate.js'
import { createSharedSpendBudget } from './tool-shared.js'
import type { AgentGenerationJob, AgentGenerationJobRunner, AgentGenerationCatalogSource } from './generation-broker.js'
import {
  AGENT_GENERATION_CONNECTION,
  AgentGenerationBroker,
} from './generation-broker.js'
import { digest } from './generation-broker-helpers.js'
import { AgentTaskJournal } from './journal.js'
import type { AgentTaskRecord } from './types.js'

const model: CatalogModel = {
  id: 'image-test',
  name: 'Image test',
  kind: 'image',
  endpoint: 'test/image',
  refs: true,
  lifecycle: 'active',
  pricing: { unit: 'image', usd: 0.001 },
  params: [{ name: 'quality', label: 'Quality', widget: 'select', options: [{ value: 'fast', label: 'Fast' }] }],
}

class FakeGenerationRunner implements AgentGenerationJobRunner {
  submits = 0
  cancels = 0
  failAfterRequestId = false
  private getCalls = 0
  readonly jobs = new Map<string, AgentGenerationJob>()
  constructor(private readonly initialStatus: AgentGenerationJob['status'] = 'done', private readonly actualCost = 0.001) {}

  async create(): Promise<{ jobId: string }> {
    this.submits += 1
    const jobId = `job-${this.submits}`
    this.jobs.set(jobId, {
      id: jobId,
      status: this.initialStatus,
      result: { url: '/media/generated.png', mime: 'image/png' },
      chargedAmountUsd: this.actualCost,
      falRequestId: `fal-request-${jobId}`,
    })
    return { jobId }
  }

  get(jobId: string): AgentGenerationJob | undefined {
    this.getCalls += 1
    if (this.failAfterRequestId && this.getCalls > 1) throw new Error('simulated host interruption after durable provider request ID')
    const job = this.jobs.get(jobId)
    return job ? structuredClone(job) : undefined
  }

  async cancel(jobId: string): Promise<void> {
    this.cancels += 1
    assert.ok(this.jobs.has(jobId))
  }

  finish(jobId: string, chargedAmountUsd = this.actualCost): void {
    const job = this.jobs.get(jobId)
    assert.ok(job)
    job.status = 'done'
    job.chargedAmountUsd = chargedAmountUsd
  }
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > 2_000) return reject(new Error('condition did not become true'))
      setTimeout(tick, 1)
    }
    tick()
  })
}

function catalogSource() {
  let revision = 7
  let currentModel = model
  const source: AgentGenerationCatalogSource & { setRevision(value: number): void; setModel(value: CatalogModel): void } = {
    models: () => [currentModel],
    view: () => ({ revision }),
    setRevision: (value) => { revision = value },
    setModel: (value) => { currentModel = value },
  }
  return source
}

async function fixture(options: {
  cap?: number
  maxCalls?: number
  runner?: FakeGenerationRunner
  gate?: GenerationGate
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-generation-'))
  const mediaDir = path.join(root, 'media')
  await fs.mkdir(mediaDir, { recursive: true })
  await fs.writeFile(path.join(mediaDir, 'generated.png'), 'fake native image bytes')
  const journal = new AgentTaskJournal(path.join(root, 'agent-tasks.json'), { workspaceRoot: root, checkpointRoot: path.join(root, 'checkpoints') })
  const runner = options.runner ?? new FakeGenerationRunner()
  const catalog = catalogSource()
  const broker = new AgentGenerationBroker({
    journal,
    catalog,
    mediaDir,
    provider: runner,
    generationGate: options.gate,
    connectionReady: () => true,
    pollMs: 1,
  })
  const taskId = 'agent-task-generation-test'
  const generationBudget = broker.prepareTask(taskId, 'local', ['generation.request'], {
    connectionId: AGENT_GENERATION_CONNECTION,
    mediaTransferConsent: true,
    maxCostMicros: options.cap ?? 100_000,
    maxCalls: options.maxCalls,
    expectedModelId: model.id,
    expectedCatalogRevision: 7,
    artifactRefs: [],
  })!
  const params = { quality: 'fast' }
  const task: AgentTaskRecord = {
    taskId,
    requestId: 'request-generation-test',
    requestHash: 'hash',
    packageId: 'test',
    packageVersion: '1',
    packageSha: 'a'.repeat(64),
    protocolVersion: '1.0',
    projectRef: { source: 'local', id: 'board-generation-test' },
    ownerId: 'owner',
    controllerId: 'controller',
    taskType: 'generation',
    instruction: 'test',
    input: {},
    inputs: [],
    workspaceId: 'workspace-generation-test',
    workspacePath: taskId,
    state: 'running',
    revision: 1,
    eventCursor: 0,
    currentMessageAcks: {},
    operationIntents: {},
    controlReceipts: {},
    decisionReceipts: {},
    generationBudget,
    generationOperations: [],
    spendBudget: createSharedSpendBudget(taskId, undefined, generationBudget),
    receipts: [],
    reviews: [{
      reviewId: 'review-generation',
      revision: 1,
      stageId: 'generation',
      title: 'Generation',
      question: 'Approve generation',
      materials: [],
      decisions: ['approved', 'changes-requested', 'rejected'],
      status: 'approved',
      createdAt: 1,
      generationSpec: {
        kind: 'image',
        modelId: model.id,
        catalogRevision: 7,
        promptHash: digest('Generate a test image'),
        refs: [],
        paramsHash: digest(params),
        prompt: 'Generate a test image',
        params: structuredClone(params),
        estimateMicros: 1_000,
      },
    }],
    decisions: [],
    artifacts: [],
    canvasItems: [],
    pendingCanvasItems: [],
    createdAt: 1,
    updatedAt: 1,
  }
  await journal.create(task)
  return { root, journal, broker, runner, catalog, task, params }
}

function args(grantId: string, prompt = 'Generate a test image', refs: Array<{ artifactId: string; revision: number; checksum: string }> = []) {
  return {
    connectionId: AGENT_GENERATION_CONNECTION,
    grantId,
    kind: 'image' as const,
    prompt,
    refs,
    params: { quality: 'fast' },
    modelId: model.id,
  }
}

async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 })
}

test('generation uses one durable submit, receipt, artifact and replay after restart', async (t) => {
  const value = await fixture()
  t.after(() => cleanup(value.root))
  const input = args(value.task.spendBudget!.grantId)
  const first = await value.broker.execute(value.task, input, 'generation-op-1')
  const second = await value.broker.execute((await value.journal.get(value.task.taskId))!, input, 'generation-op-1')
  assert.deepEqual(second, first)
  const restarted = new AgentGenerationBroker({ journal: value.journal, catalog: value.catalog, mediaDir: path.join(value.root, 'media'), provider: value.runner, connectionReady: () => true, pollMs: 1 })
  const third = await restarted.execute((await value.journal.get(value.task.taskId))!, input, 'generation-op-1')
  assert.deepEqual(third, first)
  assert.equal(value.runner.submits, 1)
  assert.equal((first.result.requestId as string).startsWith('generation:'), true)
  assert.equal((first.result.jobId as string), 'job-1')
  assert.equal((first.result.artifacts as unknown[]).length, 1)
  const saved = (await value.journal.get(value.task.taskId))!
  assert.equal(saved.generationOperations![0]!.status, 'succeeded')
  assert.equal(saved.artifacts.length, 1)
  assert.equal(saved.artifacts[0]!.mediaSrc, '/media/generated.png')
})

test('restart reconciles the durable fal request ID after an uncertain poll without resubmit', async (t) => {
  const runner = new FakeGenerationRunner('running')
  runner.failAfterRequestId = true
  const value = await fixture({ runner })
  t.after(() => cleanup(value.root))
  const input = args(value.task.spendBudget!.grantId)

  await assert.rejects(value.broker.execute(value.task, input, 'fal-restart'), (error: unknown) => (error as { code?: string }).code === 'GENERATION_OUTCOME_UNCERTAIN')
  const interrupted = (await value.journal.get(value.task.taskId))!
  const operation = interrupted.generationOperations![0]!
  assert.equal(runner.submits, 1)
  assert.equal(operation.status, 'uncertain')
  assert.equal(operation.jobId, 'job-1')
  assert.equal(operation.providerRequestId, 'fal-request-job-1')

  // A replacement broker sees the durable operation and only polls the same
  // provider job.  The fake provider is the paid-request boundary here; no
  // real fal client/key is involved.
  runner.failAfterRequestId = false
  runner.finish('job-1')
  const restartedJournal = new AgentTaskJournal(path.join(value.root, 'agent-tasks.json'), {
    workspaceRoot: value.root,
    checkpointRoot: path.join(value.root, 'checkpoints'),
  })
  const restarted = new AgentGenerationBroker({
    journal: restartedJournal,
    catalog: value.catalog,
    mediaDir: path.join(value.root, 'media'),
    provider: runner,
    connectionReady: () => true,
    pollMs: 1,
  })
  const result = await restarted.execute((await restartedJournal.get(value.task.taskId))!, input, 'fal-restart')
  assert.equal(runner.submits, 1)
  assert.equal((result.result.jobId as string), 'job-1')
  const recovered = (await restartedJournal.get(value.task.taskId))!
  assert.equal(recovered.generationOperations![0]!.providerRequestId, 'fal-request-job-1')
  assert.equal(recovered.generationOperations![0]!.status, 'succeeded')
})

test('terminal cancelled generation task resumes the durable job once without reviving the task', async (t) => {
  const runner = new FakeGenerationRunner('running')
  runner.failAfterRequestId = true
  const value = await fixture({ runner })
  t.after(() => cleanup(value.root))
  const input = args(value.task.spendBudget!.grantId)

  await assert.rejects(value.broker.execute(value.task, input, 'cancelled-replay'), (error: unknown) => (error as { code?: string }).code === 'GENERATION_OUTCOME_UNCERTAIN')
  await value.broker.cancelTask((await value.journal.get(value.task.taskId))!)
  await value.journal.mutate(value.task.taskId, (entry) => { entry.state = 'cancelled' }, { type: 'test.task-cancelled', payload: {} })
  value.catalog.setModel({ ...model, params: [], pricing: { unit: 'image', usd: 0.9 } })
  runner.failAfterRequestId = false
  runner.finish('job-1')

  const restartedJournal = new AgentTaskJournal(path.join(value.root, 'agent-tasks.json'), {
    workspaceRoot: value.root,
    checkpointRoot: path.join(value.root, 'checkpoints'),
  })
  const restarted = new AgentGenerationBroker({
    journal: restartedJournal,
    catalog: value.catalog,
    mediaDir: path.join(value.root, 'media'),
    provider: runner,
    connectionReady: () => true,
    pollMs: 1,
  })
  const recovered = await restarted.execute((await restartedJournal.get(value.task.taskId))!, input, 'cancelled-replay')
  const replay = await restarted.execute((await restartedJournal.get(value.task.taskId))!, input, 'cancelled-replay')
  await assert.rejects(
    restarted.execute((await restartedJournal.get(value.task.taskId))!, input, 'cancelled-new-operation'),
    (error: unknown) => (error as { code?: string }).code === 'TASK_NOT_RUNNING',
  )
  const saved = (await restartedJournal.get(value.task.taskId))!
  assert.deepEqual(replay, recovered)
  assert.equal(runner.submits, 1)
  assert.equal((recovered.result.charged as { amountMicros: number }).amountMicros, 1_000)
  assert.equal(saved.state, 'cancelled')
  assert.equal(saved.generationOperations![0]!.status, 'succeeded')
  assert.equal(saved.generationBudget!.chargedMicros, 1_000)
  assert.equal(saved.generationBudget!.calls, 1)
  assert.deepEqual(saved.artifacts, [])
  assert.deepEqual(saved.canvasItems, [])
})

test('successful generation replay uses its original model schema after active catalog changes', async (t) => {
  const value = await fixture()
  t.after(() => cleanup(value.root))
  const input = args(value.task.spendBudget!.grantId)
  const first = await value.broker.execute(value.task, input, 'catalog-replay')
  value.catalog.setModel({ ...model, params: [], pricing: { unit: 'image', usd: 0.9 } })
  const restarted = new AgentGenerationBroker({
    journal: value.journal,
    catalog: value.catalog,
    mediaDir: path.join(value.root, 'media'),
    provider: value.runner,
    connectionReady: () => true,
    pollMs: 1,
  })
  const replay = await restarted.execute((await value.journal.get(value.task.taskId))!, input, 'catalog-replay')
  assert.deepEqual(replay, first)
  assert.equal(value.runner.submits, 1)
})

test('generation review pins exact prompt, params, refs and catalog revision', async (t) => {
  const value = await fixture()
  t.after(() => cleanup(value.root))
  const grantId = value.task.spendBudget!.grantId
  await assert.rejects(value.broker.execute(value.task, args(grantId, 'changed prompt'), 'scope-change'), (error: unknown) => (error as { code?: string }).code === 'GENERATION_REVIEW_REQUIRED')
  value.catalog.setRevision(8)
  await assert.rejects(value.broker.execute((await value.journal.get(value.task.taskId))!, args(grantId), 'stale-review'), (error: unknown) => (error as { code?: string }).code === 'GENERATION_CATALOG_STALE')
  assert.equal(value.runner.submits, 0)
})

test('generation review rejects every mismatched display echo even when hashes are for the real request', async (t) => {
  const value = await fixture()
  t.after(() => cleanup(value.root))
  const grantId = value.task.spendBudget!.grantId
  const prompt = 'Generate a test image'
  const params = { quality: 'fast' }
  const cases = [
    { operationId: 'review-prompt-echo', prompt: 'Safe preview', params, estimateMicros: 1_000 },
    { operationId: 'review-params-echo', prompt, params: { quality: 'safe preview' }, estimateMicros: 1_000 },
    { operationId: 'review-estimate-echo', prompt, params, estimateMicros: 999 },
  ]
  for (const candidate of cases) {
    await value.journal.mutate(value.task.taskId, (entry) => {
      const spec = entry.reviews[0]?.generationSpec
      if (!spec) throw new Error('generation review fixture missing')
      spec.promptHash = digest(prompt)
      spec.paramsHash = digest(params)
      spec.prompt = candidate.prompt
      spec.params = structuredClone(candidate.params)
      spec.estimateMicros = candidate.estimateMicros
    }, { type: 'test.review-echo', payload: { operationId: candidate.operationId } })
    await assert.rejects(
      value.broker.execute((await value.journal.get(value.task.taskId))!, args(grantId), candidate.operationId),
      (error: unknown) => (error as { code?: string }).code === 'GENERATION_REVIEW_REQUIRED',
    )
  }
  assert.equal(value.runner.submits, 0)
  assert.deepEqual((await value.journal.get(value.task.taskId))!.generationOperations, [])
})

test('legacy hash-only generation review cannot authorize new paid spend', async (t) => {
  const value = await fixture()
  t.after(() => cleanup(value.root))
  await value.journal.mutate(value.task.taskId, (entry) => {
    const spec = entry.reviews[0]?.generationSpec
    if (!spec) throw new Error('generation review fixture missing')
    delete spec.prompt
    delete spec.params
    delete spec.estimateMicros
  }, { type: 'test.hash-only-review', payload: {} })
  await assert.rejects(
    value.broker.execute((await value.journal.get(value.task.taskId))!, args(value.task.spendBudget!.grantId), 'hash-only-review'),
    (error: unknown) => (error as { code?: string }).code === 'GENERATION_REVIEW_REQUIRED',
  )
  const saved = (await value.journal.get(value.task.taskId))!
  assert.equal(value.runner.submits, 0)
  assert.deepEqual(saved.generationOperations, [])
})

// Формулу оценки поправили (ступень цены подставляется, а не прибавляется к
// базовой). Одобрение, выданное по прежней формуле, не имеет права ни оплатить
// запрос, ни зарезервировать деньги: отказ до резерва, и человек одобряет
// заново уже верную сумму. Версии у оценки нет — этот отказ и есть переход.
test('approval of the old double-counted estimate is refused before any reservation', async (t) => {
  const value = await fixture({ cap: 1_000_000 })
  t.after(() => cleanup(value.root))
  value.catalog.setModel({ ...model, pricing: { unit: 'image', usd: 0.15, byParam: { name: 'quality', usd: { fast: 0.3 } } } })
  const grantId = value.task.spendBudget!.grantId
  const approve = (estimateMicros: number, operationId: string) => value.journal.mutate(value.task.taskId, (entry) => {
    const spec = entry.reviews[0]?.generationSpec
    if (!spec) throw new Error('generation review fixture missing')
    spec.estimateMicros = estimateMicros
  }, { type: 'test.review-estimate', payload: { operationId } })

  await approve(450_000, 'old-formula')
  await assert.rejects(
    value.broker.execute((await value.journal.get(value.task.taskId))!, args(grantId), 'old-formula'),
    (error: unknown) => (error as { code?: string }).code === 'GENERATION_REVIEW_REQUIRED',
  )
  const refused = (await value.journal.get(value.task.taskId))!
  assert.equal(value.runner.submits, 0)
  assert.deepEqual(refused.generationOperations, [])
  assert.equal(refused.spendBudget!.reservedMicros, 0)

  await approve(300_000, 'new-formula')
  await value.broker.execute((await value.journal.get(value.task.taskId))!, args(grantId), 'new-formula')
  assert.equal(value.runner.submits, 1)
  assert.equal((await value.journal.get(value.task.taskId))!.generationOperations![0]!.reservedMicros, 300_000)
})

test('generation grant is one call and transfer consent pins ordered revision/checksum refs', async (t) => {
  const value = await fixture()
  t.after(() => cleanup(value.root))
  assert.throws(() => value.broker.prepareTask(value.task.taskId, 'local', ['generation.request'], {
    connectionId: AGENT_GENERATION_CONNECTION,
    mediaTransferConsent: true,
    maxCostMicros: 100_000,
    maxCalls: 2,
    expectedModelId: model.id,
    expectedCatalogRevision: 7,
    artifactRefs: [],
  }), (error: unknown) => (error as { code?: string }).code === 'GENERATION_SCOPE_INVALID')

  const refs = [
    { artifactId: 'ref-a', revision: 3, checksum: 'a'.repeat(64) },
    { artifactId: 'ref-b', revision: 5, checksum: 'b'.repeat(64) },
  ]
  await fs.writeFile(path.join(value.root, 'media', 'ref-a.png'), 'a')
  await fs.writeFile(path.join(value.root, 'media', 'ref-b.png'), 'b')
  await value.journal.mutate(value.task.taskId, (entry) => {
    entry.artifacts = refs.map((ref, index) => ({
      ...ref,
      kind: 'image' as const,
      caption: `ref-${index}`,
      mimeType: 'image/png',
      sizeBytes: 1,
      mediaSrc: `/media/${ref.artifactId}.png`,
      provenance: 'reference' as const,
    }))
    entry.generationBudget!.artifactRefs = structuredClone(refs)
    if (!entry.reviews[0]?.generationSpec) throw new Error('generation review fixture missing')
    entry.reviews[0].generationSpec.refs = structuredClone(refs)
  }, { type: 'test.exact-generation-refs', payload: {} })
  const task = (await value.journal.get(value.task.taskId))!
  await assert.rejects(value.broker.execute(task, args(task.spendBudget!.grantId, 'Generate a test image', [refs[1]!, refs[0]!]), 'refs-reordered'), (error: unknown) => (error as { code?: string }).code === 'TRANSFER_CONSENT_MISMATCH')
  assert.equal(value.runner.submits, 0)
})

test('estimate admission is atomic and shared ceiling rejects a second generation call', async (t) => {
  const value = await fixture({ cap: 1_500 })
  t.after(() => cleanup(value.root))
  const grantId = value.task.spendBudget!.grantId
  const first = await value.broker.execute(value.task, args(grantId), 'budget-first')
  assert.equal((first.result.charged as { amountMicros: number }).amountMicros, 1_000)
  await value.journal.mutate(value.task.taskId, (entry) => {
    entry.reviews.push({ ...structuredClone(entry.reviews[0]!), reviewId: 'review-generation-2', revision: 1 })
  }, { type: 'test.second-review', payload: {} })
  await assert.rejects(value.broker.execute((await value.journal.get(value.task.taskId))!, args(grantId), 'budget-second'), (error: unknown) => (error as { code?: string }).code === 'BUDGET_EXCEEDED')
  assert.equal(value.runner.submits, 1)
  const saved = (await value.journal.get(value.task.taskId))!
  assert.equal(saved.spendBudget!.chargedMicros, 1_000)
  assert.equal(saved.spendBudget!.reservedMicros, 0)
})

test('actual provider overrun is reconciled once and blocks later admission', async (t) => {
  const value = await fixture({ cap: 1_500, runner: new FakeGenerationRunner('done', 0.002) })
  t.after(() => cleanup(value.root))
  const grantId = value.task.spendBudget!.grantId
  const first = await value.broker.execute(value.task, args(grantId), 'overrun-first')
  assert.equal((first.result.charged as { amountMicros: number }).amountMicros, 2_000)
  const saved = (await value.journal.get(value.task.taskId))!
  assert.equal(saved.spendBudget!.overshootMicros, 500)
  assert.equal(saved.spendBudget!.status, 'overspent')
  await value.journal.mutate(value.task.taskId, (entry) => {
    entry.reviews.push({ ...structuredClone(entry.reviews[0]!), reviewId: 'review-generation-2', revision: 1 })
  }, { type: 'test.second-review', payload: {} })
  const withReview = (await value.journal.get(value.task.taskId))!
  await assert.rejects(value.broker.execute(withReview, args(grantId), 'overrun-second'), (error: unknown) => (error as { code?: string }).code === 'BUDGET_EXCEEDED')
  assert.equal(value.runner.submits, 1)
})

test('LLM and generation reconcile through one shared task ledger', async (t) => {
  const value = await fixture({ cap: 2_000 })
  t.after(() => cleanup(value.root))
  const llmBudget: AgentLlmBudgetView = {
    grantId: value.task.spendBudget!.grantId,
    connectionId: 'local-fal',
    currency: 'USD',
    maxCostMicros: 2_000,
    reservedMicros: 0,
    chargedMicros: 0,
    overshootMicros: 0,
    calls: 0,
    maxCalls: 8,
    status: 'active',
    modelId: 'assistant-test',
    catalogRevision: 7,
    pricing: { inputPerMillion: 1, outputPerMillion: 1, checkedAt: '2026-10-01T00:00:00.000Z' },
  }
  await value.journal.mutate(value.task.taskId, (entry) => {
    entry.llmBudget = llmBudget
    entry.llmOperations = []
    entry.spendBudget = createSharedSpendBudget(value.task.taskId, llmBudget, entry.generationBudget)
  }, { type: 'test.shared-budget', payload: {} })
  const sharedTask = (await value.journal.get(value.task.taskId))!
  const result = await value.broker.execute(sharedTask, args(sharedTask.spendBudget!.grantId), 'shared-generation')
  assert.equal((result.result.charged as { amountMicros: number }).amountMicros, 1_000)
  const settled = (await value.journal.get(value.task.taskId))!
  assert.equal(settled.spendBudget!.chargedMicros, 1_000)
  assert.equal(settled.llmBudget!.chargedMicros, 1_000)
  assert.equal(settled.generationBudget!.chargedMicros, 1_000)
  await value.journal.mutate(value.task.taskId, (entry) => {
    entry.spendBudget!.reservedMicros = 1_001
    entry.llmBudget!.reservedMicros = 1_001
    entry.generationBudget!.reservedMicros = 1_001
    entry.reviews.push({ ...structuredClone(entry.reviews[0]!), reviewId: 'review-generation-2', revision: 1 })
  }, { type: 'test.shared-reservation', payload: {} })
  await assert.rejects(value.broker.execute((await value.journal.get(value.task.taskId))!, args(settled.spendBudget!.grantId), 'shared-generation-second'), (error: unknown) => (error as { code?: string }).code === 'BUDGET_EXCEEDED')
  assert.equal(value.runner.submits, 1)
})

test('cancel acknowledgement keeps reservation and a late paid result settles once', async (t) => {
  const runner = new FakeGenerationRunner('running')
  const value = await fixture({ cap: 1_500, runner })
  t.after(() => cleanup(value.root))
  const input = args(value.task.spendBudget!.grantId)
  const running = value.broker.execute(value.task, input, 'cancel-race')
  await waitFor(() => runner.submits === 1)
  await value.broker.cancelTask((await value.journal.get(value.task.taskId))!)
  const cancelled = (await value.journal.get(value.task.taskId))!
  assert.equal(cancelled.generationOperations![0]!.status, 'cancelled')
  assert.ok(cancelled.spendBudget!.reservedMicros > 0)
  runner.finish('job-1')
  const result = await running
  assert.equal((result.result.charged as { amountMicros: number }).amountMicros, 1_000)
  const settled = (await value.journal.get(value.task.taskId))!
  assert.equal(settled.generationOperations![0]!.status, 'succeeded')
  assert.equal(settled.spendBudget!.chargedMicros, 1_000)
  assert.equal(runner.submits, 1)
})

test('generation gate rejection releases a known-unsubmitted reservation', async (t) => {
  const gate = new GenerationGate()
  gate.close()
  const value = await fixture({ gate })
  t.after(() => cleanup(value.root))
  await assert.rejects(value.broker.execute(value.task, args(value.task.spendBudget!.grantId), 'gate-closed'), (error: unknown) => (error as { code?: string }).code === 'GENERATION_SHUTTING_DOWN')
  const saved = (await value.journal.get(value.task.taskId))!
  assert.equal(value.runner.submits, 0)
  assert.equal(saved.generationOperations![0]!.status, 'failed')
  assert.equal(saved.spendBudget!.reservedMicros, 0)
  assert.equal(saved.generationBudget!.calls, 0)
  assert.equal(saved.spendBudget!.calls, 0)
  assert.equal(saved.spendBudget!.status, 'active')

  const replacement = new AgentGenerationBroker({
    journal: value.journal,
    catalog: value.catalog,
    mediaDir: path.join(value.root, 'media'),
    provider: value.runner,
    generationGate: new GenerationGate(),
    connectionReady: () => true,
    pollMs: 1,
  })
  const recovered = await replacement.execute(saved, args(saved.spendBudget!.grantId), 'gate-retry')
  const afterRetry = (await value.journal.get(value.task.taskId))!
  assert.equal((recovered.result.charged as { amountMicros: number }).amountMicros, 1_000)
  assert.equal(value.runner.submits, 1)
  assert.equal(afterRetry.generationBudget!.calls, 1)
  assert.equal(afterRetry.spendBudget!.calls, 1)
})

test('missing durable job outcome is held uncertain and cannot resubmit', async (t) => {
  const value = await fixture()
  t.after(() => cleanup(value.root))
  const originalMutate = value.journal.mutate.bind(value.journal)
  let failSubmitted = true
  const patchable = value.journal as typeof value.journal & { mutate: typeof value.journal.mutate }
  patchable.mutate = async (taskId, updater, event) => {
    if (failSubmitted && event?.type === 'generation.submitted') {
      failSubmitted = false
      throw new Error('simulated journal failure')
    }
    return originalMutate(taskId, updater, event)
  }
  const input = args(value.task.spendBudget!.grantId)
  await assert.rejects(value.broker.execute(value.task, input, 'journal-fault'), (error: unknown) => (error as { code?: string }).code === 'GENERATION_OUTCOME_UNCERTAIN')
  const uncertain = (await value.journal.get(value.task.taskId))!
  assert.equal(value.runner.submits, 1)
  assert.equal(uncertain.generationOperations![0]!.status, 'uncertain')
  assert.equal(uncertain.generationOperations![0]!.jobId, undefined)
  assert.equal(uncertain.generationBudget!.calls, 1)
  assert.equal(uncertain.spendBudget!.calls, 1)
  assert.equal(uncertain.spendBudget!.status, 'blocked')
  await assert.rejects(value.broker.execute(uncertain, input, 'journal-fault'), (error: unknown) => (error as { code?: string }).code === 'GENERATION_OUTCOME_UNCERTAIN')
  assert.equal(value.runner.submits, 1)
})

test('CANAI_MOCK fail-closes persisted generation recovery without provider polling', async (t) => {
  const runner = new FakeGenerationRunner('running')
  runner.failAfterRequestId = true
  const value = await fixture({ runner })
  t.after(() => cleanup(value.root))
  await assert.rejects(value.broker.execute(value.task, args(value.task.spendBudget!.grantId), 'mock-recovery'), (error: unknown) => (error as { code?: string }).code === 'GENERATION_OUTCOME_UNCERTAIN')
  const mockBroker = new AgentGenerationBroker({ journal: value.journal, catalog: value.catalog, mediaDir: path.join(value.root, 'media'), provider: runner, connectionReady: () => true, mockMode: true, pollMs: 1 })
  await mockBroker.recoverPersisted((await value.journal.get(value.task.taskId))!)
  assert.equal(runner.submits, 1)
  assert.equal((await value.journal.get(value.task.taskId))!.generationOperations![0]!.status, 'uncertain')
})

test('generation.quote computes spec and returns budget info without making a reservation', async (t) => {
  const value = await fixture({ cap: 50_000 })
  t.after(() => cleanup(value.root))
  const quoteResult = await value.broker.quote(value.task, {
    kind: 'image',
    prompt: 'Generate a test image',
    refs: [],
    params: { quality: 'fast' },
  }, 'quote-op-1')
  const payload = quoteResult.result as {
    spec: { kind: string; modelId: string; catalogRevision: number; estimateMicros: number; prompt: string };
    budget: { remainingMicros: number; callsLeft: number };
  }
  assert.equal(payload.spec.kind, 'image')
  assert.equal(payload.spec.modelId, model.id)
  assert.equal(payload.spec.estimateMicros, 1_000)
  assert.equal(payload.spec.prompt, 'Generate a test image')
  assert.equal(payload.budget.remainingMicros, 50_000)
  assert.equal(payload.budget.callsLeft, 1)

  // Verify journal and spend budget are completely untouched
  const saved = (await value.journal.get(value.task.taskId))!
  assert.equal(saved.generationOperations?.length ?? 0, 0)
  assert.equal(saved.spendBudget!.reservedMicros, 0)
  assert.equal(saved.spendBudget!.chargedMicros, 0)
  assert.equal(saved.generationBudget!.calls, 0)
})

test('prepareTask enforces multi-pin bounds, unique kinds, and maxCalls limit', async () => {
  const catalog: AgentGenerationCatalogSource = {
    models: () => [
      model,
      { id: 'video-model', name: 'Video model', kind: 'video', endpoint: 'test/video', refs: true, lifecycle: 'active', pricing: { unit: 'second', usd: 0.01 }, params: [] },
      { id: 'audio-model', name: 'Audio model', kind: 'audio', endpoint: 'test/audio', refs: false, lifecycle: 'active', pricing: { unit: 'second', usd: 0.005 }, params: [] },
    ],
    view: () => ({ revision: 1 }),
  }
  const journal = new AgentTaskJournal(path.join(os.tmpdir(), 'dummy-journal.json'), { workspaceRoot: os.tmpdir(), checkpointRoot: os.tmpdir() })
  const broker = new AgentGenerationBroker({
    journal,
    catalog,
    mediaDir: os.tmpdir(),
    provider: new FakeGenerationRunner(),
    connectionReady: () => true,
  })

  // Rejects maxCalls > 24
  assert.throws(
    () => broker.prepareTask('t1', 'local', ['generation.request'], {
      connectionId: AGENT_GENERATION_CONNECTION,
      mediaTransferConsent: true,
      maxCostMicros: 100_000,
      maxCalls: 25,
      expectedCatalogRevision: 1,
      models: [{ kind: 'image', modelId: 'image-test' }],
    }),
    (err: unknown) => (err as { code?: string }).code === 'GENERATION_SCOPE_INVALID',
  )

  // Rejects duplicate kinds in pins
  assert.throws(
    () => broker.prepareTask('t2', 'local', ['generation.request'], {
      connectionId: AGENT_GENERATION_CONNECTION,
      mediaTransferConsent: true,
      maxCostMicros: 100_000,
      maxCalls: 5,
      expectedCatalogRevision: 1,
      models: [
        { kind: 'image', modelId: 'image-test' },
        { kind: 'image', modelId: 'image-test' },
      ],
    }),
    (err: unknown) => (err as { code?: string }).code === 'GENERATION_SCOPE_INVALID',
  )

  // Accepts valid multi-pin authorization
  const budget = broker.prepareTask('t3', 'local', ['generation.request'], {
    connectionId: AGENT_GENERATION_CONNECTION,
    mediaTransferConsent: true,
    maxCostMicros: 100_000,
    maxCalls: 10,
    expectedCatalogRevision: 1,
    models: [
      { kind: 'image', modelId: 'image-test', params: { quality: 'fast' } },
      { kind: 'video', modelId: 'video-model' },
    ],
  })
  assert.ok(budget)
  assert.equal(budget.maxCalls, 10)
  assert.equal(budget.pins?.length, 2)
  assert.equal(budget.pins[0].kind, 'image')
  assert.equal(budget.pins[1].kind, 'video')
})

test('multi-pin task selects pinned model matching kind and rejects unpinned kind', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-multipin-'))
  t.after(() => cleanup(root))
  const mediaDir = path.join(root, 'media')
  await fs.mkdir(mediaDir, { recursive: true })
  await fs.writeFile(path.join(mediaDir, 'generated.png'), 'fake image')
  const journal = new AgentTaskJournal(path.join(root, 'tasks.json'), { workspaceRoot: root, checkpointRoot: path.join(root, 'checkpoints') })
  const videoModel: CatalogModel = { id: 'video-test', name: 'Video test', kind: 'video', endpoint: 'test/video', refs: true, lifecycle: 'active', pricing: { unit: 'second', usd: 0.01 }, params: [] }
  const catalog: AgentGenerationCatalogSource = {
    models: () => [model, videoModel],
    view: () => ({ revision: 1 }),
  }
  const broker = new AgentGenerationBroker({
    journal,
    catalog,
    mediaDir,
    provider: new FakeGenerationRunner(),
    connectionReady: () => true,
    pollMs: 1,
  })
  const taskId = 'multi-pin-task'
  const generationBudget = broker.prepareTask(taskId, 'local', ['generation.request'], {
    connectionId: AGENT_GENERATION_CONNECTION,
    mediaTransferConsent: true,
    maxCostMicros: 50_000,
    maxCalls: 5,
    expectedCatalogRevision: 1,
    models: [
      { kind: 'image', modelId: model.id, params: { quality: 'fast' } },
      { kind: 'video', modelId: videoModel.id },
    ],
  })!
  const task: AgentTaskRecord = {
    taskId,
    requestId: 'req-multi',
    requestHash: 'hash',
    packageId: 'test',
    packageVersion: '1',
    packageSha: 'a'.repeat(64),
    protocolVersion: '1.0',
    projectRef: { source: 'local', id: 'board-multi' },
    ownerId: 'owner',
    controllerId: 'controller',
    taskType: 'generation',
    instruction: 'multi',
    input: {},
    inputs: [],
    workspaceId: 'ws-multi',
    workspacePath: taskId,
    state: 'running',
    revision: 1,
    eventCursor: 0,
    currentMessageAcks: {},
    operationIntents: {},
    controlReceipts: {},
    decisionReceipts: {},
    generationBudget,
    generationOperations: [],
    spendBudget: createSharedSpendBudget(taskId, undefined, generationBudget),
    receipts: [],
    reviews: [],
    decisions: [],
    artifacts: [],
    canvasItems: [],
    pendingCanvasItems: [],
    createdAt: 1,
    updatedAt: 1,
  }
  await journal.create(task)

  // Compute spec for image uses image model
  const imageSpec = broker.computeGenerationSpec(task, { kind: 'image', prompt: 'an image', refs: [] })
  assert.equal(imageSpec.modelId, model.id)
  assert.equal(imageSpec.kind, 'image')

  // Compute spec for video uses video model
  const videoSpec = broker.computeGenerationSpec(task, { kind: 'video', prompt: 'a video', refs: [] })
  assert.equal(videoSpec.modelId, videoModel.id)
  assert.equal(videoSpec.kind, 'video')

  // Compute spec for audio (not pinned) throws
  assert.throws(
    () => broker.computeGenerationSpec(task, { kind: 'audio', prompt: 'sound track', refs: [] }),
    (err: unknown) => (err as { code?: string }).code === 'GENERATION_MODEL_PIN_MISMATCH',
  )
})

test('multi-pin task enforces ref eligibility for inputs, generated artifacts and derived artifacts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-refelig-'))
  t.after(() => cleanup(root))
  const mediaDir = path.join(root, 'media')
  await fs.mkdir(mediaDir, { recursive: true })
  await fs.writeFile(path.join(mediaDir, 'input.png'), 'fake input')
  await fs.writeFile(path.join(mediaDir, 'gen.png'), 'fake gen')
  await fs.writeFile(path.join(mediaDir, 'unapproved.png'), 'fake unapproved')
  await fs.writeFile(path.join(mediaDir, 'derived.mp4'), 'fake derived')

  const journal = new AgentTaskJournal(path.join(root, 'tasks.json'), { workspaceRoot: root, checkpointRoot: path.join(root, 'checkpoints') })
  const videoModel: CatalogModel = { id: 'video-test', name: 'Video test', kind: 'video', endpoint: 'test/video', refs: true, lifecycle: 'active', pricing: { unit: 'second', usd: 0.01 }, params: [] }
  const catalog: AgentGenerationCatalogSource = {
    models: () => [model, videoModel],
    view: () => ({ revision: 1 }),
  }
  const broker = new AgentGenerationBroker({
    journal,
    catalog,
    mediaDir,
    provider: new FakeGenerationRunner(),
    connectionReady: () => true,
    pollMs: 1,
  })

  const inputRef = { artifactId: 'input-art', revision: 1, checksum: '1'.repeat(64) }
  const approvedGenRef = { artifactId: 'gen-art', revision: 1, checksum: '2'.repeat(64) }
  const unapprovedGenRef = { artifactId: 'unapproved-art', revision: 1, checksum: '3'.repeat(64) }
  const derivedRef = { artifactId: 'derived-art', revision: 1, checksum: '4'.repeat(64) }

  const taskId = 'ref-elig-task'
  const generationBudget = broker.prepareTask(taskId, 'local', ['generation.request'], {
    connectionId: AGENT_GENERATION_CONNECTION,
    mediaTransferConsent: true,
    maxCostMicros: 50_000,
    maxCalls: 5,
    expectedCatalogRevision: 1,
    artifactRefs: [inputRef],
    models: [
      { kind: 'image', modelId: model.id, params: { quality: 'fast' } },
      { kind: 'video', modelId: videoModel.id },
    ],
  })!

  const task: AgentTaskRecord = {
    taskId,
    requestId: 'req-ref-elig',
    requestHash: 'hash',
    packageId: 'test',
    packageVersion: '1',
    packageSha: 'a'.repeat(64),
    protocolVersion: '1.0',
    projectRef: { source: 'local', id: 'board-ref-elig' },
    ownerId: 'owner',
    controllerId: 'controller',
    taskType: 'generation',
    instruction: 'multi',
    input: {},
    inputs: [],
    workspaceId: 'ws-ref-elig',
    workspacePath: taskId,
    state: 'running',
    revision: 1,
    eventCursor: 0,
    currentMessageAcks: {},
    operationIntents: {},
    controlReceipts: {},
    decisionReceipts: {},
    generationBudget,
    generationOperations: [
      {
        operationId: 'op-gen-1',
        requestId: 'req-gen-1',
        argumentsHash: 'hash1',
        receiptId: 'rcpt1',
        status: 'succeeded',
        modelId: model.id,
        catalogRevision: 1,
        reservedMicros: 1000,
        jobId: 'job-1',
        createdAt: 1,
        updatedAt: 1,
        result: { artifacts: [{ ...approvedGenRef, kind: 'image', caption: 'Gen', mimeType: 'image/png', sizeBytes: 8, mediaSrc: '/media/gen.png', provenance: 'generated' }] },
      },
    ],
    spendBudget: createSharedSpendBudget(taskId, undefined, generationBudget),
    receipts: [],
    reviews: [
      {
        reviewId: 'rev-gen-1',
        revision: 1,
        stageId: 'result',
        title: 'Result review',
        question: 'Publish?',
        materials: [{ ...approvedGenRef, caption: 'Gen', role: 'result' }],
        decisions: ['approved'],
        status: 'approved',
        createdAt: 1,
      },
    ],
    decisions: [],
    artifacts: [
      { ...inputRef, kind: 'image', caption: 'Input', mimeType: 'image/png', sizeBytes: 10, mediaSrc: '/media/input.png', provenance: 'generated' },
      { ...approvedGenRef, kind: 'image', caption: 'Gen', mimeType: 'image/png', sizeBytes: 8, mediaSrc: '/media/gen.png', provenance: 'generated' },
      { ...unapprovedGenRef, kind: 'image', caption: 'Unapproved', mimeType: 'image/png', sizeBytes: 8, mediaSrc: '/media/unapproved.png', provenance: 'generated' },
      { ...derivedRef, kind: 'video', caption: 'Derived', mimeType: 'video/mp4', sizeBytes: 16, mediaSrc: '/media/derived.mp4', provenance: 'derived' },
    ],
    canvasItems: [],
    pendingCanvasItems: [],
    createdAt: 1,
    updatedAt: 1,
  }
  await journal.create(task)

  // 1. Launch input ref is eligible
  const specInput = broker.computeGenerationSpec(task, { kind: 'video', prompt: 'video with input', refs: [inputRef] })
  assert.equal(specInput.refs.length, 1)

  // 2. Approved generated artifact is eligible
  const specApproved = broker.computeGenerationSpec(task, { kind: 'video', prompt: 'video with approved gen', refs: [approvedGenRef] })
  assert.equal(specApproved.refs.length, 1)

  // 3. Unapproved generated artifact is rejected
  assert.throws(
    () => broker.computeGenerationSpec(task, { kind: 'video', prompt: 'video with unapproved gen', refs: [unapprovedGenRef] }),
    (err: unknown) => (err as { code?: string }).code === 'REF_NOT_APPROVED',
  )

  // 4. Derived artifact (provenance: derived) is rejected
  assert.throws(
    () => broker.computeGenerationSpec(task, { kind: 'video', prompt: 'video with derived', refs: [derivedRef] }),
    (err: unknown) => (err as { code?: string }).code === 'REF_NOT_APPROVED',
  )
})


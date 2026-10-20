import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CatalogModel } from '../../../packages/model-catalog/catalog.js'
import type { AgentTaskRecord } from './types.js'

/**
 * This is deliberately a separate integration entrypoint.  The normal server
 * test command imports config-heavy modules before test callbacks run, while
 * this scenario must set an isolated data root before loading jobs/runner.
 * Invoke it with `npm run test:agent-generation-integration`.
 */
test('generation broker resumes one real jobs/runner mock job after restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-generation-runner-'))
  const previous = {
    mock: process.env.CANAI_MOCK,
    data: process.env.CANAI_DATA_DIR,
    envFile: process.env.CANAI_ENV_FILE,
  }
  process.env.CANAI_MOCK = '1'
  process.env.CANAI_DATA_DIR = path.join(root, 'data')
  process.env.CANAI_ENV_FILE = path.join(root, 'missing.env')
  // The production bootstrap creates these media folders.  This test invokes
  // the jobs/runner modules directly, so create the same native target first.
  await fs.mkdir(path.join(root, 'data', 'media', 'общее', 'картинки'), { recursive: true })

  let jobId: string | undefined
  try {
    const [generationModule, journalModule, sharedModule, gateModule, jobsModule, mediaLayoutModule] = await Promise.all([
      import('./generation-broker.js'),
      import('./journal.js'),
      import('./tool-shared.js'),
      import('../generationGate.js'),
      import('../jobs.js'),
      import('../mediaLayout.js'),
    ])
    const {
      AGENT_GENERATION_CONNECTION,
      AgentGenerationBroker,
    } = generationModule
    const { AgentTaskJournal } = journalModule
    const { createSharedSpendBudget } = sharedModule
    const { generationGate } = gateModule
    const { jobs } = jobsModule
    const { mediaPathIn } = mediaLayoutModule
    const { stableId, stableScopedId } = sharedModule

    const model: CatalogModel = {
      id: 'image-test-runner',
      name: 'Image test runner',
      kind: 'image',
      endpoint: 'test/image',
      lifecycle: 'active',
      pricing: { unit: 'image', usd: 0.001 },
    }
    const catalog = {
      models: () => [model],
      view: () => ({ revision: 11 }),
    }
    const journalFile = path.join(root, 'agent-tasks.json')
    const journalOptions = {
      workspaceRoot: root,
      checkpointRoot: path.join(root, 'checkpoints'),
    }
    const journal = new AgentTaskJournal(journalFile, journalOptions)
    const broker = new AgentGenerationBroker({
      journal,
      catalog,
      // The broker remains fail-closed for production mock mode.  The
      // process-level mock lane below is only the deterministic provider for
      // this isolated test; no fal key or network provider is used.
      mockMode: false,
      connectionReady: () => true,
      generationGate,
      pollMs: 5,
      mediaDir: path.join(root, 'data', 'media'),
    })
    const generationBudget = broker.prepareTask('agent-task-runner-integration', 'local', ['generation.request'], {
      connectionId: AGENT_GENERATION_CONNECTION,
      mediaTransferConsent: true,
      maxCostMicros: 100_000,
      expectedModelId: model.id,
      expectedCatalogRevision: 11,
      artifactRefs: [],
    })!
    const taskId = 'agent-task-runner-integration'
    const prompt = 'Generate one durable runner image'
    const params = {}
    const { digest } = await import('./generation-broker-helpers.js')
    const task: AgentTaskRecord = {
      taskId,
      requestId: 'request-runner-integration',
      requestHash: 'hash-runner-integration',
      packageId: 'test',
      packageVersion: '1',
      packageSha: 'a'.repeat(64),
      protocolVersion: '1.0',
      projectRef: { source: 'local', id: 'board-runner-integration' },
      ownerId: 'owner',
      controllerId: 'controller',
      taskType: 'generation',
      instruction: 'test',
      input: {},
      inputs: [],
      workspaceId: 'workspace-runner-integration',
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
        reviewId: 'review-runner-integration',
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
          catalogRevision: 11,
          promptHash: digest(prompt),
          refs: [],
          paramsHash: digest(params),
           prompt,
           params,
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

    const args = {
      connectionId: AGENT_GENERATION_CONNECTION,
      grantId: generationBudget.grantId,
      kind: 'image' as const,
      prompt,
      refs: [],
      params,
      modelId: model.id,
    }
    const operationId = 'runner-restart-operation'
    const firstPromise = broker.execute(task, args, operationId)
    await waitFor(async () => (await journal.get(taskId))?.generationOperations?.[0]?.status === 'submitted')
    const submitted = (await journal.get(taskId))!.generationOperations![0]!
    jobId = submitted.jobId
    assert.equal(jobId, stableId('agent-job', taskId, operationId))
    assert.ok(jobId!.length <= 100)

    // Finish the first process before opening the replacement journal.  This
    // keeps the test's two in-process journal writers out of each other's
    // temporary file; a real restart has a different process ID and cannot
    // collide here.
    const first = await firstPromise

    // A fresh journal/broker represents a process restart.  The second call
    // must observe the durable job and wait for it; it cannot submit again.
    const restartedJournal = new AgentTaskJournal(journalFile, journalOptions)
    const restarted = new AgentGenerationBroker({
      journal: restartedJournal,
      catalog,
      mockMode: false,
      connectionReady: () => true,
      generationGate,
      pollMs: 5,
      mediaDir: path.join(root, 'data', 'media'),
    })
    const second = await restarted.execute((await restartedJournal.get(taskId))!, args, operationId)
    assert.deepEqual(second, first)

    const durableJobs = jobs.all().filter((job) => job.id === jobId)
    assert.equal(durableJobs.length, 1)
    assert.equal(durableJobs[0]!.status, 'done')
    assert.equal(durableJobs[0]!.generationRoute, 'mock')
    assert.equal((first.result.requestId as string), stableScopedId('generation', taskId, operationId))
    assert.equal((first.result.jobId as string), jobId)
    assert.equal((first.result.artifacts as unknown[]).length, 1)

    const saved = (await restartedJournal.get(taskId))!
    assert.equal(saved.generationOperations![0]!.status, 'succeeded')
    assert.equal(saved.generationOperations![0]!.jobId, jobId)
    assert.equal(saved.artifacts.length, 1)
    assert.equal(saved.artifacts[0]!.mediaSrc.startsWith('/media/'), true)
    assert.equal(saved.artifacts[0]!.checksum.length, 64)
    const mediaFile = mediaPathIn(path.join(root, 'data', 'media'), saved.artifacts[0]!.mediaSrc.slice('/media/'.length))
    assert.equal((await fs.stat(mediaFile)).isFile(), true)
  } finally {
    if (jobId) {
      try {
        const { jobs } = await import('../jobs.js')
        jobs.remove(jobId)
        await jobs.persistNow()
      } catch {
        // Cleanup must not hide the actual integration assertion.
      }
    }
    if (previous.mock === undefined) delete process.env.CANAI_MOCK
    else process.env.CANAI_MOCK = previous.mock
    if (previous.data === undefined) delete process.env.CANAI_DATA_DIR
    else process.env.CANAI_DATA_DIR = previous.data
    if (previous.envFile === undefined) delete process.env.CANAI_ENV_FILE
    else process.env.CANAI_ENV_FILE = previous.envFile
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 })
  }
})

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > 10_000) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

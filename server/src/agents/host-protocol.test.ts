import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentEnvelope, AgentTool } from '../../../packages/agent-protocol/index.js'
import { AgentTaskJournal } from './journal.js'
import { AgentPackageRegistry } from './packages.js'
import { AgentProtocolDispatcher } from './host-protocol.js'
import { AgentProtocolValidator } from './validation.js'
import type { ToolResult } from './tools.js'
import { AgentHostError } from './host-shared.js'
import type { AgentTaskRecord } from './types.js'
import {
  makeHostEnvelope,
  startPayload,
  wireReceipt,
  writeAgentEnvelope,
  writeHostAck,
  writeToolResult,
} from './host-wire.js'
import { fileURLToPath } from 'node:url'

const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/agents')
const bundledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bundled')

function taskRecord(pkg: Awaited<ReturnType<AgentPackageRegistry['get']>>): AgentTaskRecord {
  return {
    taskId: 'agent-task-protocol-recovery', requestId: 'protocol-recovery', requestHash: 'request-hash',
    packageId: pkg.manifest.id, packageVersion: pkg.manifest.version, packageSha: pkg.packageSha,
    protocolVersion: '1.0', projectRef: { source: 'local', id: 'protocol-board' }, ownerId: 'owner', controllerId: 'controller',
    taskType: 'demo-plan', instruction: 'Replay an uncertain operation', input: { sceneCount: 1, theme: 'test' }, inputs: [],
    workspaceId: 'workspace-protocol-recovery', workspacePath: 'agent-task-protocol-recovery', state: 'running', revision: 1,
    eventCursor: 0, currentExecutionId: 'execution-protocol-recovery', currentMessageAcks: {}, operationIntents: {},
    controlReceipts: {}, decisionReceipts: {}, receipts: [], reviews: [], decisions: [], artifacts: [], canvasItems: [], pendingCanvasItems: [],
    createdAt: 1, updatedAt: 1,
  }
}

function managedProcess(task: AgentTaskRecord, pkg: Awaited<ReturnType<AgentPackageRegistry['get']>>): any {
  const writes: string[] = []
  return {
    taskId: task.taskId, child: { stdin: { destroyed: false, write: (value: string) => { writes.push(value); return true } } },
    package: pkg, executionId: task.currentExecutionId, buffer: '', queue: Promise.resolve(), hello: true, pending: [], closing: false,
    exited: Promise.resolve(), resolveExit: () => undefined, writes,
  }
}

function dispatcher(journal: AgentTaskJournal, validator: AgentProtocolValidator, broker: unknown): AgentProtocolDispatcher {
  return new AgentProtocolDispatcher({
    journal, validator, broker: broker as any, now: () => 10,
    require: async (taskId) => {
      const task = await journal.get(taskId)
      if (!task) throw new AgentHostError('TASK_NOT_FOUND', 'missing', 404)
      return task
    },
    assertPermission: () => undefined,
    sendOrQueue: () => undefined,
    makeHostEnvelope,
    writeEnvelope: (managed, message) => writeAgentEnvelope(validator, managed, message),
    writeHostAck: (managed, messageId, cursor) => writeHostAck(validator, managed, messageId, cursor),
    writeToolResult: (managed, request, receipt) => writeToolResult(validator, managed, request, receipt),
    wireReceipt,
    startPayload,
    brokerTask: (task) => task,
    verifyCheckpoint: async () => undefined,
    failTask: async () => undefined,
  })
}

function request(task: AgentTaskRecord, messageId: string): AgentEnvelope {
  return {
    protocolVersion: '1.0', messageId, taskId: task.taskId, executionId: task.currentExecutionId!, type: 'tool.request',
    payload: {
      operationId: 'cloud-operation-retry', tool: 'canvas.create_results' as AgentTool,
      arguments: { workspaceId: task.workspaceId, items: [{ slotId: 'plan', artifact: { artifactId: 'artifact', revision: 1, checksum: '0'.repeat(64) }, caption: 'Plan' }] },
    },
  }
}

test('canonical effect survives a receipt write failure and Host journal restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-protocol-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }))
  const validator = new AgentProtocolValidator(schemaDir)
  const packages = new AgentPackageRegistry(validator, bundledRoot)
  await packages.loadBundled()
  const pkg = packages.get('canai.demo')
  const task = taskRecord(pkg)
  const journalFile = path.join(root, 'journal.json')
  const journalOptions = { workspaceRoot: path.join(root, 'work'), checkpointRoot: path.join(root, 'checkpoints') }
  const journal = new AgentTaskJournal(journalFile, journalOptions)
  await journal.create(task)
  const managed = managedProcess(task, pkg)
  const canonicalItems = new Set<string>()
  const operationIds: string[] = []
  let calls = 0
  const execute = async (...args: unknown[]): Promise<ToolResult> => {
    calls += 1
    const operationId = String(args[3])
    operationIds.push(operationId)
    canonicalItems.add(operationId)
    return { result: { workspaceId: task.workspaceId, items: [{ slotId: 'plan', itemId: 'agent-item', revision: 1, artifactId: 'artifact' }] } }
  }
  const broker = { execute } as any
  const journalInternals = journal as unknown as { write: (document: unknown) => Promise<void> }
  const originalWrite = journalInternals.write.bind(journal)
  let writes = 0
  journalInternals.write = async (document: unknown) => {
    writes += 1
    if (writes === 2) throw new Error('crash after canonical commit before receipt')
    return originalWrite(document)
  }
  const first = dispatcher(journal, validator, broker)
  await first.handleLine(task.taskId, managed, JSON.stringify(request(task, 'crash-before-receipt')))
  const afterCrash = new AgentTaskJournal(journalFile, journalOptions)
  let persisted = await afterCrash.get(task.taskId)
  assert.equal(persisted?.receipts.some((receipt) => receipt.operationId === 'cloud-operation-retry'), false)
  assert.ok(persisted?.operationIntents['cloud-operation-retry'])

  // A new journal and dispatcher model a Host process restart after the
  // canonical board committed but before the receipt became durable.
  const second = dispatcher(afterCrash, validator, broker)
  await second.handleLine(task.taskId, managed, JSON.stringify(request(task, 'retry-after-restart')))
  const persistedAfterRetry = new AgentTaskJournal(journalFile, journalOptions)
  persisted = await persistedAfterRetry.get(task.taskId)
  const receipts = persisted!.receipts.filter((receipt) => receipt.operationId === 'cloud-operation-retry')
  assert.equal(calls, 2)
  assert.equal(canonicalItems.size, 1)
  assert.deepEqual(operationIds, ['cloud-operation-retry', 'cloud-operation-retry'])
  assert.deepEqual(receipts.map((receipt) => receipt.status), ['succeeded'])
})

test('review.request rejects tampered generationSpec in multi-operation task with GENERATION_SPEC_INVALID', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-protocol-review-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }))
  const validator = new AgentProtocolValidator(schemaDir)
  const packages = new AgentPackageRegistry(validator, bundledRoot)
  await packages.loadBundled()
  const pkg = packages.get('canai.demo')
  const task = taskRecord(pkg)
  task.generationBudget = {
    grantId: 'grant-gen',
    connectionId: 'local-fal',
    currency: 'USD',
    maxCostMicros: 100_000,
    reservedMicros: 0,
    chargedMicros: 0,
    overshootMicros: 0,
    calls: 0,
    maxCalls: 5,
    status: 'active',
    modelId: 'image-test',
    pins: [{ kind: 'image', modelId: 'image-test' }],
    catalogRevision: 1,
    artifactRefs: [],
  }
  const journalFile = path.join(root, 'journal.json')
  const journalOptions = { workspaceRoot: path.join(root, 'work'), checkpointRoot: path.join(root, 'checkpoints') }
  const journal = new AgentTaskJournal(journalFile, journalOptions)
  await journal.create(task)
  const managed = managedProcess(task, pkg)

  const promptDigest = 'a'.repeat(64)
  const paramsDigest = 'b'.repeat(64)
  const broker = {
    computeGenerationSpec: () => ({
      kind: 'image',
      modelId: 'image-test',
      catalogRevision: 1,
      prompt: 'real prompt',
      params: {},
      estimateMicros: 1000,
      promptHash: promptDigest,
      paramsHash: paramsDigest,
      refs: [],
    }),
  }

  const sentEnvelopes: AgentEnvelope[] = []
  const d = new AgentProtocolDispatcher({
    journal, validator, broker: broker as any, now: () => 10,
    require: async (taskId) => {
      const t = await journal.get(taskId)
      if (!t) throw new AgentHostError('TASK_NOT_FOUND', 'missing', 404)
      return t
    },
    assertPermission: () => undefined,
    sendOrQueue: (_taskId, env) => { sentEnvelopes.push(env) },
    makeHostEnvelope,
    writeEnvelope: (m, msg) => writeAgentEnvelope(validator, m, msg),
    writeHostAck: (m, msgId, cursor) => writeHostAck(validator, m, msgId, cursor),
    writeToolResult: (m, req, rcpt) => writeToolResult(validator, m, req, rcpt),
    wireReceipt,
    startPayload,
    brokerTask: (t) => t,
    verifyCheckpoint: async () => undefined,
    failTask: async () => undefined,
  })

  const tamperedEnvelope: AgentEnvelope = {
    protocolVersion: '1.0',
    messageId: 'review-req-1',
    taskId: task.taskId,
    executionId: task.currentExecutionId!,
    type: 'review.request',
    payload: {
      reviewId: 'rev-tampered',
      revision: 1,
      stageId: 'generation',
      title: 'Gen review',
      question: 'Approve?',
      materials: [],
      decisions: ['approved', 'changes-requested', 'rejected'],
      generationSpec: {
        kind: 'image',
        modelId: 'image-test',
        catalogRevision: 1,
        prompt: 'real prompt',
        params: {},
        estimateMicros: 50, // tampered estimate!
        promptHash: promptDigest,
        paramsHash: paramsDigest,
        refs: [],
      },
    },
  }

  await d.handleLine(task.taskId, managed, JSON.stringify(tamperedEnvelope))

  // Host responded with protocol.error containing GENERATION_SPEC_INVALID
  const errorEnv = sentEnvelopes.find((env) => env.type === 'protocol.error')
  assert.ok(errorEnv)
  const errorPayload = (errorEnv.payload as { error?: { code?: string } }).error
  assert.equal(errorPayload?.code, 'GENERATION_SPEC_INVALID')

  // No review was created in state
  const persisted = await journal.get(task.taskId)
  assert.equal(persisted?.reviews.length, 0)
})



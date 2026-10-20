import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AgentEnvelope, AgentTool } from '../../../packages/agent-protocol/index.js'
import { AgentTaskJournal } from './journal.js'
import { AgentPackageRegistry } from './packages.js'
import { AgentProtocolDispatcher } from './host-protocol.js'
import { AgentProtocolValidator } from './validation.js'
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
import type { ToolResult } from './tools.js'

const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/agents')
const bundledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bundled')

function taskRecord(pkg: Awaited<ReturnType<AgentPackageRegistry['get']>>, taskId = 'task-render-host'): AgentTaskRecord {
  return {
    taskId,
    requestId: `request-${taskId}`,
    requestHash: 'request-hash',
    packageId: pkg.manifest.id,
    packageVersion: pkg.manifest.version,
    packageSha: pkg.packageSha,
    protocolVersion: '1.0',
    projectRef: { source: 'local', id: 'protocol-board' },
    ownerId: 'owner',
    controllerId: 'controller',
    taskType: 'demo-plan',
    instruction: 'Render host test',
    input: {},
    inputs: [],
    workspaceId: `workspace-${taskId}`,
    workspacePath: taskId,
    state: 'running',
    revision: 1,
    eventCursor: 0,
    currentExecutionId: `exec-${taskId}`,
    currentMessageAcks: {},
    operationIntents: {},
    controlReceipts: {},
    decisionReceipts: {},
    receipts: [],
    reviews: [],
    decisions: [],
    artifacts: [],
    canvasItems: [],
    pendingCanvasItems: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

function managedProcess(task: AgentTaskRecord, pkg: Awaited<ReturnType<AgentPackageRegistry['get']>>): any {
  const writes: string[] = []
  return {
    taskId: task.taskId,
    child: { stdin: { destroyed: false, write: (value: string) => { writes.push(value); return true } } },
    package: pkg,
    executionId: task.currentExecutionId,
    buffer: '',
    queue: Promise.resolve(),
    hello: true,
    pending: [],
    closing: false,
    exited: Promise.resolve(),
    resolveExit: () => undefined,
    writes,
  }
}

function dispatcher(
  journal: AgentTaskJournal,
  validator: AgentProtocolValidator,
  broker: unknown,
  managed: any,
  allowedPermissions = ['media.read', 'media.render', 'canvas.create_results'],
): AgentProtocolDispatcher {
  return new AgentProtocolDispatcher({
    journal,
    validator,
    broker: broker as any,
    now: () => 10,
    require: async (taskId) => {
      const task = await journal.get(taskId)
      if (!task) throw new AgentHostError('TASK_NOT_FOUND', 'missing', 404)
      return task
    },
    assertPermission: (_task, permission) => {
      if (!allowedPermissions.includes(permission)) {
        throw new AgentHostError('PERMISSION_DENIED', `Permission ${permission} not granted`, 403)
      }
    },
    sendOrQueue: (_taskId, message) => writeAgentEnvelope(validator, managed, message),
    makeHostEnvelope,
    writeEnvelope: (m, message) => writeAgentEnvelope(validator, m, message),
    writeHostAck: (m, messageId, cursor) => writeHostAck(validator, m, messageId, cursor),
    writeToolResult: (m, request, receipt) => writeToolResult(validator, m, request, receipt),
    wireReceipt,
    startPayload,
    brokerTask: (task) => task,
    verifyCheckpoint: async () => undefined,
    failTask: async () => undefined,
  })
}

test('media.read and media.render tool.result envelopes validate against protocol schema end-to-end', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-media-host-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }))
  const validator = new AgentProtocolValidator(schemaDir)
  const packages = new AgentPackageRegistry(validator, bundledRoot)
  await packages.loadBundled()
  const pkg = packages.get('canai.demo')
  const task = taskRecord(pkg, 'task-wire-media')
  task.artifacts.push({
    artifactId: 'source-1',
    revision: 1,
    checksum: 'b'.repeat(64),
    kind: 'video',
    caption: 'Source clip',
    mimeType: 'video/mp4',
    sizeBytes: 54321,
    mediaSrc: '/media/source-1.mp4',
    provenance: 'reference',
  })

  const journalFile = path.join(root, 'journal.json')
  const journalOptions = { workspaceRoot: path.join(root, 'work'), checkpointRoot: path.join(root, 'checkpoints') }
  const journal = new AgentTaskJournal(journalFile, journalOptions)
  await journal.create(task)
  const managed = managedProcess(task, pkg)

  const renderedArtifact = {
    artifactId: 'rendered-1',
    revision: 1,
    checksum: 'a'.repeat(64),
    kind: 'video' as const,
    caption: 'Montage',
    mimeType: 'video/mp4',
    sizeBytes: 12345,
    mediaSrc: '/media/rendered-1.mp4' as const,
    provenance: 'derived' as const,
  }

  const broker = {
    execute: async (_task: unknown, tool: string, _args: unknown, _opId: string): Promise<ToolResult> => {
      if (tool === 'media.read') {
        return {
          result: {
            file: {
              path: 'media-read/test-clip.mp4',
              checksum: 'b'.repeat(64),
              sizeBytes: 54321,
              mimeType: 'video/mp4',
              kind: 'video',
            },
          },
        }
      }
      if (tool === 'media.render') {
        return {
          result: {
            artifact: renderedArtifact,
          },
          mediaRender: {
            operationId: 'op-render-1',
            artifact: renderedArtifact,
            manifestHash: 'm-hash-1',
            sourceRefs: [],
            manifest: {
              version: 1,
              mode: 'rough-cut',
              clips: [],
              fps: 24,
              maxDurationMs: 10_000,
              maxOutputBytes: 10_000_000,
              audio: 'mute',
            },
            discard: async () => {},
          },
        }
      }
      throw new Error(`Unexpected tool: ${tool}`)
    },
  }

  const hostDispatcher = dispatcher(journal, validator, broker, managed)

  // 1. media.read wire test
  const readRequest: AgentEnvelope = {
    protocolVersion: '1.0',
    messageId: 'msg-read-1',
    taskId: task.taskId,
    executionId: task.currentExecutionId!,
    type: 'tool.request',
    payload: {
      operationId: 'op-read-1',
      tool: 'media.read' as AgentTool,
      arguments: {
        artifactId: 'source-1',
        revision: 1,
        checksum: 'b'.repeat(64),
      },
    },
  }
  await hostDispatcher.handleLine(task.taskId, managed, JSON.stringify(readRequest))

  const readResultEnvelope = managed.writes.map((w: string) => JSON.parse(w)).find((env: any) => env.type === 'tool.result')
  assert.ok(readResultEnvelope)
  assert.equal(readResultEnvelope.replyTo, 'msg-read-1')
  assert.equal(readResultEnvelope.payload.status, 'succeeded')
  assert.equal(readResultEnvelope.payload.operationId, 'op-read-1')
  assert.equal(readResultEnvelope.payload.result.file.path, 'media-read/test-clip.mp4')
  assert.equal(readResultEnvelope.payload.result.file.kind, 'video')
  // End-to-end schema validation: assertEnvelope throws if schema invalid
  assert.doesNotThrow(() => validator.assertEnvelope(readResultEnvelope, 'host-to-agent'))

  // 2. media.render wire test
  const renderRequest: AgentEnvelope = {
    protocolVersion: '1.0',
    messageId: 'msg-render-1',
    taskId: task.taskId,
    executionId: task.currentExecutionId!,
    type: 'tool.request',
    payload: {
      operationId: 'op-render-1',
      tool: 'media.render' as AgentTool,
      arguments: {
        version: 1,
        mode: 'rough-cut',
        audio: 'mute',
        clips: [{
          artifact: { artifactId: 'source-1', revision: 1, checksum: 'b'.repeat(64) },
          order: 0,
          startMs: 0,
          durationMs: 1000,
        }],
        fps: 24,
        maxDurationMs: 10_000,
        maxOutputBytes: 10_000_000,
      },
    },
  }
  await hostDispatcher.handleLine(task.taskId, managed, JSON.stringify(renderRequest))

  const renderResultEnvelope = managed.writes.map((w: string) => JSON.parse(w)).find((env: any) => env.type === 'tool.result' && env.replyTo === 'msg-render-1')
  assert.ok(renderResultEnvelope)
  assert.equal(renderResultEnvelope.payload.status, 'succeeded')
  assert.equal(renderResultEnvelope.payload.operationId, 'op-render-1')
  assert.equal(renderResultEnvelope.payload.result.artifact.provenance, 'derived')
  // Check no internal fields leaked to wire
  assert.equal(renderResultEnvelope.payload.result.mediaRender, undefined)
  assert.equal(renderResultEnvelope.payload.result.manifestHash, undefined)
  // End-to-end schema validation:
  assert.doesNotThrow(() => validator.assertEnvelope(renderResultEnvelope, 'host-to-agent'))

  // Check journal record has mediaRenderOperations
  const updatedTask = await journal.get(task.taskId)
  assert.ok(updatedTask)
  assert.equal(updatedTask.artifacts.length, 2)
  assert.equal(updatedTask.artifacts[1]?.artifactId, 'rendered-1')
  assert.equal(updatedTask.artifacts[1]?.provenance, 'derived')
  assert.equal(updatedTask.mediaRenderOperations?.length, 1)
  assert.equal(updatedTask.mediaRenderOperations![0]?.operationId, 'op-render-1')
  assert.equal(updatedTask.mediaRenderOperations![0]?.manifestHash, 'm-hash-1')
})

test('media.render rejects unauthorized permission and non-running state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-media-perm-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }))
  const validator = new AgentProtocolValidator(schemaDir)
  const packages = new AgentPackageRegistry(validator, bundledRoot)
  await packages.loadBundled()
  const pkg = packages.get('canai.demo')
  const task = taskRecord(pkg, 'task-perm-media')
  const journalFile = path.join(root, 'journal.json')
  const journalOptions = { workspaceRoot: path.join(root, 'work'), checkpointRoot: path.join(root, 'checkpoints') }
  const journal = new AgentTaskJournal(journalFile, journalOptions)
  await journal.create(task)
  const managed = managedProcess(task, pkg)

  const broker = { execute: async () => ({ result: {} }) }

  // Dispatcher WITHOUT media.render permission
  const unauthDispatcher = dispatcher(journal, validator, broker, managed, ['media.read'])

  const renderRequest: AgentEnvelope = {
    protocolVersion: '1.0',
    messageId: 'msg-unauth-1',
    taskId: task.taskId,
    executionId: task.currentExecutionId!,
    type: 'tool.request',
    payload: {
      operationId: 'op-unauth-1',
      tool: 'media.render' as AgentTool,
      arguments: {
        version: 1,
        mode: 'rough-cut',
        audio: 'mute',
        clips: [{
          artifact: { artifactId: 'source-1', revision: 1, checksum: 'b'.repeat(64) },
          order: 0,
          startMs: 0,
          durationMs: 1000,
        }],
        fps: 24,
        maxDurationMs: 10_000,
        maxOutputBytes: 10_000_000,
      },
    },
  }

  await unauthDispatcher.handleLine(task.taskId, managed, JSON.stringify(renderRequest))
  const deniedEnvelope = managed.writes.map((w: string) => JSON.parse(w)).find((env: any) => env.type === 'protocol.error')
  assert.ok(deniedEnvelope)
  assert.equal(deniedEnvelope.payload.error.code, 'PERMISSION_DENIED')

  // Now mutate task to paused
  await journal.mutate(task.taskId, (entry) => {
    entry.state = 'paused'
  })
  const authDispatcher = dispatcher(journal, validator, broker, managed, ['media.render'])
  const renderRequest2: AgentEnvelope = {
    protocolVersion: '1.0',
    messageId: 'msg-paused-1',
    taskId: task.taskId,
    executionId: task.currentExecutionId!,
    type: 'tool.request',
    payload: {
      operationId: 'op-paused-1',
      tool: 'media.render' as AgentTool,
      arguments: {
        version: 1,
        mode: 'rough-cut',
        audio: 'mute',
        clips: [{
          artifact: { artifactId: 'source-1', revision: 1, checksum: 'b'.repeat(64) },
          order: 0,
          startMs: 0,
          durationMs: 1000,
        }],
        fps: 24,
        maxDurationMs: 10_000,
        maxOutputBytes: 10_000_000,
      },
    },
  }

  await authDispatcher.handleLine(task.taskId, managed, JSON.stringify(renderRequest2))
  const notRunningEnvelope = managed.writes.map((w: string) => JSON.parse(w)).filter((env: any) => env.type === 'protocol.error')[1]
  assert.ok(notRunningEnvelope)
  assert.equal(notRunningEnvelope.payload.error.code, 'TASK_NOT_RUNNING')
})

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentCheckpointPayload } from '../../../packages/agent-protocol/index.js'
import { AgentProtocolError } from './validation.js'
import { AgentTaskJournal } from './journal.js'
import type { AgentTaskRecord } from './types.js'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-journal-'))
  const workspaceRoot = path.join(root, 'work')
  const journal = new AgentTaskJournal(path.join(root, 'journal.json'), { workspaceRoot, checkpointRoot: path.join(root, 'checkpoints') })
  const task: AgentTaskRecord = {
    taskId: 'task-journal', requestId: 'request-journal', requestHash: 'hash', packageId: 'canai.demo', packageVersion: '1.0.0', packageSha: 'sha', protocolVersion: '1.0',
    projectRef: { source: 'local', id: 'board-journal' }, ownerId: 'owner', controllerId: 'owner', taskType: 'demo-plan', instruction: 'test', input: {}, inputs: [], workspaceId: 'workspace-journal', workspacePath: 'task-journal', state: 'queued', revision: 1, eventCursor: 0,
    currentMessageAcks: {}, operationIntents: {}, controlReceipts: {}, decisionReceipts: {}, receipts: [], reviews: [], decisions: [], artifacts: [], canvasItems: [], pendingCanvasItems: [], createdAt: Date.now(), updatedAt: Date.now(),
  }
  await fs.mkdir(path.join(workspaceRoot, task.workspacePath, 'output'), { recursive: true })
  return { root, journal, task }
}

test('checkpoint is atomically immutable and journal events have bounded cursors', async (t) => {
  const { root, journal, task } = await fixture()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await journal.create(task)
  const body = Buffer.from('checkpoint body')
  const file = path.join(root, 'work', task.workspacePath, 'output', 'plan.txt')
  await fs.writeFile(file, body)
  const checkpoint: AgentCheckpointPayload = {
    checkpointId: 'checkpoint-1', stateVersion: 1, state: { phase: 'planned' },
    files: [{ path: 'output/plan.txt', checksum: crypto.createHash('sha256').update(body).digest('hex') }],
  }
  const verify = async (value: AgentCheckpointPayload) => {
    const bytes = await fs.readFile(path.join(root, 'work', task.workspacePath, value.files[0].path))
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), value.files[0].checksum)
  }
  const first = await journal.writeCheckpoint(task, checkpoint, verify)
  assert.equal(first, journal.checkpointPath(task.taskId, checkpoint.checkpointId))
  assert.equal(await journal.writeCheckpoint(task, checkpoint, verify), first)
  await assert.rejects(journal.writeCheckpoint(task, { ...checkpoint, state: { phase: 'changed' } }, verify), (error: unknown) => {
    assert.ok(error instanceof AgentProtocolError)
    assert.equal(error.code, 'CHECKPOINT_CONFLICT')
    return true
  })
  await journal.mutate(task.taskId, (entry) => { entry.state = 'running' }, { type: 'state.changed', payload: { phase: 'running' } })
  await journal.mutate(task.taskId, (entry) => { entry.state = 'paused' }, { type: 'state.changed', payload: { phase: 'paused' } })
  const events = await journal.events(task.taskId, 0)
  assert.deepEqual(events.map((event) => event.cursor), [1, 2])
})

test('failed journal write does not leak an unpersisted receipt into memory or a retry', async (t) => {
  const { root, journal, task } = await fixture()
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  await journal.create(task)
  const internals = journal as unknown as { write: (document: unknown) => Promise<void> }
  const originalWrite = internals.write.bind(journal)
  let fail = true
  internals.write = async (document: unknown) => {
    if (fail) {
      fail = false
      throw new Error('forced journal write failure')
    }
    return originalWrite(document)
  }
  const receipt = {
    operationId: 'durable-op', tool: 'artifact.publish' as const, receiptId: 'receipt-durable', status: 'succeeded' as const,
    result: {}, argumentsHash: 'args', createdAt: 1,
  }
  await assert.rejects(journal.mutate(task.taskId, (entry) => { entry.receipts.push(receipt) }, { type: 'tool.result', payload: receipt as unknown as Record<string, unknown> }), /forced journal write failure/u)
  assert.equal((await journal.get(task.taskId))!.receipts.length, 0)
  const reopened = new AgentTaskJournal(path.join(root, 'journal.json'), { workspaceRoot: path.join(root, 'work'), checkpointRoot: path.join(root, 'checkpoints') })
  assert.equal((await reopened.get(task.taskId))!.receipts.length, 0)
  await journal.mutate(task.taskId, (entry) => { entry.receipts.push(receipt) }, { type: 'tool.result', payload: receipt as unknown as Record<string, unknown> })
  const reopenedAfterRetry = new AgentTaskJournal(path.join(root, 'journal.json'), { workspaceRoot: path.join(root, 'work'), checkpointRoot: path.join(root, 'checkpoints') })
  assert.equal((await reopenedAfterRetry.get(task.taskId))!.receipts.length, 1)
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const entrypoint = fileURLToPath(new URL('./demo-agent/index.mjs', import.meta.url))

function envelope(taskId, executionId, messageId, type, payload, replyTo) {
  return { protocolVersion: '1.0', messageId, taskId, executionId, type, ...(replyTo ? { replyTo } : {}), payload }
}

function ack(taskId, executionId, message) {
  return envelope(taskId, executionId, `host-ack-${message.messageId}`, 'ack', {
    eventCursor: 1, acceptedMessageId: message.messageId,
  }, message.messageId)
}

test('demo agent keeps a decision delivered in the same chunk as review ACK', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canai-demo-agent-'))
  const taskId = 'agent-task-same-chunk'
  const executionId = 'execution-same-chunk'
  const child = spawn(process.execPath, [entrypoint], {
    cwd: root,
    env: {
      NODE_ENV: 'production', CANAI_AGENT_TASK_ID: taskId, CANAI_AGENT_EXECUTION_ID: executionId, CANAI_AGENT_WORKSPACE: root,
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const closed = new Promise((resolve) => child.once('close', resolve))
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await closed
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const inbox = []
  const waiters = []
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity })
  input.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    for (let index = 0; index < waiters.length; index += 1) {
      if (!waiters[index].predicate(message)) continue
      const waiter = waiters.splice(index, 1)[0]
      waiter.resolve(message)
      return
    }
    inbox.push(message)
  })
  const waitFor = (predicate) => {
    const queued = inbox.findIndex(predicate)
    if (queued >= 0) return Promise.resolve(inbox.splice(queued, 1)[0])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((entry) => entry.resolve === resolve)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`demo agent same-chunk regression timed out: ${stderr}`))
      }, 4_000)
      waiters.push({ predicate, resolve: (value) => { clearTimeout(timer); resolve(value) } })
    })
  }
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n')
  const sendBatch = (messages) => child.stdin.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n')
  const hello = await waitFor((message) => message.type === 'hello')
  assert.deepEqual(hello.payload.supportedProtocolVersions, ['1.0'])
  send(envelope(taskId, executionId, 'host-start', 'task.start', {
    taskType: 'demo-plan', instruction: 'Create a deterministic plan', input: { sceneCount: 1, theme: 'same chunk' },
    projectRef: { source: 'local', id: 'same-chunk-board' }, inputs: [], workspaceId: 'workspace-same-chunk', connections: [], grants: [],
  }))

  let finished = null
  while (!finished) {
    const message = await waitFor(() => true)
    if (message.type === 'task.checkpoint') {
      send(ack(taskId, executionId, message))
    } else if (message.type === 'tool.request') {
      const tool = message.payload.tool
      const result = tool === 'artifact.publish'
        ? { artifact: { artifactId: 'artifact-same-chunk', revision: 1, checksum: '0'.repeat(64), kind: 'plan', caption: 'Plan', mimeType: 'text/plain', sizeBytes: 1, mediaSrc: '/media/plan.txt', provenance: 'generated', text: 'plan' } }
        : { workspaceId: 'workspace-same-chunk', items: [{ slotId: 'plan-v1', itemId: 'agent-item-same-chunk', revision: 1, artifactId: 'artifact-same-chunk' }] }
      send(envelope(taskId, executionId, `host-result-${message.messageId}`, 'tool.result', {
        operationId: message.payload.operationId, tool, receiptId: `receipt-${message.payload.operationId}`, status: 'succeeded', result,
      }, message.messageId))
    } else if (message.type === 'review.request') {
      // Deliberately coalesce the ACK and the user's decision into one stdin
      // write.  The agent must retain the decision until review() installs its
      // second waiter after acknowledge() resolves.
      sendBatch([
        ack(taskId, executionId, message),
        envelope(taskId, executionId, 'decision-same-chunk', 'review.decision', {
          reviewId: message.payload.reviewId, revision: message.payload.revision, decision: 'approved', comment: '', answers: {},
          actorId: 'test-user', decidedAt: new Date().toISOString(), grants: [],
        }),
      ])
    } else if (message.type === 'task.finished') {
      finished = message
      send(ack(taskId, executionId, message))
    }
  }
  assert.equal(finished.payload.outcome, 'succeeded')
  await closed
})

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'

const PROTOCOL = '1.0'
const taskId = process.env.CANAI_AGENT_TASK_ID
const executionId = process.env.CANAI_AGENT_EXECUTION_ID
const workspace = path.resolve(process.env.CANAI_AGENT_WORKSPACE ?? process.cwd())
const maxLineBytes = 256 * 1024
let sequence = 0
let started = false
let running = false
let taskStart = null
let current = { phase: 'start', version: 1, artifactId: null, reviewId: null, reviewRevision: 0, operationIds: {} }
const receipts = new Map()
const decisions = new Map()
const waiters = []
const inbox = []
let control = null

if (!taskId || !executionId) throw new Error('CANAI_AGENT_TASK_ID and CANAI_AGENT_EXECUTION_ID are required')

function envelope(type, payload, replyTo) {
  return {
    protocolVersion: PROTOCOL,
    messageId: `demo-${executionId}-${++sequence}`,
    taskId,
    executionId,
    type,
    ...(replyTo ? { replyTo } : {}),
    payload,
  }
}

function send(type, payload, replyTo) {
  process.stdout.write(`${JSON.stringify(envelope(type, payload, replyTo))}\n`)
}

function fail(code, message) {
  send('protocol.error', { error: { code, message, retryable: false }, fatal: true })
}

function resolveWaiter(message) {
  for (let index = 0; index < waiters.length; index += 1) {
    if (waiters[index].predicate(message)) {
      const waiter = waiters.splice(index, 1)[0]
      waiter.resolve(message)
      return true
    }
  }
  return false
}

function waitFor(predicate) {
  if (control) return Promise.resolve(control)
  const queued = inbox.findIndex(predicate)
  if (queued >= 0) return Promise.resolve(inbox.splice(queued, 1)[0])
  return new Promise((resolve) => waiters.push({ predicate, resolve }))
}

function bufferMessage(message) {
  inbox.push(message)
  if (inbox.length > 256) inbox.shift()
}

function stopWaiting(message) {
  control = message
  while (waiters.length > 0) waiters.shift().resolve(message)
}

async function acknowledge(message) {
  const response = await waitFor((candidate) => candidate.type === 'ack' && candidate.replyTo === message.messageId)
  return response
}

async function checkpoint(phase, extra = {}) {
  current = { ...current, phase, ...extra }
  const filePath = path.join(workspace, 'output', 'plan.txt')
  const checksum = createHash('sha256').update(await readFile(filePath)).digest('hex')
  const message = envelope('task.checkpoint', {
    checkpointId: `cp-${taskId}-${phase}-${current.version}-${executionId}`,
    stateVersion: 1,
    state: current,
    files: [{ path: 'output/plan.txt', checksum }],
  })
  process.stdout.write(`${JSON.stringify(message)}\n`)
  await acknowledge(message)
  return message.payload.checkpointId
}

async function tool(operationId, toolName, argumentsValue) {
  const previous = receipts.get(operationId)
  // Pending and uncertain receipts are durable history, not completed effects.
  // Reissue the same operation ID so Host/Cloud deduplication decides whether
  // the original effect already committed.
  if (previous?.status === 'succeeded') return previous
  if (previous?.status === 'pending' || previous?.status === 'uncertain') receipts.delete(operationId)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const message = envelope('tool.request', { operationId, tool: toolName, arguments: argumentsValue })
    process.stdout.write(`${JSON.stringify(message)}\n`)
    const response = await waitFor((candidate) => candidate.type === 'tool.result' && candidate.replyTo === message.messageId)
    let result = response.payload
    if (result.status === 'pending') {
      result = await waitFor((candidate) => candidate.type === 'tool.result'
        && candidate.payload.operationId === operationId
        && candidate.payload.status !== 'pending')
        .then((candidate) => candidate.payload)
    }
    if (result.status === 'uncertain') {
      receipts.delete(operationId)
      continue
    }
    if (result.status !== 'succeeded') {
      throw new Error(result.error?.message ?? `Tool ${toolName} failed`)
    }
    receipts.set(operationId, result)
    return result
  }
  throw new Error(`Tool ${toolName} did not receive approval after retries`)
}

async function review(reviewId, revision, artifact, taskType) {
  const previous = decisions.get(`${reviewId}:${revision}`)
  if (previous) return previous
  const message = envelope('review.request', {
    reviewId,
    revision,
    stageId: 'plan',
    title: taskType === 'demo-storyboard' ? 'Demo storyboard' : 'Demo plan',
    question: 'Approve this deterministic plan and add it to the local canvas?',
    materials: [{ artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum, caption: artifact.caption, role: 'proposal' }],
    decisions: ['approved', 'changes-requested', 'rejected'],
  })
  process.stdout.write(`${JSON.stringify(message)}\n`)
  await acknowledge(message)
  send('task.progress', { stageId: 'plan', label: 'Waiting for a decision on the plan', status: 'awaiting_review' })
  const response = await waitFor((candidate) => candidate.type === 'review.decision' && candidate.payload.reviewId === reviewId && candidate.payload.revision === revision)
  decisions.set(`${reviewId}:${revision}`, response.payload)
  return response.payload
}

async function writePlan(taskType, input, version) {
  const count = taskType === 'demo-storyboard'
    ? Math.max(2, Math.min(8, Number(input.frameCount ?? 4)))
    : Math.max(1, Math.min(6, Number(input.sceneCount ?? 3)))
  const theme = typeof input.theme === 'string' && input.theme.trim() ? input.theme.trim() : 'a house at dawn'
  const lines = [`CanAI demo ${taskType} v${version}`, `Theme: ${theme}`]
  for (let index = 1; index <= count; index += 1) {
    lines.push(taskType === 'demo-storyboard'
      ? `Frame ${index}: composition ${index}, warm light.`
      : `Scene ${index}: wide shot ${index}, 0-${index * 3} s.`)
  }
  const filePath = path.join(workspace, 'output', 'plan.txt')
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8')
  const bytes = await readFile(filePath)
  return {
    path: 'output/plan.txt',
    checksum: createHash('sha256').update(bytes).digest('hex'),
    text: bytes.toString('utf8'),
  }
}

async function finish(outcome, summary, artifactIds = [], error) {
  const payload = { outcome, summary, artifactIds, ...(error ? { error: { code: 'DEMO_FAILED', message: error.message, retryable: false } } : {}) }
  const message = envelope('task.finished', payload)
  process.stdout.write(`${JSON.stringify(message)}\n`)
  await acknowledge(message).catch(() => undefined)
  process.exit(0)
}

async function pauseNow() {
  if (current.phase === 'start') {
    await writePlan(taskStart.taskType, taskStart.input, current.version)
    current = { ...current, phase: 'planned' }
  }
  const checkpointId = await checkpoint(current.phase)
  const message = envelope('task.paused', { checkpointId })
  process.stdout.write(`${JSON.stringify(message)}\n`)
  await acknowledge(message).catch(() => undefined)
  process.exit(0)
}

async function execute(start, resume) {
  taskStart = start
  const saved = resume?.checkpoint?.state
  if (saved && typeof saved === 'object') current = { ...current, ...saved }
  for (const receipt of resume?.receipts ?? []) receipts.set(receipt.operationId, receipt)
  for (const decision of resume?.decisions ?? []) decisions.set(`${decision.reviewId}:${decision.revision}`, decision)
  if (current.phase === 'done') return finish('succeeded', 'Task already completed from the saved checkpoint.', current.artifactId ? [current.artifactId] : [])

  send('task.progress', { stageId: 'plan', label: 'Creating deterministic plan', status: 'running' })
  const planned = await writePlan(start.taskType, start.input, Number(current.version ?? 1))
  const artifactId = current.artifactId ?? `artifact-${taskId}-plan-v${current.version}`
  const publishOperationId = current.operationIds.publish ?? `publish-${taskId}-v${current.version}`
  current = { ...current, artifactId, operationIds: { ...current.operationIds, publish: publishOperationId } }
  if (control?.type === 'task.cancel') return finish('cancelled', 'Task cancelled by the user.')
  if (control?.type === 'task.pause') return pauseNow()
  await checkpoint('publishing')
  const published = await tool(publishOperationId, 'artifact.publish', {
    path: planned.path,
    kind: 'plan',
    caption: `Demo plan v${current.version}`,
    mimeType: 'text/plain',
    provenance: 'generated',
  })
  const artifact = published.result.artifact
  current = { ...current, artifactId: artifact.artifactId }
  const reviewId = current.reviewId ?? `review-${taskId}-v${current.version}`
  current = { ...current, reviewId, reviewRevision: current.reviewRevision || 1 }
  await checkpoint('waiting_review')
  const decision = await review(reviewId, current.reviewRevision, artifact, start.taskType)
  if (control?.type === 'task.cancel') return finish('cancelled', 'Task cancelled by the user.')
  if (control?.type === 'task.pause') return pauseNow()
  if (decision.decision === 'rejected') return finish('failed', `Plan rejected: ${decision.comment}`)
  if (decision.decision === 'changes-requested') {
    current = { ...current, version: Number(current.version) + 1, artifactId: null, reviewId: null, reviewRevision: 0, operationIds: {} }
    return execute(start, { checkpoint: { state: current }, decisions: [...decisions.values()], receipts: [...receipts.values()] })
  }

  const placeOperationId = current.operationIds.place ?? `place-${taskId}-v${current.version}`
  current = { ...current, phase: 'placing', operationIds: { ...current.operationIds, place: placeOperationId } }
  await checkpoint('placing')
  const placed = await tool(placeOperationId, 'canvas.create_results', {
    workspaceId: start.workspaceId,
    items: [{ slotId: `plan-v${current.version}`, artifact: { artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum }, caption: artifact.caption }],
  })
  const item = placed.result.items[0]
  current = { ...current, phase: 'done', itemId: item.itemId }
  await checkpoint('done')
  return finish('succeeded', 'Demo plan approved and added to the canvas.', [artifact.artifactId])
}

async function onMessage(message) {
  if (message.type === 'ack' || message.type === 'tool.result' || message.type === 'review.decision') {
    if (!resolveWaiter(message)) bufferMessage(message)
    return
  }
  if (message.type === 'task.pause' || message.type === 'task.cancel') {
    stopWaiting(message)
    if (running && message.type === 'task.cancel') void finish('cancelled', 'Task cancelled by the user.')
    return
  }
  if (message.type === 'task.start' || message.type === 'task.resume') {
    if (started) return
    started = true
    running = true
    try {
      await execute(message.type === 'task.resume' ? message.payload.start : message.payload, message.type === 'task.resume' ? message.payload : null)
    } catch (error) {
      await finish('failed', error instanceof Error ? error.message : String(error), [], error instanceof Error ? error : new Error(String(error)))
    }
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  if (Buffer.byteLength(line, 'utf8') > maxLineBytes) return fail('PROTOCOL_INVALID', 'Message exceeds 256 KiB')
  let message
  try { message = JSON.parse(line) } catch { return fail('PROTOCOL_INVALID', 'Invalid JSON') }
  void onMessage(message)
})
input.on('close', () => {
  if (!running) process.exit(0)
})

send('hello', {
  supportedProtocolVersions: ['1.0'],
  capabilities: ['checkpoint', 'resume', 'cancel', 'pause.checkpoint', 'structuredReviews', 'toolBroker'],
})

import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'

const PROTOCOL = '1.0'
const taskId = process.env.CANAI_AGENT_TASK_ID
const executionId = process.env.CANAI_AGENT_EXECUTION_ID
const maxLineBytes = 256 * 1024
let sequence = 0
let started = false
let running = false
let control = null
const waiters = []
const inbox = []
const receipts = new Map()
const decisions = new Map()
let current = { phase: 'start', version: 1, prompt: null, generationSpec: null, artifact: null, operationIds: {} }

if (!taskId || !executionId) throw new Error('CANAI_AGENT_TASK_ID and CANAI_AGENT_EXECUTION_ID are required')

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function envelope(type, payload, replyTo) {
  return {
    protocolVersion: PROTOCOL,
    messageId: `creator-${executionId}-${++sequence}`,
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
    if (!waiters[index].predicate(message)) continue
    const waiter = waiters.splice(index, 1)[0]
    waiter.resolve(message)
    return true
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

function stopped() {
  return control?.type === 'task.cancel' || control?.type === 'task.pause'
}

async function acknowledge(message) {
  return waitFor((candidate) => candidate.type === 'ack' && candidate.replyTo === message.messageId)
}

async function checkpoint(phase, extra = {}) {
  current = { ...current, phase, ...extra }
  const message = envelope('task.checkpoint', {
    checkpointId: `creator-${taskId}-${phase}-${current.version}-${executionId}`,
    stateVersion: 1,
    state: current,
    files: [],
  })
  process.stdout.write(`${JSON.stringify(message)}\n`)
  const response = await acknowledge(message)
  if (response.type === 'task.cancel' || response.type === 'task.pause') return false
  return true
}

async function tool(operationId, toolName, argumentsValue) {
  const previous = receipts.get(operationId)
  if (previous?.status === 'succeeded') return previous
  if (previous?.status === 'pending' || previous?.status === 'uncertain') receipts.delete(operationId)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (stopped()) throw new Error(control.type === 'task.cancel' ? 'Task cancelled by the user.' : 'Task paused.')
    const message = envelope('tool.request', { operationId, tool: toolName, arguments: argumentsValue })
    process.stdout.write(`${JSON.stringify(message)}\n`)
    let response = await waitFor((candidate) => candidate.type === 'tool.result' && candidate.replyTo === message.messageId)
    if (response.type === 'task.cancel' || response.type === 'task.pause') throw new Error(response.type === 'task.cancel' ? 'Task cancelled by the user.' : 'Task paused.')
    let result = response.payload
    if (result.status === 'pending') {
      response = await waitFor((candidate) => candidate.type === 'tool.result'
        && candidate.payload.operationId === operationId
        && candidate.payload.status !== 'pending')
      if (response.type === 'task.cancel' || response.type === 'task.pause') throw new Error(response.type === 'task.cancel' ? 'Task cancelled by the user.' : 'Task paused.')
      result = response.payload
    }
    if (result.status === 'uncertain') {
      receipts.delete(operationId)
      continue
    }
    if (result.status !== 'succeeded') throw new Error(result.error?.message ?? `Tool ${toolName} failed`)
    receipts.set(operationId, result)
    return result
  }
  throw new Error(`Tool ${toolName} did not receive approval after retries`)
}

async function review(reviewId, revision, stageId, title, question, materials, generationSpec) {
  const previous = decisions.get(`${reviewId}:${revision}`)
  if (previous) return previous
  const message = envelope('review.request', {
    reviewId,
    revision,
    stageId,
    title,
    question,
    materials,
    decisions: ['approved', 'changes-requested', 'rejected'],
    ...(generationSpec ? { generationSpec } : {}),
  })
  process.stdout.write(`${JSON.stringify(message)}\n`)
  const ack = await acknowledge(message)
  if (ack.type === 'task.cancel' || ack.type === 'task.pause') throw new Error(ack.type === 'task.cancel' ? 'Task cancelled by the user.' : 'Task paused.')
  send('task.progress', { stageId, label: title, status: 'awaiting_review' })
  const response = await waitFor((candidate) => candidate.type === 'review.decision' && candidate.payload.reviewId === reviewId && candidate.payload.revision === revision)
  if (response.type === 'task.cancel' || response.type === 'task.pause') throw new Error(response.type === 'task.cancel' ? 'Task cancelled by the user.' : 'Task paused.')
  decisions.set(`${reviewId}:${revision}`, response.payload)
  return response.payload
}

function grantFor(start) {
  const grant = start.grants?.find((candidate) => candidate.tools?.includes('generation.request'))
  if (!grant || grant.connectionId !== 'local-fal' || grant.status !== 'active' || !grant.generationSpec) throw new Error('Creator did not receive a complete Host media grant')
  if (!Array.isArray(grant.artifactRefs) || grant.artifactRefs.length < 1) throw new Error('Select at least one native media ref')
  if (grant.generationSpec.kind !== 'image' && grant.generationSpec.kind !== 'video') throw new Error('Creator supports images or video')
  return grant
}

function inputRefs(start, grant) {
  const refs = grant.artifactRefs
  const inputs = Array.isArray(start.inputs) ? start.inputs : []
  const byRef = new Set(inputs.map((item) => `${item.artifactId}\0${item.revision}\0${item.checksum}`))
  for (const ref of refs) if (!byRef.has(`${ref.artifactId}\0${ref.revision}\0${ref.checksum}`)) throw new Error('Selected media refs do not match Host inputs')
  return refs.map((ref) => {
    const input = inputs.find((candidate) => candidate.artifactId === ref.artifactId && candidate.revision === ref.revision && candidate.checksum === ref.checksum)
    return { artifactId: ref.artifactId, revision: ref.revision, checksum: ref.checksum, caption: input?.caption ?? 'Selected material', role: 'reference' }
  })
}

function preparedPrompt(start, llmText) {
  const input = start.input && typeof start.input === 'object' ? start.input : {}
  const style = typeof input.style === 'string' && input.style.trim() ? `\nStyle: ${input.style.trim()}` : ''
  const negative = typeof input.negativePrompt === 'string' && input.negativePrompt.trim() ? `\nAvoid: ${input.negativePrompt.trim()}` : ''
  const prompt = String(llmText ?? '').trim()
  if (!prompt || prompt.length > 16_000) throw new Error('LLM did not return a usable media prompt')
  return `${prompt}${style}${negative}`.trim().slice(0, 16_000)
}

async function finish(outcome, summary, artifactIds = [], error) {
  const payload = { outcome, summary, artifactIds, ...(error ? { error: { code: 'CREATOR_FAILED', message: error.message, retryable: false } } : {}) }
  const message = envelope('task.finished', payload)
  process.stdout.write(`${JSON.stringify(message)}\n`)
  await acknowledge(message).catch(() => undefined)
  process.exit(0)
}

function stopOutcome(summary) {
  if (control?.type === 'task.cancel') return finish('cancelled', summary)
  return finish('failed', summary, [], new Error(summary))
}

async function execute(start, resume) {
  const grant = grantFor(start)
  const refs = inputRefs(start, grant)
  const saved = resume?.checkpoint?.state
  if (saved && typeof saved === 'object') current = { ...current, ...saved }
  for (const receipt of resume?.receipts ?? []) receipts.set(receipt.operationId, receipt)
  for (const decision of resume?.decisions ?? []) decisions.set(`${decision.reviewId}:${decision.revision}`, decision)

  const llmOperationId = current.operationIds.llm ?? `creator-llm-${taskId}`
  current = { ...current, operationIds: { ...current.operationIds, llm: llmOperationId } }
  send('task.progress', { stageId: 'creator-prepare', label: 'Preparing description', status: 'running' })
  const llm = await tool(llmOperationId, 'llm.request', {
    connectionId: 'local-fal', grantId: grant.id, refs: [],
    messages: [
      { role: 'system', text: 'Prepare one specific visual prompt for CanAI. Add no explanation, only the result description.' },
      { role: 'user', text: `${start.instruction}\nSelected native materials: ${refs.map((ref) => ref.caption).join(', ')}` },
    ],
  })
  const prompt = current.prompt ?? preparedPrompt(start, llm.result?.text)
  const baseSpec = grant.generationSpec
  const generationSpec = current.generationSpec ?? {
    kind: baseSpec.kind,
    modelId: baseSpec.modelId,
    catalogRevision: baseSpec.catalogRevision,
    promptHash: digest(prompt),
    refs: grant.artifactRefs,
    paramsHash: digest(baseSpec.params),
    prompt,
    params: baseSpec.params,
    estimateMicros: baseSpec.estimateMicros,
  }
  current = { ...current, phase: 'pre-generation-review', prompt, generationSpec }
  if (!await checkpoint('pre-generation-review', { prompt, generationSpec })) return stopOutcome(control?.type === 'task.cancel' ? 'Task cancelled by the user.' : 'Task paused.')
  const preDecision = await review(
    `creator-pre-generation-${taskId}`, 1, 'creator-pre-generation',
    'Review generation',
    'Create one result from this prompt and the selected materials?',
    refs,
    generationSpec,
  )
  if (preDecision.decision !== 'approved') return finish('failed', preDecision.comment || 'Generation was not approved.', [], new Error(preDecision.comment || 'Generation was not approved.'))
  if (stopped()) return stopOutcome('Task stopped by the user.')

  const generationOperationId = current.operationIds.generation ?? `creator-generation-${taskId}`
  current = { ...current, phase: 'generation', operationIds: { ...current.operationIds, generation: generationOperationId } }
  const generated = await tool(generationOperationId, 'generation.request', {
    connectionId: 'local-fal', grantId: grant.id, kind: generationSpec.kind, prompt,
    refs: grant.artifactRefs, params: generationSpec.params, modelId: generationSpec.modelId,
  })
  const artifact = current.artifact ?? generated.result?.artifacts?.[0]
  if (!artifact || artifact.kind !== generationSpec.kind || typeof artifact.mediaSrc !== 'string' || !artifact.mediaSrc.startsWith('/media/')) throw new Error('Generation did not return a native media artifact')
  current = { ...current, phase: 'result-review', artifact }
  if (!await checkpoint('result-review', { artifact })) return stopOutcome(control?.type === 'task.cancel' ? 'Task cancelled by the user.' : 'Task paused.')
  const resultDecision = await review(
    `creator-result-${taskId}`, 1, 'creator-result',
    'Approve result',
    'Add this result to the canvas?',
    [{ artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum, caption: artifact.caption ?? 'Generated result', role: 'result' }],
  )
  if (resultDecision.decision !== 'approved') return finish('failed', resultDecision.comment || 'Result was not approved.', [], new Error(resultDecision.comment || 'Result was not approved.'))
  if (stopped()) return stopOutcome('Task stopped by the user.')
  const placementOperationId = current.operationIds.placement ?? `creator-placement-${taskId}`
  current = { ...current, phase: 'placing', operationIds: { ...current.operationIds, placement: placementOperationId } }
  const placed = await tool(placementOperationId, 'canvas.create_results', {
    workspaceId: start.workspaceId,
    items: [{ slotId: 'creator-result-v1', artifact: { artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum }, caption: artifact.caption ?? 'Created result' }],
  })
  const item = placed.result?.items?.[0]
  current = { ...current, phase: 'done', itemId: item?.itemId ?? null }
  await checkpoint('done', { itemId: item?.itemId ?? null })
  return finish('succeeded', 'Result approved and added to the canvas.', [artifact.artifactId])
}

async function onMessage(message) {
  if (message.type === 'ack' || message.type === 'tool.result' || message.type === 'review.decision') {
    if (!resolveWaiter(message)) bufferMessage(message)
    return
  }
  if (message.type === 'task.pause' || message.type === 'task.cancel') {
    stopWaiting(message)
    // Host owns the cancelling -> cancelled transition.  Do not send
    // task.finished while Host is in `cancelling`: it is intentionally
    // rejected as a late side effect, and waiting for its ack would keep the
    // child alive indefinitely.  The normal process exit lets Host reconcile
    // the cancellation without publishing a result.
    if (running && message.type === 'task.cancel') setImmediate(() => process.exit(0))
    return
  }
  if (message.type === 'task.start' || message.type === 'task.resume') {
    if (started) return
    started = true
    running = true
    try {
      const resume = message.type === 'task.resume' ? message.payload : null
      await execute(resume ? resume.start : message.payload, resume)
    } catch (error) {
      if (control?.type === 'task.cancel') {
        // Host will turn cancelling into cancelled from the child exit.  A
        // task.finished envelope is a late side effect in this state.
        process.exit(0)
      }
      const failure = error instanceof Error ? error : new Error(String(error))
      await finish('failed', failure.message, [], failure)
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
input.on('close', () => { if (!running) process.exit(0) })

send('hello', { supportedProtocolVersions: ['1.0'], capabilities: ['checkpoint', 'resume', 'cancel', 'pause.checkpoint', 'structuredReviews', 'toolBroker'] })

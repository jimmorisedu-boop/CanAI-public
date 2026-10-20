import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { claimBoard, releaseBoard, resetBoardPresence } from '../boardPresence.js'
import type { AgentTaskRecord } from './types.js'

const previousDataDir = process.env.CANAI_DATA_DIR
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-broker-'))
process.env.CANAI_DATA_DIR = dataDir
const { createProject, loadProjectSnapshot, saveProjectSnapshot } = await import('../projects.js')
const { AgentToolBroker } = await import('./tools.js')

after(async () => {
  resetBoardPresence()
  if (previousDataDir === undefined) delete process.env.CANAI_DATA_DIR
  else process.env.CANAI_DATA_DIR = previousDataDir
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => undefined)
})

function toolsTask(workspacePath: string, taskId: string, projectRef: AgentTaskRecord['projectRef']): AgentTaskRecord {
  return {
    taskId,
    requestId: `request-${taskId}`,
    requestHash: 'request-hash',
    packageId: 'canai.demo',
    packageVersion: '1.0.0',
    packageSha: 'package-sha',
    protocolVersion: '1.0',
    projectRef,
    ownerId: 'owner',
    controllerId: 'controller',
    taskType: 'demo-plan',
    instruction: 'Plan',
    input: {},
    inputs: [],
    workspaceId: `workspace-${taskId}`,
    workspacePath,
    state: 'running',
    revision: 1,
    eventCursor: 0,
    currentMessageAcks: {},
    operationIntents: {},
    controlReceipts: {},
    decisionReceipts: {},
    receipts: [],
    reviews: [],
    decisions: [],
    artifacts: [{
      artifactId: 'artifact-plan',
      revision: 1,
      checksum: 'a'.repeat(64),
      kind: 'plan',
      caption: 'Plan',
      mimeType: 'text/plain',
      sizeBytes: 4,
      mediaSrc: '/media/plan.bin',
      provenance: 'generated',
      text: 'Plan',
    }],
    canvasItems: [],
    pendingCanvasItems: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

function paidGenerationTask(workspacePath: string, taskId: string, boardId: string): AgentTaskRecord {
  const task = toolsTask(workspacePath, taskId, { source: 'local', id: boardId })
  const checksum = 'c'.repeat(64)
  task.taskType = 'paid-generation'
  task.generationBudget = {
    grantId: `grant-${taskId}`, connectionId: 'local-fal', currency: 'USD', maxCostMicros: 100_000,
    reservedMicros: 0, chargedMicros: 0, overshootMicros: 0, calls: 1, maxCalls: 1, status: 'exhausted',
    modelId: 'image-model', catalogRevision: 1, artifactRefs: [],
  }
  task.spendBudget = {
    grantId: `grant-${taskId}`, connectionId: 'local-fal', currency: 'USD', maxCostMicros: 100_000,
    reservedMicros: 0, chargedMicros: 0, overshootMicros: 0, calls: 1, maxCalls: 1, status: 'exhausted',
  }
  task.artifacts = [{
    artifactId: 'generated-artifact', revision: 1, checksum, kind: 'image', caption: 'Generated', mimeType: 'image/png',
    sizeBytes: 4, mediaSrc: '/media/generated.png', provenance: 'generated',
  }]
  task.generationOperations = [{
    operationId: 'generation-1', requestId: 'generation-request-1', argumentsHash: 'generation-hash', receiptId: 'generation-receipt-1',
    status: 'succeeded', modelId: 'image-model', catalogRevision: 1, reservedMicros: 1_000, jobId: 'job-1', createdAt: 1, updatedAt: 1,
    result: { artifacts: [{ artifactId: 'generated-artifact', revision: 1, checksum }] },
  }]
  return task
}

function resultReview(task: AgentTaskRecord, checksum: string, status: AgentTaskRecord['reviews'][number]['status'] = 'approved'): void {
  const review = {
    reviewId: 'result-review', revision: 1, stageId: 'result', title: 'Review result', question: 'Publish result?',
    materials: [{ artifactId: 'generated-artifact', revision: 1, checksum, caption: 'Generated', role: 'result' as const }],
    decisions: ['approved', 'changes-requested', 'rejected'] as Array<'approved' | 'changes-requested' | 'rejected'>,
    status, createdAt: 2,
  }
  task.reviews = status === 'approved'
    ? [{ ...review, decision: { reviewId: 'result-review', revision: 1, decision: 'approved' as const, comment: '', answers: {}, actorId: 'operator', decidedAt: new Date(2).toISOString(), grants: [] } }]
    : [review]
}

test('real AgentToolBroker defers local canvas delivery while an active board is attached', async () => {
  const board = await createProject('Agent broker board')
  const initial = { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }
  await saveProjectSnapshot(board.id, initial, 0)
  const task = {
    taskId: 'agent-task-broker-test',
    requestId: 'broker-request', requestHash: 'hash', packageId: 'canai.demo',
    packageVersion: '1.0.0', packageSha: 'sha', protocolVersion: '1.0' as const,
    projectRef: { source: 'local' as const, id: board.id }, ownerId: 'owner', controllerId: 'controller',
    taskType: 'demo-plan', instruction: 'Plan', input: {}, inputs: [{ itemId: 'frozen-selection', artifactId: 'artifact-input', revision: 1, checksum: 'b'.repeat(64), kind: 'text' as const, caption: 'Frozen input', text: 'not the first board item' }],
    workspaceId: 'workspace-agent-task-broker-test', workspacePath: dataDir,
    state: 'running' as const, revision: 1, eventCursor: 0, currentMessageAcks: {}, operationIntents: {}, controlReceipts: {}, decisionReceipts: {},
    receipts: [], reviews: [], decisions: [], artifacts: [{
      artifactId: 'artifact-plan', revision: 1, checksum: 'a'.repeat(64), kind: 'plan' as const,
      caption: 'Plan', mimeType: 'text/plain', sizeBytes: 4, mediaSrc: '/media/plan.txt' as `/media/${string}`,
      provenance: 'generated' as const, text: 'A plan',
    }], canvasItems: [], pendingCanvasItems: [], createdAt: 1, updatedAt: 1,
  }
  const broker = new AgentToolBroker({ mediaDir: path.join(dataDir, 'media'), workspaceRoot: dataDir })

  claimBoard(board.id, 'desktop-tab', 'desktop')
  const pending = await broker.execute(task, 'canvas.create_results', {
    workspaceId: task.workspaceId,
    items: [{ slotId: 'plan-v1', artifact: { artifactId: 'artifact-plan', revision: 1, checksum: 'a'.repeat(64) }, caption: 'Plan' }],
  }, 'place-agent-plan')
  assert.equal(pending.pending?.waitId, `canvas-save:${task.taskId}:place-agent-plan`)
  assert.deepEqual(await loadProjectSnapshot(board.id), { snapshot: initial, revision: 1 })

  releaseBoard(board.id, 'desktop-tab')
  const delivered = await broker.execute(task, 'canvas.create_results', {
    workspaceId: task.workspaceId,
    items: [{ slotId: 'plan-v1', artifact: { artifactId: 'artifact-plan', revision: 1, checksum: 'a'.repeat(64) }, caption: 'Plan' }],
  }, 'place-agent-plan')
  assert.equal(delivered.pending, undefined)
  const saved = await loadProjectSnapshot(board.id)
  const savedItems = saved?.snapshot && typeof saved.snapshot === 'object'
    ? (saved.snapshot as { items?: unknown[] }).items
    : undefined
  assert.equal(Array.isArray(savedItems) ? savedItems.length : 0, 1)
  const selected = await broker.execute(task, 'canvas.read_selected', {}, 'read-selected')
  assert.deepEqual(selected.result?.items, task.inputs)
})

test('agent artifact identities are collision-resistant and published bytes stay immutable on replay', async () => {
  const workspace = path.join(dataDir, 'artifact-workspace')
  const sourcePath = path.join(workspace, 'output', 'plan.txt')
  await fs.mkdir(path.dirname(sourcePath), { recursive: true })
  await fs.writeFile(sourcePath, 'version one\n', 'utf8')
  const taskId = 'agent-task-11111111-2222-3333-4444-555555555555'
  const task = toolsTask(workspace, taskId, { source: 'local', id: 'artifact-board' })
  const broker = new AgentToolBroker({ mediaDir: path.join(dataDir, 'media'), workspaceRoot: dataDir })
  const publishArgs = {
    path: 'output/plan.txt',
    kind: 'plan',
    caption: 'Plan',
    mimeType: 'text/plain',
    provenance: 'generated',
  }
  const versionOne = await broker.execute(task, 'artifact.publish', publishArgs, `publish-${taskId}-v1`)
  const first = versionOne.result.artifact as Record<string, unknown>
  assert.ok(typeof first.artifactId === 'string' && first.artifactId.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:~-]*$/u.test(first.artifactId))
  await fs.writeFile(sourcePath, 'version two\n', 'utf8')
  const versionTwo = await broker.execute(task, 'artifact.publish', publishArgs, `publish-${taskId}-v2`)
  const second = versionTwo.result.artifact as Record<string, unknown>
  assert.notEqual(second.artifactId, first.artifactId)
  assert.notEqual(second.mediaSrc, first.mediaSrc)
  assert.notEqual(second.checksum, first.checksum)

  await fs.writeFile(sourcePath, 'workspace changed after lost receipt\n', 'utf8')
  // Re-open the broker as a crash/restart stand-in: the durable media key,
  // rather than an in-memory receipt, must make the replay immutable.
  const restartedBroker = new AgentToolBroker({ mediaDir: path.join(dataDir, 'media'), workspaceRoot: dataDir })
  const replay = await restartedBroker.execute(task, 'artifact.publish', publishArgs, `publish-${taskId}-v1`)
  assert.deepEqual(replay.result.artifact, versionOne.result.artifact)
  const { mediaFilePath } = await import('../storage.js')
  assert.equal(await fs.readFile(mediaFilePath(String(first.mediaSrc)), 'utf8'), 'version one\n')

  const slots = ['foo:a', 'foo.a', 'foo_a', 'слот-'.repeat(80)]
  const board = await createProject('Agent collision board')
  await saveProjectSnapshot(board.id, { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, 0)
  const localTask = toolsTask(workspace, 'agent-task-collision-local', { source: 'local', id: board.id })
  const local = await broker.execute(localTask, 'canvas.create_results', {
    workspaceId: localTask.workspaceId,
    items: slots.map((slotId) => ({ slotId, artifact: { artifactId: 'artifact-plan', revision: 1, checksum: 'a'.repeat(64) }, caption: slotId })),
  }, 'place-collision')
  const localItems = local.result.items as Array<{ itemId: string }>
  assert.equal(new Set(localItems.map((item) => item.itemId)).size, slots.length)
  assert.ok(localItems.every((item) => item.itemId.length <= 160))

})
test('paid generation results require an exact approved result review before local canvas delivery', async () => {
  const broker = new AgentToolBroker({ mediaDir: path.join(dataDir, 'review-media'), workspaceRoot: dataDir })
  const ref = { artifactId: 'generated-artifact', revision: 1, checksum: 'c'.repeat(64) }
  const args = (task: AgentTaskRecord) => ({
    workspaceId: task.workspaceId,
    items: [{ slotId: 'result', artifact: ref, caption: 'Generated' }],
  })
  const cases: Array<{ label: string; code: string; configure: (task: AgentTaskRecord) => void }> = [
    { label: 'missing review', code: 'GENERATION_RESULT_REVIEW_REQUIRED', configure: () => undefined },
    { label: 'pending review', code: 'GENERATION_RESULT_REVIEW_REQUIRED', configure: (task) => resultReview(task, ref.checksum, 'pending') },
    { label: 'rejected review', code: 'GENERATION_RESULT_REVIEW_REQUIRED', configure: (task) => resultReview(task, ref.checksum, 'rejected') },
    { label: 'changed review material', code: 'GENERATION_RESULT_REVIEW_REQUIRED', configure: (task) => resultReview(task, 'd'.repeat(64)) },
    {
      label: 'not succeeded generation', code: 'GENERATION_RESULT_REQUIRED', configure: (task) => {
        task.generationOperations![0]!.status = 'failed'
        resultReview(task, ref.checksum)
      },
    },
  ]
  for (const scenario of cases) {
    const board = await createProject(`Review gate ${scenario.label}`)
    await saveProjectSnapshot(board.id, { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, 0)
    const task = paidGenerationTask(dataDir, `review-gate-${scenario.label.replace(/\s+/gu, '-')}`, board.id)
    scenario.configure(task)
    await assert.rejects(
      broker.execute(task, 'canvas.create_results', args(task), `place-${task.taskId}`),
      (error: unknown) => (error as { code?: string }).code === scenario.code,
    )
    const saved = await loadProjectSnapshot(board.id)
    const items = saved?.snapshot && typeof saved.snapshot === 'object' && !Array.isArray(saved.snapshot) && Array.isArray((saved.snapshot as { items?: unknown[] }).items)
      ? (saved.snapshot as { items: unknown[] }).items
      : []
    assert.equal(items.length, 0, scenario.label)
  }

  const approvedBoard = await createProject('Review gate approved')
  await saveProjectSnapshot(approvedBoard.id, { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, 0)
  const approvedTask = paidGenerationTask(dataDir, 'review-gate-approved', approvedBoard.id)
  resultReview(approvedTask, ref.checksum)
  const first = await broker.execute(approvedTask, 'canvas.create_results', args(approvedTask), 'place-approved')
  const replay = await broker.execute(approvedTask, 'canvas.create_results', args(approvedTask), 'place-approved')
  assert.deepEqual(replay.result, first.result)
  const approvedSaved = await loadProjectSnapshot(approvedBoard.id)
  const approvedItems = approvedSaved?.snapshot && typeof approvedSaved.snapshot === 'object' && !Array.isArray(approvedSaved.snapshot) && Array.isArray((approvedSaved.snapshot as { items?: unknown[] }).items)
    ? (approvedSaved.snapshot as { items: unknown[] }).items
    : []
  assert.equal(approvedItems.length, 1)

  const cancelledBoard = await createProject('Review gate cancelled')
  await saveProjectSnapshot(cancelledBoard.id, { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, 0)
  const cancelledTask = paidGenerationTask(dataDir, 'review-gate-cancelled', cancelledBoard.id)
  cancelledTask.state = 'cancelled'
  resultReview(cancelledTask, ref.checksum)
  await assert.rejects(
    broker.execute(cancelledTask, 'canvas.create_results', args(cancelledTask), 'place-cancelled'),
    (error: unknown) => (error as { code?: string }).code === 'TASK_NOT_RUNNING',
  )
  const cancelledSaved = await loadProjectSnapshot(cancelledBoard.id)
  const cancelledItems = cancelledSaved?.snapshot && typeof cancelledSaved.snapshot === 'object' && !Array.isArray(cancelledSaved.snapshot) && Array.isArray((cancelledSaved.snapshot as { items?: unknown[] }).items)
    ? (cancelledSaved.snapshot as { items: unknown[] }).items
    : []
  assert.equal(cancelledItems.length, 0)
})

function renderTask(workspacePath: string, taskId: string, boardId: string, withBudget = false): AgentTaskRecord {
  const task = toolsTask(workspacePath, taskId, { source: 'local', id: boardId })
  const checksum = 'e'.repeat(64)
  const artifactRef = { artifactId: 'rendered-artifact', revision: 1, checksum }
  task.artifacts = [{
    artifactId: 'rendered-artifact', revision: 1, checksum, kind: 'video', caption: 'Rendered clip', mimeType: 'video/mp4',
    sizeBytes: 1024, mediaSrc: '/media/rendered.mp4', provenance: 'derived',
  }]
  task.receipts = [{
    operationId: 'render-op-1', tool: 'media.render', receiptId: 'receipt-render-1', status: 'succeeded',
    result: { artifact: { ...artifactRef, kind: 'video', caption: 'Rendered clip', mimeType: 'video/mp4', sizeBytes: 1024, mediaSrc: '/media/rendered.mp4', provenance: 'derived' } },
    argumentsHash: 'render-hash', createdAt: 1,
  }]
  task.mediaRenderOperations = [{
    operationId: 'render-op-1', receiptId: 'receipt-render-1', argumentsHash: 'render-hash', manifestHash: 'manifest-hash',
    sourceRefs: [], artifact: artifactRef,
    manifest: { version: 1, mode: 'rough-cut', clips: [], fps: 24, maxDurationMs: 10_000, maxOutputBytes: 10_000_000, audio: 'mute' },
    createdAt: 1, updatedAt: 1,
  }]
  if (withBudget) {
    task.generationBudget = {
      grantId: `grant-${taskId}`, connectionId: 'local-fal', currency: 'USD', maxCostMicros: 100_000,
      reservedMicros: 0, chargedMicros: 0, overshootMicros: 0, calls: 1, maxCalls: 1, status: 'exhausted',
      modelId: 'image-model', catalogRevision: 1, artifactRefs: [],
    }
  }
  return task
}

function renderResultReview(task: AgentTaskRecord, checksum: string, status: AgentTaskRecord['reviews'][number]['status'] = 'approved'): void {
  const review = {
    reviewId: 'render-review', revision: 1, stageId: 'result', title: 'Review render', question: 'Publish render?',
    materials: [{ artifactId: 'rendered-artifact', revision: 1, checksum, caption: 'Rendered clip', role: 'result' as const }],
    decisions: ['approved', 'changes-requested', 'rejected'] as Array<'approved' | 'changes-requested' | 'rejected'>,
    status, createdAt: 2,
  }
  task.reviews = status === 'approved'
    ? [{ ...review, decision: { reviewId: 'render-review', revision: 1, decision: 'approved' as const, comment: '', answers: {}, actorId: 'operator', decidedAt: new Date(2).toISOString(), grants: [] } }]
    : [review]
}

test('Host media.render results require an approved result review before canvas delivery (with or without budget)', async () => {
  const broker = new AgentToolBroker({ mediaDir: path.join(dataDir, 'review-media'), workspaceRoot: dataDir })
  const ref = { artifactId: 'rendered-artifact', revision: 1, checksum: 'e'.repeat(64) }
  const args = (task: AgentTaskRecord) => ({
    workspaceId: task.workspaceId,
    items: [{ slotId: 'result', artifact: ref, caption: 'Rendered' }],
  })

  for (const withBudget of [false, true]) {
    const cases: Array<{ label: string; code: string; configure: (task: AgentTaskRecord) => void }> = [
      { label: `missing review (budget=${withBudget})`, code: 'GENERATION_RESULT_REVIEW_REQUIRED', configure: () => undefined },
      { label: `pending review (budget=${withBudget})`, code: 'GENERATION_RESULT_REVIEW_REQUIRED', configure: (task) => renderResultReview(task, ref.checksum, 'pending') },
      { label: `rejected review (budget=${withBudget})`, code: 'GENERATION_RESULT_REVIEW_REQUIRED', configure: (task) => renderResultReview(task, ref.checksum, 'rejected') },
      { label: `changed review material (budget=${withBudget})`, code: 'GENERATION_RESULT_REVIEW_REQUIRED', configure: (task) => renderResultReview(task, 'f'.repeat(64)) },
    ]
    for (const scenario of cases) {
      const board = await createProject(`Render gate ${scenario.label}`)
      await saveProjectSnapshot(board.id, { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, 0)
      const task = renderTask(dataDir, `render-gate-${scenario.label.replace(/[^a-zA-Z0-9]/gu, '-')}`, board.id, withBudget)
      scenario.configure(task)
      await assert.rejects(
        broker.execute(task, 'canvas.create_results', args(task), `place-${task.taskId}`),
        (error: unknown) => (error as { code?: string }).code === scenario.code,
      )
      const saved = await loadProjectSnapshot(board.id)
      const items = saved?.snapshot && typeof saved.snapshot === 'object' && !Array.isArray(saved.snapshot) && Array.isArray((saved.snapshot as { items?: unknown[] }).items)
        ? (saved.snapshot as { items: unknown[] }).items
        : []
      assert.equal(items.length, 0, scenario.label)
    }

    const approvedBoard = await createProject(`Render gate approved (budget=${withBudget})`)
    await saveProjectSnapshot(approvedBoard.id, { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, 0)
    const approvedTask = renderTask(dataDir, `render-approved-b-${withBudget}`, approvedBoard.id, withBudget)
    renderResultReview(approvedTask, ref.checksum)
    const first = await broker.execute(approvedTask, 'canvas.create_results', args(approvedTask), 'place-approved')
    const replay = await broker.execute(approvedTask, 'canvas.create_results', args(approvedTask), 'place-approved')
    assert.deepEqual(replay.result, first.result)
    const approvedSaved = await loadProjectSnapshot(approvedBoard.id)
    const approvedItems = approvedSaved?.snapshot && typeof approvedSaved.snapshot === 'object' && !Array.isArray(approvedSaved.snapshot) && Array.isArray((approvedSaved.snapshot as { items?: unknown[] }).items)
      ? (approvedSaved.snapshot as { items: unknown[] }).items
      : []
    assert.equal(approvedItems.length, 1)

    const cancelledBoard = await createProject(`Render gate cancelled (budget=${withBudget})`)
    await saveProjectSnapshot(cancelledBoard.id, { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, 0)
    const cancelledTask = renderTask(dataDir, `render-cancelled-b-${withBudget}`, cancelledBoard.id, withBudget)
    cancelledTask.state = 'cancelled'
    renderResultReview(cancelledTask, ref.checksum)
    await assert.rejects(
      broker.execute(cancelledTask, 'canvas.create_results', args(cancelledTask), 'place-cancelled'),
      (error: unknown) => (error as { code?: string }).code === 'TASK_NOT_RUNNING',
    )
    const cancelledSaved = await loadProjectSnapshot(cancelledBoard.id)
    const cancelledItems = cancelledSaved?.snapshot && typeof cancelledSaved.snapshot === 'object' && !Array.isArray(cancelledSaved.snapshot) && Array.isArray((cancelledSaved.snapshot as { items?: unknown[] }).items)
      ? (cancelledSaved.snapshot as { items: unknown[] }).items
      : []
    assert.equal(cancelledItems.length, 0)
  }
})

test('forged artifact.publish media is rejected in budget task, while non-media plans are delivered', async () => {
  const broker = new AgentToolBroker({ mediaDir: path.join(dataDir, 'review-media'), workspaceRoot: dataDir })
  const board = await createProject('Forged artifact delivery')
  await saveProjectSnapshot(board.id, { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, 0)
  const task = paidGenerationTask(dataDir, 'forged-artifact-task', board.id)
  const forgedVideoRef = { artifactId: 'forged-video', revision: 1, checksum: 'f'.repeat(64) }
  const planRef = { artifactId: 'plan-artifact', revision: 1, checksum: 'a'.repeat(64) }
  task.artifacts.push(
    { artifactId: 'forged-video', revision: 1, checksum: 'f'.repeat(64), kind: 'video', caption: 'Forged', mimeType: 'video/mp4', sizeBytes: 1024, mediaSrc: '/media/forged.mp4', provenance: 'derived' },
    { artifactId: 'plan-artifact', revision: 1, checksum: 'a'.repeat(64), kind: 'plan', caption: 'Plan text', mimeType: 'text/plain', sizeBytes: 20, mediaSrc: '/media/plan.txt', provenance: 'generated', text: 'Plan steps' },
  )

  // Forged video in budget task is rejected with GENERATION_RESULT_REQUIRED
  await assert.rejects(
    broker.execute(task, 'canvas.create_results', {
      workspaceId: task.workspaceId,
      items: [{ slotId: 'forged-slot', artifact: forgedVideoRef, caption: 'Forged video' }],
    }, 'place-forged-video'),
    (error: unknown) => (error as { code?: string }).code === 'GENERATION_RESULT_REQUIRED',
  )

  // Plan artifact in budget task is delivered without generation review
  const deliveredPlan = await broker.execute(task, 'canvas.create_results', {
    workspaceId: task.workspaceId,
    items: [{ slotId: 'plan-slot', artifact: planRef, caption: 'Plan' }],
  }, 'place-plan')
  assert.equal(deliveredPlan.pending, undefined)
  const saved = await loadProjectSnapshot(board.id)
  const items = saved?.snapshot && typeof saved.snapshot === 'object' && !Array.isArray(saved.snapshot) && Array.isArray((saved.snapshot as { items?: unknown[] }).items)
    ? (saved.snapshot as { items: unknown[] }).items
    : []
  assert.equal(items.length, 1)
})

test('mixed list of deliverables is rejected as a whole when any item lacks approval', async () => {
  const broker = new AgentToolBroker({ mediaDir: path.join(dataDir, 'review-media'), workspaceRoot: dataDir })
  const board = await createProject('Mixed list board')
  await saveProjectSnapshot(board.id, { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, 0)
  const task = paidGenerationTask(dataDir, 'mixed-list-task', board.id)
  const approvedGenRef = { artifactId: 'generated-artifact', revision: 1, checksum: 'c'.repeat(64) }
  resultReview(task, approvedGenRef.checksum)

  const unapprovedRenderRef = { artifactId: 'rendered-artifact', revision: 1, checksum: 'e'.repeat(64) }
  task.artifacts.push({
    artifactId: 'rendered-artifact', revision: 1, checksum: 'e'.repeat(64), kind: 'video', caption: 'Rendered', mimeType: 'video/mp4', sizeBytes: 1024, mediaSrc: '/media/rendered.mp4', provenance: 'derived',
  })
  task.receipts.push({
    operationId: 'render-mixed', tool: 'media.render', receiptId: 'receipt-mixed-render', status: 'succeeded',
    result: { artifact: { ...unapprovedRenderRef, kind: 'video', caption: 'Rendered', mimeType: 'video/mp4', sizeBytes: 1024, mediaSrc: '/media/rendered.mp4', provenance: 'derived' } },
    argumentsHash: 'hash', createdAt: 1,
  })
  task.mediaRenderOperations = [{
    operationId: 'render-mixed', receiptId: 'receipt-mixed-render', argumentsHash: 'hash', manifestHash: 'mhash',
    sourceRefs: [], artifact: unapprovedRenderRef,
    manifest: { version: 1, mode: 'rough-cut', clips: [], fps: 24, maxDurationMs: 10_000, maxOutputBytes: 10_000_000, audio: 'mute' },
    createdAt: 1, updatedAt: 1,
  }]
  // Note: unapprovedRenderRef has no approved review

  await assert.rejects(
    broker.execute(task, 'canvas.create_results', {
      workspaceId: task.workspaceId,
      items: [
        { slotId: 'approved-gen', artifact: approvedGenRef, caption: 'Gen' },
        { slotId: 'unapproved-render', artifact: unapprovedRenderRef, caption: 'Render' },
      ],
    }, 'place-mixed'),
    (error: unknown) => (error as { code?: string }).code === 'GENERATION_RESULT_REVIEW_REQUIRED',
  )

  const saved = await loadProjectSnapshot(board.id)
  const items = saved?.snapshot && typeof saved.snapshot === 'object' && !Array.isArray(saved.snapshot) && Array.isArray((saved.snapshot as { items?: unknown[] }).items)
    ? (saved.snapshot as { items: unknown[] }).items
    : []
  assert.equal(items.length, 0)
})

test('artifact.publish forbids provenance generated for media kinds', async () => {
  const workspace = path.join(dataDir, 'publish-forbid-workspace')
  const imgPath = path.join(workspace, 'output', 'image.png')
  const planPath = path.join(workspace, 'output', 'plan.txt')
  await fs.mkdir(path.dirname(imgPath), { recursive: true })
  await fs.writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  await fs.writeFile(planPath, 'plan content\n')
  const task = toolsTask(workspace, 'publish-forbid-task', { source: 'local', id: 'publish-board' })
  const broker = new AgentToolBroker({ mediaDir: path.join(dataDir, 'media'), workspaceRoot: dataDir })

  await assert.rejects(
    broker.execute(task, 'artifact.publish', {
      path: 'output/image.png',
      kind: 'image',
      caption: 'Generated image',
      mimeType: 'image/png',
      provenance: 'generated',
    }, 'publish-gen-image'),
    (error: unknown) => (error as { code?: string }).code === 'INPUT_INVALID',
  )

  const publishedPlan = await broker.execute(task, 'artifact.publish', {
    path: 'output/plan.txt',
    kind: 'plan',
    caption: 'Generated plan',
    mimeType: 'text/plain',
    provenance: 'generated',
  }, 'publish-gen-plan')
  assert.equal(publishedPlan.result?.artifact && typeof publishedPlan.result.artifact === 'object' && (publishedPlan.result.artifact as { provenance?: string }).provenance, 'generated')
})

test('generation.quote forwards to generation broker and returns quotation without reservations', async () => {
  const quoteExpected = {
    result: {
      spec: { kind: 'image', modelId: 'image-model', catalogRevision: 1, estimateMicros: 1000, prompt: 'cat', params: {}, promptHash: 'a'.repeat(64), paramsHash: 'b'.repeat(64), refs: [] },
      budget: { remainingMicros: 100_000, callsLeft: 1 },
    },
  }
  let quoteCalledWith: unknown = null
  const mockGen = {
    quote: async (_task: any, rawArgs: any) => {
      quoteCalledWith = rawArgs
      return quoteExpected
    },
  }
  const broker = new AgentToolBroker({ mediaDir: path.join(dataDir, 'media'), workspaceRoot: dataDir, generation: mockGen as any })
  const task = toolsTask(dataDir, 'quote-task', { source: 'local', id: 'quote-board' })
  const res = await broker.execute(task, 'generation.quote', { kind: 'image', prompt: 'cat', refs: [] }, 'quote-op-1')
  assert.deepEqual(res, quoteExpected)
  assert.deepEqual(quoteCalledWith, { kind: 'image', prompt: 'cat', refs: [] })
})

test('canvas.create_results places media items with measured aspect ratio and audio card dimensions', async () => {
  const broker = new AgentToolBroker({ mediaDir: path.join(dataDir, 'media'), workspaceRoot: dataDir })
  const board = await createProject('Measured Media Board')
  await saveProjectSnapshot(board.id, { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } }, 0)
  const task = toolsTask(dataDir, 'measured-media-task', { source: 'local', id: board.id })

  const imgChecksum = '1'.repeat(64)
  const vidChecksum = '2'.repeat(64)
  const audChecksum = '3'.repeat(64)

  task.artifacts = [
    {
      artifactId: 'img-art', revision: 1, checksum: imgChecksum, kind: 'image', caption: 'Image 800x600',
      mimeType: 'image/png', sizeBytes: 1000, mediaSrc: '/media/img.png', provenance: 'reference',
      width: 800, height: 600,
    },
    {
      artifactId: 'vid-art', revision: 1, checksum: vidChecksum, kind: 'video', caption: 'Video 1920x1080',
      mimeType: 'video/mp4', sizeBytes: 5000, mediaSrc: '/media/vid.mp4', provenance: 'reference',
      width: 1920, height: 1080, durationMs: 15_000,
    },
    {
      artifactId: 'aud-art', revision: 1, checksum: audChecksum, kind: 'audio', caption: 'Audio track',
      mimeType: 'audio/mpeg', sizeBytes: 2000, mediaSrc: '/media/aud.mp3', provenance: 'reference',
      durationMs: 120_000,
    },
  ]

  const delivered = await broker.execute(task, 'canvas.create_results', {
    workspaceId: task.workspaceId,
    items: [
      { slotId: 'slot-img', artifact: { artifactId: 'img-art', revision: 1, checksum: imgChecksum }, caption: 'Image 800x600' },
      { slotId: 'slot-vid', artifact: { artifactId: 'vid-art', revision: 1, checksum: vidChecksum }, caption: 'Video 1920x1080' },
      { slotId: 'slot-aud', artifact: { artifactId: 'aud-art', revision: 1, checksum: audChecksum }, caption: 'Audio track' },
    ],
  }, 'place-measured')

  assert.equal(delivered.pending, undefined)
  const saved = await loadProjectSnapshot(board.id)
  const items = saved?.snapshot && typeof saved.snapshot === 'object' && !Array.isArray(saved.snapshot) && Array.isArray((saved.snapshot as { items?: any[] }).items)
    ? (saved.snapshot as { items: any[] }).items
    : []
  assert.equal(items.length, 3)

  const imgItem = items.find((it: any) => it.kind === 'image')
  assert.ok(imgItem)
  assert.equal(imgItem.w, 440)
  assert.equal(imgItem.h, 330) // (600 / 800) * 440 = 330
  assert.equal(imgItem.src, '/media/img.png')

  const vidItem = items.find((it: any) => it.kind === 'video')
  assert.ok(vidItem)
  assert.equal(vidItem.w, 440)
  assert.equal(vidItem.h, 248) // Math.round((1080 / 1920) * 440) = 248
  assert.equal(vidItem.src, '/media/vid.mp4')
  assert.equal(vidItem.duration, 15)

  const audItem = items.find((it: any) => it.kind === 'audio')
  assert.ok(audItem)
  assert.equal(audItem.w, 320)
  assert.equal(audItem.h, 96)
  assert.equal(audItem.src, '/media/aud.mp3')
  assert.equal(audItem.duration, 120)
})



import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentTaskView, ProjectRef } from '../../../../../packages/agent-protocol/index'
import {
  agentActionGrants,
  agentResultKey,
  agentOutputSummary,
  isCurrentAgentReview,
  addPendingAgentStart,
  makeAgentPanelState,
  optimisticallyRequestAgentAction,
  rejectAgentAction,
  rejectPendingAgentStart,
  reconcileAgentTask,
  reconcileAgentTaskProgress,
  sameAgentProject,
  taskReview,
  taskProgressForDisplay,
  type AgentTaskSnapshot,
} from './agentPanelModel'

const localProject: ProjectRef = { source: 'local', id: 'board-a' }
const cloudCapability = {
  transport: 'cloud' as const,
  canControl: false,
  canReview: false,
}

function task(overrides: Partial<AgentTaskSnapshot> = {}): AgentTaskSnapshot {
  const base: AgentTaskView = {
    taskId: 'task-1',
    requestId: 'request-1',
    packageId: 'demo-agent',
    packageVersion: '1.0.0',
    packageSha: 'sha-demo',
    protocolVersion: '1.0',
    projectRef: localProject,
    ownerId: 'owner-1',
    controllerId: 'host-1',
    taskType: 'canvas.plan',
    instruction: 'Собери план',
    input: {},
    inputs: [],
    workspaceId: 'workspace-1',
    state: 'running',
    revision: 1,
    eventCursor: 1,
    reviews: [],
    receipts: [],
    artifacts: [],
    canvasItems: [],
    createdAt: 1,
    updatedAt: 1,
  }
  return { ...base, ...overrides }
}

test('local edition rejects a legacy remote task even with an owner grant', () => {
  const grants = agentActionGrants(cloudCapability, task({ canControl: true, canReview: true }))
  assert.deepEqual(grants, { canControl: false, canReview: false })
})

test('Cloud peer task grants cannot be elevated by a scoped owner path', () => {
  const grants = agentActionGrants(cloudCapability, task({ canControl: false, canReview: false }))
  assert.deepEqual(grants, { canControl: false, canReview: false })
})

test('Host keeps legacy board grant when task DTO omits optional grants', () => {
  const grants = agentActionGrants({ canControl: true, canReview: true }, task())
  assert.deepEqual(grants, { canControl: true, canReview: true })
})

test('own action is rendered before the delayed Host promise settles', async () => {
  let resolveHost!: () => void
  const hostPromise = new Promise<void>((resolve) => { resolveHost = resolve })
  let state = reconcileAgentTask(makeAgentPanelState(localProject), task())
  state = optimisticallyRequestAgentAction(state, 'task-1', 'pause')

  assert.equal(state.tasks[0]?.state, 'pausing')
  assert.equal(state.pending['task-1'], 'pause')
  resolveHost()
  await hostPromise
})

test('stale or wrong-board snapshots cannot erase pending UI state', () => {
  let state = reconcileAgentTask(makeAgentPanelState(localProject), task({ revision: 4 }))
  state = optimisticallyRequestAgentAction(state, 'task-1', 'cancel')
  state = reconcileAgentTask(state, task({ revision: 3, state: 'running' }))
  assert.equal(state.tasks[0]?.state, 'cancelling')
  assert.equal(state.pending['task-1'], 'cancel')

  const foreign = task({ projectRef: { source: 'local', id: 'other-board' }, revision: 99, state: 'succeeded' })
  assert.equal(reconcileAgentTask(state, foreign), state)
})

test('newer Host receipt commits the action and clears its overlay', () => {
  let state = reconcileAgentTask(makeAgentPanelState(localProject), task({ revision: 4 }))
  state = optimisticallyRequestAgentAction(state, 'task-1', 'pause')
  state = reconcileAgentTask(state, task({ revision: 5, state: 'paused' }))
  assert.equal(state.tasks[0]?.state, 'paused')
  assert.equal(state.pending['task-1'], undefined)
  assert.equal(state.tasks[0]?.optimisticAction, undefined)
})

test('rejected action rolls back only its optimistic task and keeps peer updates', () => {
  let state = reconcileAgentTask(makeAgentPanelState(localProject), task({ revision: 4 }))
  state = reconcileAgentTask(state, task({ taskId: 'peer', requestId: 'peer-request', revision: 2, updatedAt: 2 }))
  state = optimisticallyRequestAgentAction(state, 'task-1', 'pause')
  const rejected = rejectAgentAction(state, 'task-1', 'Права не подтверждены')
  assert.equal(rejected.tasks.find((candidate) => candidate.taskId === 'task-1')?.state, 'running')
  assert.equal(rejected.tasks.find((candidate) => candidate.taskId === 'task-1')?.optimisticAction, undefined)
  assert.equal(rejected.tasks.find((candidate) => candidate.taskId === 'peer')?.taskId, 'peer')
  assert.equal(rejected.error, 'Права не подтверждены')
})

test('start request keeps one submitting row until the matching task receipt', () => {
  let state = makeAgentPanelState(localProject)
  state = addPendingAgentStart(state, {
    requestId: 'stable-start', packageId: 'demo-agent', taskType: 'canvas.plan', instruction: 'План', startedAt: 1,
  })
  assert.ok(state.pendingStarts['stable-start'])
  state = reconcileAgentTask(state, task({ requestId: 'stable-start', revision: 1 }))
  assert.equal(state.pendingStarts['stable-start'], undefined)
  assert.equal(state.tasks.length, 1)
  state = addPendingAgentStart(state, {
    requestId: 'retry-start', packageId: 'demo-agent', taskType: 'canvas.plan', instruction: 'План', startedAt: 2,
  })
  state = rejectPendingAgentStart(state, 'retry-start', 'Сеть недоступна')
  assert.equal(state.pendingStarts['retry-start'], undefined)
})

test('progress events merge only when they are not stale', () => {
  let state = reconcileAgentTask(makeAgentPanelState(localProject), task({ revision: 3 }))
  state = reconcileAgentTaskProgress(state, 'task-1', {
    stageId: 'review', label: 'Проверка', status: 'running', completed: 1, total: 2,
  }, 3)
  assert.equal(state.tasks[0]?.progress?.label, 'Проверка')
  const stale = reconcileAgentTaskProgress(state, 'task-1', {
    stageId: 'old', label: 'Старый этап', status: 'running',
  }, 2)
  assert.equal(stale.tasks[0]?.progress?.stageId, 'review')
})

test('result identity is deterministic for duplicate delivery', () => {
  const first = agentResultKey('task-1', { artifactId: 'artifact-1', revision: 2 })
  const second = agentResultKey('task-1', { artifactId: 'artifact-1', revision: 2 })
  const nextRevision = agentResultKey('task-1', { artifactId: 'artifact-1', revision: 3 })
  assert.equal(first, second)
  assert.notEqual(first, nextRevision)
})

test('terminal task does not keep stale progress block', () => {
  const progress = { stageId: 'review', label: 'Ждёт решения', status: 'waiting' }
  assert.deepEqual(taskProgressForDisplay(task({ state: 'running', progress })), progress)
  assert.equal(taskProgressForDisplay(task({ state: 'succeeded', progress })), undefined)
})

test('same-revision snapshot with an older event cursor cannot rewind task state', () => {
  let state = reconcileAgentTask(makeAgentPanelState(localProject), task({ revision: 4, eventCursor: 12, state: 'awaiting_review' }))
  const stale = reconcileAgentTask(state, task({ revision: 4, eventCursor: 11, state: 'running' }))
  assert.equal(stale.tasks[0]?.state, 'awaiting_review')
  assert.equal(stale.tasks[0]?.eventCursor, 12)
})

test('review decisions require the current pending card and awaiting_review state', () => {
  const pending = {
    reviewId: 'review-1', revision: 1, stageId: 'review', title: 'Проверка', question: 'Ок?',
    materials: [], decisions: ['approved'] as const, status: 'pending' as const,
  }
  const awaiting = task({ state: 'awaiting_review', reviews: [pending] })
  assert.equal(isCurrentAgentReview(awaiting, 'review-1'), true)
  assert.equal(isCurrentAgentReview(task({ state: 'running', reviews: [pending] }), 'review-1'), false)
  assert.equal(isCurrentAgentReview(task({ state: 'awaiting_review', reviews: [{ ...pending, status: 'superseded' }] }), 'review-1'), false)
})

test('terminal task does not keep a stale pending review card', () => {
  const pendingReview = {
    reviewId: 'review-1', revision: 1, stageId: 'review', title: 'Проверка', question: 'Ок?',
    materials: [], decisions: ['approved'] as const, status: 'pending' as const,
  }
  assert.equal(taskReview(task({ state: 'succeeded', reviews: [pendingReview] })), undefined)
  assert.equal(taskReview(task({ state: 'awaiting_review', reviews: [pendingReview] }))?.reviewId, 'review-1')
})

test('output facts keep material and placement semantics separate', () => {
  const artifact = {
    artifactId: 'artifact-1', revision: 1, checksum: 'checksum-1', kind: 'text' as const,
    caption: 'План', mimeType: 'text/plain', sizeBytes: 4, mediaSrc: '/media/plan.txt' as const,
    provenance: 'generated' as const, text: 'План',
  }
  const output = agentOutputSummary(task({
    artifacts: [artifact, { ...artifact, revision: 2, checksum: 'checksum-2' }],
    canvasItems: [{ slotId: 'plan-v1', itemId: 'item-1', revision: 1, artifactId: 'artifact-1' }],
    pendingCanvasItems: [{ operationId: 'op-1', waitId: 'wait-1', workspaceId: 'workspace-1', slotId: 'plan-v2', itemId: 'item-2', revision: 2, artifactId: 'artifact-1' }],
  }))
  assert.deepEqual(output, { materialCount: 2, placedCount: 1, pendingPlacementCount: 1 })
})

test('project source is part of the task identity for late responses', () => {
  assert.equal(sameAgentProject({ source: 'local', id: 'board' }, { source: 'local', id: 'board' }), true)
  assert.equal(sameAgentProject({ source: 'local', id: 'board' }, { source: 'cloud', id: 'board' }), false)
})

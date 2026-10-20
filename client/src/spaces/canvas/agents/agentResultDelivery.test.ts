import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from '../konva/canvasStore'
import { deliverAgentResults } from './agentResultDelivery'
import type { AgentTaskView } from '../../../../../packages/agent-protocol/index'

const artifact = {
  artifactId: 'artifact-1', revision: 1, kind: 'plan' as const, caption: 'План демо',
  mimeType: 'text/plain', mediaSrc: '/media/plan.txt' as const, text: 'Один\nДва',
}

const pending = {
  operationId: 'op-agent-1', waitId: 'canvas-save:task-1:op-agent-1', workspaceId: 'workspace-1',
  slotId: 'plan-v1', itemId: 'agent-task-1-plan-v1', revision: 1, artifactId: 'artifact-1',
}

function task(overrides: Partial<AgentTaskView> = {}): AgentTaskView {
  return {
    taskId: 'task-1', requestId: 'request-1', packageId: 'demo', packageVersion: '1.0.0', packageSha: 'sha',
    protocolVersion: '1.0', projectRef: { source: 'local', id: 'board-1' }, ownerId: 'owner', controllerId: 'owner',
    taskType: 'demo-plan', instruction: 'Составь план', input: {}, inputs: [], workspaceId: 'workspace-1',
    state: 'running', revision: 2, eventCursor: 3, reviews: [], receipts: [], artifacts: [artifact], canvasItems: [],
    pendingCanvasItems: [pending], createdAt: 1, updatedAt: 2, ...overrides,
  }
}

test('Host-confirmed result is one deduplicated history mutation without camera jump', () => {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, camera: { x: 12, y: 24, scale: 1 }, items: [] })
  const mutations: unknown[] = []
  store.subscribeMutations((event) => mutations.push(event))

  const result = { slotId: 'plan-v1', itemId: 'agent-task-1-plan-v1', revision: 1, artifactId: 'artifact-1' }
  assert.deepEqual(store.placeAgentResults('task-1', [result], [artifact]), ['agent-task-1-plan-v1'])
  assert.equal(store.getItems().length, 1)
  assert.deepEqual(store.getSelection(), [])
  assert.deepEqual(store.getCamera(), { x: 12, y: 24, scale: 1 })
  assert.equal(mutations.length, 1)

  assert.deepEqual(store.placeAgentResults('task-1', [result], [artifact]), [])
  assert.equal(store.getItems().length, 1)
  assert.equal(mutations.length, 1)
  assert.equal(store.undo(), true)
  assert.equal(store.getItems().length, 0)
})

test('pending Host delivery uses the new staged shape and ignores completed receipts', () => {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [] })

  deliverAgentResults(store, { source: 'local', id: 'board-1' }, task())
  assert.deepEqual(store.getItems().map((item) => item.id), ['agent-task-1-plan-v1'])

  const completed = task({ canvasItems: [{ slotId: pending.slotId, itemId: pending.itemId, revision: 1, artifactId: pending.artifactId }], pendingCanvasItems: [] })
  const reopened = new CanvasStore()
  reopened.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [] })
  deliverAgentResults(reopened, { source: 'local', id: 'board-1' }, completed)
  assert.equal(reopened.getItems().length, 0)
})

test('pending result from another board cannot mutate the current CanvasStore', () => {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [] })
  deliverAgentResults(store, { source: 'local', id: 'other-board' }, task())
  assert.equal(store.getItems().length, 0)
})

test('an undone or deleted agent result is not resurrected by task replay', () => {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [] })
  const result = { slotId: 'plan-v1', itemId: 'agent-task-replay-plan', revision: 1, artifactId: 'artifact-replay' }
  const artifact = {
    artifactId: 'artifact-replay', revision: 1, kind: 'plan' as const, caption: 'План демо',
    mimeType: 'text/plain', mediaSrc: '/media/replay.txt', text: 'Шаг',
  }

  assert.deepEqual(store.placeAgentResults('task-replay', [result], [artifact]), ['agent-task-replay-plan'])
  assert.equal(store.undo(), true)
  assert.deepEqual(store.placeAgentResults('task-replay', [result], [artifact]), [])
  assert.equal(store.getItems().length, 0)

  assert.deepEqual(store.placeAgentResults('task-replay', [result], [artifact]), [])
  assert.equal(store.getItems().length, 0)

  const deletedStore = new CanvasStore()
  deletedStore.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [] })
  assert.deepEqual(deletedStore.placeAgentResults('task-replay', [result], [artifact]), ['agent-task-replay-plan'])
  deletedStore.removeItems([result.itemId])
  assert.deepEqual(deletedStore.placeAgentResults('task-replay', [result], [artifact]), [])
  assert.equal(deletedStore.getItems().length, 0)
})

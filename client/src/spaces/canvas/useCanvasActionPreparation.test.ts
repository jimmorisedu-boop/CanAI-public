import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasActionPreparationStatus } from '../../api'
import {
  isCanvasActionOperationCurrent,
  pollCanvasActionPreparation,
} from './useCanvasActionPreparation'

function status(jobId: string, patch: Partial<CanvasActionPreparationStatus> = {}): CanvasActionPreparationStatus {
  return {
    jobId,
    status: 'queued',
    idempotencyKey: 'action-1',
    profile: { id: null, versionId: null, modelId: 'universal' },
    quote: null,
    ...patch,
  }
}

test('preparation polling retries the same job after a reconnect', async () => {
  const ids: string[] = []
  const transient: unknown[] = []
  let first = true
  const outcome = await pollCanvasActionPreparation('job-1', {
    status: async (jobId) => {
      ids.push(jobId)
      if (first) {
        first = false
        throw new Error('offline')
      }
      return status(jobId, { status: 'done', result: { text: 'готовый текст' } })
    },
    isCurrent: () => true,
    onStatus: () => undefined,
    onTransientError: (error) => transient.push(error),
    now: () => 0,
    wait: async () => undefined,
    deadlineMs: 10_000,
  })

  assert.equal(outcome, 'review')
  assert.deepEqual(ids, ['job-1', 'job-1'])
  assert.equal(transient.length, 1)
})

test('preparation polling stops without committing after operation becomes stale', async () => {
  let current = true
  let statusCalls = 0
  const outcome = await pollCanvasActionPreparation('job-1', {
    status: async (jobId) => {
      statusCalls += 1
      return status(jobId)
    },
    isCurrent: () => current,
    onStatus: () => undefined,
    onTransientError: () => undefined,
    now: () => 0,
    wait: async () => {
      current = false
    },
    deadlineMs: 10_000,
  })

  assert.equal(outcome, 'stale')
  assert.equal(statusCalls, 1)
})

test('cancellation cleanup only belongs to the active operation', () => {
  assert.equal(isCanvasActionOperationCurrent(7, 7), true)
  assert.equal(isCanvasActionOperationCurrent(8, 7), false)
})

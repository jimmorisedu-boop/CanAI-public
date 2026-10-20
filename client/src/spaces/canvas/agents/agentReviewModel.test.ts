import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentReviewView } from '../../../../../packages/agent-protocol/index'
import { generationReviewReadiness } from './agentReviewModel.js'

function review(overrides: Partial<AgentReviewView> = {}): AgentReviewView {
  return {
    reviewId: 'review-1', revision: 1, stageId: 'stage', title: 'Review', question: 'Approve?', materials: [],
    decisions: ['approved'], status: 'pending',
    requestedGrant: { connectionId: 'local-fal', tool: 'generation.request', artifactRefs: [], maxCalls: 1, maxCost: { currency: 'USD', amountMicros: 10_000 } },
    generationSpec: {
      kind: 'image', modelId: 'image-a', catalogRevision: 1, promptHash: 'a'.repeat(64), refs: [],
      paramsHash: 'b'.repeat(64), prompt: 'Сделай картинку', params: { image_size: 'auto' }, estimateMicros: 10_000,
    },
    ...overrides,
  }
}

test('paid generation approval requires concrete canonical echoes', () => {
  assert.deepEqual(generationReviewReadiness(review()), { ready: true })
  assert.equal(generationReviewReadiness(review({ generationSpec: { ...review().generationSpec!, prompt: undefined } })).ready, false)
  assert.equal(generationReviewReadiness(review({ generationSpec: { ...review().generationSpec!, params: undefined } })).ready, false)
  assert.equal(generationReviewReadiness(review({ generationSpec: { ...review().generationSpec!, estimateMicros: undefined } })).ready, false)
  assert.equal(generationReviewReadiness(review({ generationSpec: undefined })).ready, false)
})

test('ordinary review without generation grant remains approvable', () => {
  assert.deepEqual(generationReviewReadiness({
    generationSpec: undefined,
    requestedGrant: undefined,
  }), { ready: true })
})

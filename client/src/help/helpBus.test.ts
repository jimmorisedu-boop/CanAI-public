import assert from 'node:assert/strict'
import test from 'node:test'
import { getHelpRequest, openHelp, subscribeHelp } from './helpBus.js'

test('help bus publishes a topic and observes repeated requests', () => {
  const requests: Array<{ topicId?: string; nonce: number }> = []
  const unsubscribe = subscribeHelp((request) => requests.push(request))
  try {
    openHelp('references')
    openHelp('references')
    assert.equal(requests.length, 2)
    assert.equal(requests[0].topicId, 'references')
    assert.equal(requests[1].topicId, 'references')
    assert.ok(requests[1].nonce > requests[0].nonce)
    assert.deepEqual(getHelpRequest(), requests[1])
  } finally {
    unsubscribe()
  }
})

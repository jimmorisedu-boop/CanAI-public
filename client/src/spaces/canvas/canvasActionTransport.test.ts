import assert from 'node:assert/strict'
import test from 'node:test'
import { createCanvasActionTransport, type CanvasActionTransportClient } from './canvasActionTransport'

test('canvas action transport keeps the text-prep API narrow', async () => {
  const calls: Array<[string, unknown]> = []
  const client: CanvasActionTransportClient = {
    prepareCanvasAction: async (input) => {
      calls.push(['prepare', input])
      return {
        jobId: 'job-1', status: 'queued', idempotencyKey: 'action-1',
        profile: { id: null, versionId: null, modelId: 'gemini' }, quote: null,
      }
    },
    getCanvasAction: async (id) => {
      calls.push(['status', id])
      return {
        jobId: id, status: 'done', idempotencyKey: 'action-1',
        profile: { id: null, versionId: null, modelId: 'gemini' }, quote: null,
        result: { text: 'замени мужчин на девушек' },
      }
    },
    cancelCanvasAction: async (id) => {
      calls.push(['cancel', id])
      return { ok: true, status: 'cancelled' }
    },
  }
  const transport = createCanvasActionTransport(client)
  const started = await transport.prepare({
    projectRef: { source: 'local', id: 'board-1' },
    prompt: 'замени мужчин на девушек',
    refs: [{ kind: 'image', src: '/media/source.png' }],
    assistantId: null,
    idempotencyKey: 'action-1',
  })
  const status = await transport.status(started.jobId)
  const cancelled = await transport.cancel(started.jobId)
  assert.equal(status.result?.text, 'замени мужчин на девушек')
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(calls.map(([name]) => name), ['prepare', 'status', 'cancel'])
  const input = calls[0]?.[1] as Record<string, unknown>
  assert.equal('model' in input, false)
  assert.equal('params' in input, false)
  assert.equal('tools' in input, false)
})

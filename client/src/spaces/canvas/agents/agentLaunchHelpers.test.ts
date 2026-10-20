import assert from 'node:assert/strict'
import test from 'node:test'
import { captureGenerationInputsAfterBoardSave, selectedInputKey } from './agentLaunchHelpers.js'

const request = {
  projectRef: { source: 'local' as const, id: 'board-1' },
  inputs: [{ itemId: 'item-a', kind: 'image' as const }],
}

test('native capture waits for the persisted board revision before sending inputs', async () => {
  const calls: string[] = []
  const receipts = [{
    itemId: 'item-a',
    artifact: {
      artifactId: 'agent-ref-a', revision: 1, checksum: 'a'.repeat(64), kind: 'image' as const,
      caption: 'A', mimeType: 'image/png', sizeBytes: 1, mediaSrc: '/media/a.png' as `/media/${string}`, provenance: 'reference' as const,
    },
  }]
  const result = await captureGenerationInputsAfterBoardSave(
    async () => { calls.push('save'); return { revision: 7 } },
    async (captured) => {
      calls.push(`capture:${captured.projectRevision}`)
      assert.deepEqual(captured, { ...request, projectRevision: 7 })
      return receipts
    },
    request,
  )
  assert.deepEqual(calls, ['save', 'capture:7'])
  assert.deepEqual(result, receipts)
})

test('missing save receipt blocks native capture instead of guessing a checksum', async () => {
  let called = false
  await assert.rejects(
    captureGenerationInputsAfterBoardSave(undefined, async () => {
      called = true
      return []
    }, request),
    /canvas to finish saving/u,
  )
  assert.equal(called, false)
})

test('selection identity changes when server-owned asset metadata changes in place', () => {
  const first = selectedInputKey([{
    id: 'item-a', kind: 'image', assetId: 'asset-a', assetRevision: 1, assetChecksum: 'a'.repeat(64), src: '/media/a.png',
  }])
  const second = selectedInputKey([{
    id: 'item-a', kind: 'image', assetId: 'asset-a', assetRevision: 2, assetChecksum: 'b'.repeat(64), src: '/media/a.png',
  }])
  assert.notEqual(first, second)
})

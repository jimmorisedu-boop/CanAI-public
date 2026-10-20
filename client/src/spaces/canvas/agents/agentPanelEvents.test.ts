import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCapturedArtifacts } from './agentPanelEvents'

test('generation start inputs use the exact Host capture tuple in selection order', () => {
  const inputs = [
    { itemId: 'image-a', artifactId: 'asset-a', revision: 1, checksum: '/media/a.png', kind: 'image' as const, caption: 'A' },
    { itemId: 'image-b', artifactId: 'asset-b', revision: 1, checksum: '/media/b.png', kind: 'image' as const, caption: 'B' },
  ]
  const receipts = [
    {
      itemId: 'image-b',
      artifact: { artifactId: 'native-b', revision: 2, checksum: 'b'.repeat(64), kind: 'image' as const, caption: 'Native B', mimeType: 'image/png', sizeBytes: 1, mediaSrc: '/media/native-b.png' as const, provenance: 'reference' as const },
    },
    {
      itemId: 'image-a',
      artifact: { artifactId: 'native-a', revision: 3, checksum: 'a'.repeat(64), kind: 'image' as const, caption: 'Native A', mimeType: 'image/png', sizeBytes: 1, mediaSrc: '/media/native-a.png' as const, provenance: 'reference' as const },
    },
  ]

  assert.deepEqual(applyCapturedArtifacts(inputs, receipts), [
    { ...inputs[0], artifactId: 'native-a', revision: 3, checksum: 'a'.repeat(64), caption: 'Native A' },
    { ...inputs[1], artifactId: 'native-b', revision: 2, checksum: 'b'.repeat(64), caption: 'Native B' },
  ])
})

test('text inputs and uncaptured items keep their ordinary identity', () => {
  const inputs = [
    { itemId: 'text-1', artifactId: 'text-1', revision: 1, checksum: 'hello', kind: 'text' as const, caption: 'Text' },
    { itemId: 'image-1', artifactId: 'asset-1', revision: 1, checksum: '/media/a.png', kind: 'image' as const, caption: 'Image' },
  ]
  const receipts = [{
    itemId: 'text-1',
    artifact: { artifactId: 'wrong-kind', revision: 2, checksum: 'c'.repeat(64), kind: 'plan' as const, caption: 'Plan', mimeType: 'text/plain', sizeBytes: 1, mediaSrc: '/media/plan.txt' as const, provenance: 'reference' as const },
  }]
  assert.deepEqual(applyCapturedArtifacts(inputs, receipts), inputs)
})

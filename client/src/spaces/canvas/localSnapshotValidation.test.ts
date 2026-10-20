import assert from 'node:assert/strict'
import test from 'node:test'
import { localSnapshotMediaError, localSnapshotMediaIssues } from './localSnapshotValidation.js'

const camera = { x: 0, y: 0, scale: 1 }

test('local validation finds invalid media only in media fields', () => {
  const snapshot = {
    version: 1,
    camera,
    items: [
      { id: 'bad', kind: 'image', x: 0, y: 0, w: 100, h: 100, src: '/missing/photo.png', crop: { sourceSrc: 'data:image/png;base64,missing' } },
      { id: 'link', kind: 'link', x: 0, y: 0, w: 100, h: 100, link: { previewSrc: '/media/preview.webp' } },
    ],
  }
  const issues = localSnapshotMediaIssues(snapshot)
  assert.deepEqual(issues.map((issue) => issue.path), ['items[0].src', 'items[0].crop.sourceSrc'])
  assert.match(localSnapshotMediaError(snapshot)?.message ?? '', /full recovery requires the original files/u)
})

test('local media and text references are accepted', () => {
  const snapshot = {
    version: 1,
    camera,
    items: [{ id: 'image', kind: 'image', x: 0, y: 0, w: 100, h: 100, src: '/media/photo.png?v=2' }],
    assets: [{ slot: 0, kind: 'text', text: 'ordinary URL https://example.test is not media' }],
  }
  assert.deepEqual(localSnapshotMediaIssues(snapshot), [])
  assert.equal(localSnapshotMediaError(snapshot), null)
})

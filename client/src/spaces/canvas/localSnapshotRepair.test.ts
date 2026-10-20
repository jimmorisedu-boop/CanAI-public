import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectRef } from '../../types'
import type { CanvasDoc } from './konva/types'
import { repairLocalSnapshotFromCloud } from './localSnapshotRepair'

const project: ProjectRef = { source: 'local', id: 'board-local' }

test('explicit cloud recovery rewrites media refs to local links and drops cloud identities', async () => {
  const snapshot: CanvasDoc = {
    version: 1,
    items: [
      {
        id: 'one', kind: 'image', x: 0, y: 0, w: 100, h: 100,
        src: '/api/cloud-assets/assets/ast_one?v=2', assetId: 'ast_one', mime: 'image/png',
      },
      {
        id: 'two', kind: 'image', x: 120, y: 0, w: 100, h: 100,
        src: '/api/cloud-assets/assets/ast_one', assetId: 'ast_one', mime: 'image/png',
      },
    ],
    camera: { x: 0, y: 0, scale: 1 },
  }
  const calls: string[] = []
  const repaired = await repairLocalSnapshotFromCloud(snapshot, project, async (media) => {
    calls.push(media.url)
    return { url: '/media/restored.png', mime: 'image/png' }
  })

  assert.deepEqual(calls, ['/api/cloud-assets/assets/ast_one'], 'query cache-buster снимается и один cloud asset загружается один раз')
  assert.equal(repaired.stats.repaired, 1)
  assert.equal(repaired.snapshot.items[0]?.src, '/media/restored.png')
  assert.equal(repaired.snapshot.items[1]?.src, '/media/restored.png')
  assert.equal(repaired.snapshot.items[0]?.assetId, undefined)
  assert.equal(snapshot.items[0]?.src, '/api/cloud-assets/assets/ast_one?v=2', 'исходный JSON не мутируется')
})

test('cloud recovery failure keeps the caller snapshot untouched', async () => {
  const snapshot: CanvasDoc = {
    version: 1,
    items: [{ id: 'one', kind: 'image', x: 0, y: 0, w: 100, h: 100, src: '/api/cloud-assets/assets/ast_one' }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  await assert.rejects(
    () => repairLocalSnapshotFromCloud(snapshot, project, async () => { throw new Error('cloud недоступен') }),
    /cloud недоступен/,
  )
  assert.equal(snapshot.items[0]?.src, '/api/cloud-assets/assets/ast_one')
})

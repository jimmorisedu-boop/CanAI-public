import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { onAddPromptAsset } from '../spaces/canvas/promptAssetBus'
import type { SelectionRef } from '../spaces/canvas/konva/selection'
import { applyBoardDrop } from './boardDrops'

test('перенос группы в промпт закрепляет вложения без архива и изменения координат', () => {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [
    { id: 'photo', assetId: 'asset-photo', kind: 'image', src: '/media/photo.png', x: 10, y: 20, w: 300, h: 200 },
    { id: 'clip', kind: 'video', src: '/media/clip.mp4', x: 330, y: 20, w: 300, h: 200 },
  ] })
  const before = structuredClone(store.getItems())
  const refs: SelectionRef[] = []
  onAddPromptAsset((ref) => refs.push(ref))
  try {
    assert.equal(applyBoardDrop(store, { kind: 'prompt' } as never, ['photo', 'clip']), true)
    assert.deepEqual(refs.map((ref) => ref.shapeId), ['photo', 'clip'])
    assert.equal(refs[0].assetId, 'asset-photo')
    assert.deepEqual(store.getItems(), before)
    assert.equal(store.canUndo(), false)
  } finally { onAddPromptAsset(null) }
})

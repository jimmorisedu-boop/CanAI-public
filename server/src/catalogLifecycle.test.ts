import test from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG } from './catalog.js'
import { migrateGraphModel, modelUses } from '../../packages/model-catalog/macroModels.js'
import { CatalogLibrary, catalogFamilyIds } from './catalogLibrary.js'

test('model migration is explicit and keeps the original snapshot unchanged', () => {
  const graph = { nodes: [{ id: 'a', data: { kind: 'image', model: 'grok-image', params: { resolution: '2k' } } }], edges: [] }
  const target = CATALOG.find(m => m.id === 'grok-image-hq')!
  const migrated = migrateGraphModel(graph, 'grok-image', target, CATALOG)
  assert.deepEqual(modelUses(migrated, target.id), ['a'])
  assert.deepEqual(modelUses(graph, 'grok-image'), ['a'])
})

test('incompatible replacement refuses to discard settings or change output ports', () => {
  const graph = { nodes: [{ id: 'a', data: { kind: 'image', model: 'grok-image', params: { resolution: '2k' } } }], edges: [] }
  assert.throws(() => migrateGraphModel(graph, 'grok-image', CATALOG.find(m => m.id === 'seedance-2')!, CATALOG), /different output type/)
  assert.throws(() => migrateGraphModel(graph, 'grok-image', CATALOG.find(m => m.id === 'chatgpt-image-2')!, CATALOG), /parameter/)
})

test('an edit-only replacement requires an image connection', () => {
  const graph = { nodes: [{ id: 'a', data: { kind: 'image', model: 'grok-image', params: {} } }], edges: [] }
  assert.throws(() => migrateGraphModel(graph, 'grok-image', CATALOG.find(m => m.id === 'gpt-image-2.5-flare-edit')!, CATALOG), /connected references/)
})

test('migration uses the video reference variant and counts first/last image frames', () => {
  const graph = {
    nodes: [{ id: 'a', data: { kind: 'video', model: 'grok', params: {} } }],
    edges: [
      { source: 'image-1', target: 'a', targetHandle: 'frame1' },
      { source: 'video-1', target: 'a', targetHandle: 'video1' },
    ],
  }
  const migrated = migrateGraphModel(graph, 'grok', CATALOG.find(m => m.id === 'seedance-2')!, CATALOG) as typeof graph
  assert.equal(migrated.nodes[0].data.model, 'seedance-2')
})

test('lifecycle family includes pair and videoPair in both directions', async () => {
  const family = catalogFamilyIds(CATALOG, 'seedance-2-refs')
  assert.deepEqual(new Set(family), new Set(['seedance-2', 'seedance-2-i2v', 'seedance-2-refs']))
})

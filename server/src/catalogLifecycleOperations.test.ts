import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CATALOG } from './catalog.js'
import type { Lifecycle } from './catalogLibrary.js'

test('archive keeps saved macros executable while disable requires their migration', async t => {
  const module = await import('./catalogLifecycleOperations.js') as {
    CatalogLifecycleOperations: new (...args: any[]) => {
      plan(modelId: string, target: Lifecycle): Promise<{ macros: Array<{ id: string }>; replacementModels: Array<{ id: string }> }>
    }
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-lifecycle-archive-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  const graph = { nodes: [{ id: 'node-1', data: { kind: 'image', model: 'grok-image', params: {} } }], edges: [] }
  const library = {
    models: () => CATALOG,
    view: () => ({
      revision: 0,
      defaults: { image: 'chatgpt-image-2', video: 'seedance-2', audio: 'sam-audio-separate', assistant: 'gemini' },
      models: CATALOG,
    }),
    applyLifecycleChange: async () => {},
  }
  const workflows = {
    listMacros: async () => [{ id: 'macro-1', name: 'Макрос', revision: 1, graph, createdAt: 1, updatedAt: 1 }],
    migrateModelsBatch: async () => [],
  }
  const operations = new module.CatalogLifecycleOperations(
    path.join(dir, 'operations.json'), library, workflows, () => {},
  )

  assert.deepEqual((await operations.plan('grok-image', 'archived')).macros, [])
  const disabled = await operations.plan('grok-image', 'disabled')
  assert.deepEqual(disabled.macros.map(item => item.id), ['macro-1'])
  const pairedIds = new Set(CATALOG.flatMap(model => [model.pairId, model.videoPairId]).filter(Boolean))
  assert.equal(disabled.replacementModels.some(model => pairedIds.has(model.id)), false)
})

test('retry after macro phase skips duplicate migration and completes lifecycle', async t => {
  const module = await import('./catalogLifecycleOperations.js') as {
    CatalogLifecycleOperations?: new (...args: any[]) => {
      plan(modelId: string, target: Lifecycle): Promise<{ operationId: string }>
      apply(input: {
        operationId: string
        modelId: string
        defaultReplacements: Record<string, string>
        macroReplacements: Record<string, string>
      }): Promise<unknown>
    }
  }
  assert.ok(module.CatalogLifecycleOperations, 'координатор lifecycle должен существовать')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-lifecycle-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  let lifecycle: Lifecycle = 'active'
  let revision = 4
  let catalogAttempts = 0
  let macroWrites = 0
  const models = CATALOG.map(model => ({ ...model, lifecycle: model.id.startsWith('grok-image') ? lifecycle : model.lifecycle }))
  const library = {
    models: () => models,
    view: () => ({
      revision,
      defaults: { image: 'grok-image', video: 'seedance-2', audio: 'sam-audio-separate', assistant: 'gemini' },
      models,
    }),
    applyLifecycleChange: async (_id: string, target: Lifecycle, _defaults: unknown, expected: number) => {
      catalogAttempts += 1
      assert.equal(expected, 4)
      if (catalogAttempts === 1) throw new Error('disk temporarily locked')
      lifecycle = target
      revision += 1
    },
  }
  const workflows = {
    listMacros: async () => [{
      id: 'macro-1', name: 'Макрос', revision: 2,
      graph: { nodes: [{ id: 'node-1', data: { kind: 'image', model: 'grok-image', params: {} } }], edges: [] },
      createdAt: 1, updatedAt: 1,
    }],
    migrateModelsBatch: async () => { macroWrites += 1; return [] },
  }
  const operations = new module.CatalogLifecycleOperations!(
    path.join(dir, 'operations.json'), library, workflows, () => {},
  )
  const plan = await operations.plan('grok-image', 'disabled')
  const input = {
    operationId: plan.operationId,
    modelId: 'grok-image',
    defaultReplacements: { image: 'chatgpt-image-2' },
    macroReplacements: { 'macro-1': 'grok-image-hq' },
  }

  await assert.rejects(operations.apply(input), /disk temporarily locked/)
  await operations.apply(input)

  assert.equal(macroWrites, 1)
  assert.equal(catalogAttempts, 2)
  assert.equal(lifecycle, 'disabled')
})

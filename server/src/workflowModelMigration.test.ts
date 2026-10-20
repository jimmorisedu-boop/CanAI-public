import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CATALOG } from '../../packages/model-catalog/catalog.js'

async function isolatedWorkflowStore(t: { after(fn: () => Promise<void> | void): void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-model-migration-'))
  process.env.CANAI_DATA_DIR = dir
  t.after(async () => {
    delete process.env.CANAI_DATA_DIR
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return import(`./workflows.js?model-migration=${path.basename(dir)}`)
}

test('batch model migration validates every macro before writing any of them', async t => {
  const { workflowStore } = await isolatedWorkflowStore(t)
  const first = await workflowStore.saveMacro('Первый', {
    nodes: [{ id: 'image-a', data: { kind: 'image', model: 'grok-image', params: {} } }],
    edges: [],
  })
  const second = await workflowStore.saveMacro('Второй', {
    nodes: [{ id: 'image-b', data: { kind: 'image', model: 'grok-image', params: {} } }],
    edges: [],
  })
  const before = await workflowStore.listMacros()

  await assert.rejects(
    workflowStore.migrateModelsBatch({
      fromFamily: ['grok-image', 'grok-image-edit'],
      replacements: [
        { macroId: first.id, revision: first.revision, targetModelId: 'grok-image-hq' },
        { macroId: second.id, revision: second.revision, targetModelId: 'seedance-2' },
      ],
      models: CATALOG,
    }),
    /different output type/u,
  )

  assert.deepEqual(await workflowStore.listMacros(), before)
})

test('batch model migration changes all macros in one durable revision', async t => {
  const { workflowStore } = await isolatedWorkflowStore(t)
  const first = await workflowStore.saveMacro('Первый', {
    nodes: [{ id: 'image-a', data: { kind: 'image', model: 'grok-image', params: {} } }],
    edges: [],
  })
  const second = await workflowStore.saveMacro('Второй', {
    nodes: [{ id: 'image-b', data: { kind: 'image', model: 'grok-image-edit', params: {} } }],
    edges: [{ source: 'source', target: 'image-b', targetHandle: 'image1' }],
  })

  const migrated = await workflowStore.migrateModelsBatch({
    fromFamily: ['grok-image', 'grok-image-edit'],
    replacements: [
      { macroId: first.id, revision: first.revision, targetModelId: 'grok-image-hq' },
      { macroId: second.id, revision: second.revision, targetModelId: 'grok-image-hq' },
    ],
    models: CATALOG,
  })

  assert.equal(migrated.find((macro: { id: string; revision: number }) => macro.id === first.id)?.revision, first.revision + 1)
  assert.equal(migrated.find((macro: { id: string; revision: number }) => macro.id === second.id)?.revision, second.revision + 1)
  assert.match(JSON.stringify(migrated), /grok-image-hq/)
  assert.doesNotMatch(JSON.stringify(migrated), /"model":"grok-image"/)
})

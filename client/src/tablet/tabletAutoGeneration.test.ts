import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogModel } from '../types'
import type { SelectionRef } from '../spaces/canvas/konva/selection'
import { AUTO_MODEL_ID, selectSmartModel } from '../spaces/canvas/smartModelSelection'
import { planTabletGenerationLaunch } from './useTabletGeneration'

const model = (overrides: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'default',
  name: 'Default',
  kind: 'image',
  refs: true,
  maxImageRefs: 1,
  params: [],
  ...overrides,
})

const image = (shapeId: string, src: string): SelectionRef => ({
  shapeId,
  kind: 'image',
  label: shapeId,
  src,
  w: 100,
  h: 100,
})

function baseInput(overrides: Partial<Parameters<typeof planTabletGenerationLaunch>[0]> = {}) {
  const refs = [image('one', '/media/one.png'), image('two', '/media/two.png')]
  const models = [
    model({ id: 'default', name: 'Default · one ref', maxImageRefs: 1 }),
    model({ id: 'fallback', name: 'Fallback · many refs', maxImageRefs: 14 }),
  ]
  const selectModel = (groupRefs: readonly SelectionRef[]) => selectSmartModel({
    models,
    kind: 'image',
    refs: groupRefs.map((ref) => ({ kind: ref.kind })),
    modelId: AUTO_MODEL_ID,
  })
  return {
    kind: 'image' as const,
    prompt: 'сделай обложку',
    refs,
    count: 1,
    params: {},
    batchMode: 'each' as const,
    itemById: () => undefined,
    selectModel,
    ...overrides,
  }
}

test('tablet each launch uses the same per-group resolver as preview for a one-ref model', () => {
  const result = planTabletGenerationLaunch(baseInput())

  assert.equal(result.admission.error, null)
  assert.equal(result.jobs, 2)
  assert.deepEqual(result.requests.map((request) => request.plan.model?.id), ['default', 'default'])
})

test('auto each uses the default per group but together falls back to the aggregate-capable model', () => {
  const refs = Array.from({ length: 6 }, (_, index) => image(`ref-${index + 1}`, `/media/ref-${index + 1}.png`))
  const each = planTabletGenerationLaunch(baseInput({ refs }))
  const together = planTabletGenerationLaunch(baseInput({ refs, batchMode: 'together' }))

  assert.equal(each.jobs, 6)
  assert.deepEqual(each.requests.map((request) => request.plan.model?.id), Array(6).fill('default'))
  assert.deepEqual(together.requests.map((request) => request.plan.model?.id), ['fallback'])
})

test('manual min refs reject preview and launch planning equally', () => {
  const selected = model({ id: 'manual', name: 'Manual min two', minImageRefs: 2, maxImageRefs: 4 })
  const refs = [image('one', '/media/one.png'), image('two', '/media/two.png')]
  const selectModel = (groupRefs: readonly SelectionRef[]) => selectSmartModel({
    models: [selected],
    kind: 'image',
    modelId: selected.id,
    refs: groupRefs.map((ref) => ({ kind: ref.kind })),
  })
  const result = planTabletGenerationLaunch(baseInput({
    refs,
    selectModel,
  }))

  assert.match(result.admission.error ?? '', /needs at least 2/u)
  assert.equal(result.requests.length, 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateGenerationCost, shouldAskLocalCostConfirmation } from './generationEstimate'
import type { CatalogModel } from '../../types'
import type { GraphSnapshot } from '../nodes/types'

test('image estimate multiplies by requested variants', () => {
  const model = { id: 'priced', name: 'Priced', kind: 'image' as const, refs: false, params: [], pricing: { unit: 'image' as const, usd: 0.04 } }
  assert.equal(estimateGenerationCost(model, {}, 4), 0.16)
})

test('unknown model price returns null', () => {
  const model = { id: 'custom', name: 'Custom', kind: 'image' as const, refs: false, params: [] }
  assert.equal(estimateGenerationCost(model, {}, 1), null)
})

test('does not invent generic resolution or quality multipliers', () => {
  const model: CatalogModel = {
    id: 'plain-price',
    name: 'Plain price',
    kind: 'image',
    refs: false,
    params: [],
    pricing: { unit: 'image', usd: 0.1 },
  }
  assert.equal(estimateGenerationCost(model, { resolution: '4k', quality: 'high' }, 1), 0.1)
  assert.equal(estimateGenerationCost(model, { quality: 'low' }, 1), 0.1)
})

test('uses explicit parameter-specific catalog rates', () => {
  const model: CatalogModel = {
    id: 'parameter-price',
    name: 'Parameter price',
    kind: 'image',
    refs: false,
    params: [
      {
        name: 'resolution',
        label: 'Resolution',
        widget: 'select',
        default: '1K',
        options: [],
      },
    ],
    pricing: {
      unit: 'image',
      usd: 0.15,
      byParam: {
        name: 'resolution',
        usd: { '1K': 0.15, '2K': 0.15, '4K': 0.3 },
      },
    },
  }
  assert.equal(estimateGenerationCost(model, { resolution: '4K' }, 1), 0.3)
  assert.equal(estimateGenerationCost(model, {}, 1), 0.15)
})

test('uses an exact multi-parameter price before a one-dimensional fallback', () => {
  const model: CatalogModel = {
    id: 'matrix-price',
    name: 'Matrix price',
    kind: 'image',
    refs: false,
    params: [
      { name: 'aspect_ratio', label: 'Пропорции', widget: 'select', default: '4:3', options: [] },
      { name: 'quality', label: 'Quality', widget: 'select', default: 'high', options: [] },
    ],
    pricing: {
      unit: 'image',
      usd: 0.145,
      byParam: {
        name: 'quality',
        usd: { low: 0.005, medium: 0.037, high: 0.145 },
      },
      byParams: {
        names: ['aspect_ratio', 'quality'],
        usd: {
          '4:3|high': 0.145,
          '1:1|high': 0.211,
        },
      },
    },
  }
  assert.equal(
    estimateGenerationCost(model, { aspect_ratio: '1:1', quality: 'high' }, 1),
    0.211,
  )
  assert.equal(
    estimateGenerationCost(model, { aspect_ratio: '4:3', quality: 'low' }, 1),
    0.005,
  )
})

test('conservatively includes additional input references in edit price', () => {
  const model: CatalogModel = {
    id: 'edit-price',
    name: 'Edit price',
    kind: 'image',
    refs: true,
    params: [
      { name: 'aspect_ratio', label: 'Пропорции', widget: 'select', default: 'auto', options: [] },
      { name: 'quality', label: 'Quality', widget: 'select', default: 'high', options: [] },
    ],
    pricing: {
      unit: 'image',
      usd: 0.413,
      additionalReferenceUsd: 0.013,
      byParams: {
        names: ['aspect_ratio', 'quality'],
        usd: {
          'auto|high': 0.413,
          '1:1|high': 0.219,
        },
      },
    },
  }
  assert.equal(
    estimateGenerationCost(model, { aspect_ratio: 'auto', quality: 'high' }, 1, 1),
    0.413,
  )
  assert.equal(
    estimateGenerationCost(model, { aspect_ratio: '1:1', quality: 'high' }, 1, 3),
    0.245,
  )
})

test('uses explicit per-second rate and a catalog default for auto duration', () => {
  const model: CatalogModel = {
    id: 'video-price',
    name: 'Video price',
    kind: 'video',
    refs: false,
    params: [
      {
        name: 'resolution',
        label: 'Resolution',
        widget: 'select',
        default: '720p',
        options: [],
      },
      {
        name: 'duration',
        label: 'Duration',
        widget: 'select',
        default: 'auto',
        options: [],
      },
    ],
    pricing: {
      unit: 'second',
      usd: 0.3034,
      defaultDuration: 8,
      byParam: {
        name: 'resolution',
        usd: { '720p': 0.3034, '1080p': 0.682 },
      },
    },
  }
  assert.equal(estimateGenerationCost(model, { resolution: '1080p', duration: '7' }, 1), 4.774)
  assert.equal(estimateGenerationCost(model, { resolution: '720p', duration: 'auto' }, 1), 2.4272)
})

test('локальный порог подтверждения не действует на сетевой доске', () => {
  assert.equal(shouldAskLocalCostConfirmation('cloud', true, 0.08, 0.01), false)
  assert.equal(shouldAskLocalCostConfirmation('local', true, 0.08, 0.01), true)
  assert.equal(shouldAskLocalCostConfirmation('local', true, 0.08, 1), false)
  assert.equal(shouldAskLocalCostConfirmation('local', false, 0.08, 0.01), false)
})

test('fixed reference fees are not multiplied by video duration', () => {
  const model: CatalogModel = {
    id: 'video-ref-fee',
    name: 'Video Ref Fee',
    kind: 'video',
    refs: true,
    params: [
      { name: 'duration', label: 'Duration', widget: 'slider', default: 6 },
    ],
    pricing: { unit: 'second', usd: 0.14, perReferenceUsd: 0.01 },
  }

  assert.equal(estimateGenerationCost(model, {}, 1, 1), 0.85)
  assert.equal(estimateGenerationCost(model, { duration: 10 }, 2, 1), 2.82)
})

test('оценка макроса исключает бесплатные ноды и учитывает эффективную ref-модель', async () => {
  const module = await import('./macroEstimate.js').catch(() => null)
  if (!module) throw new Error('нужна единая оценка стоимости макроса')

  const models: CatalogModel[] = [
    {
      id: 'base',
      name: 'База',
      kind: 'image',
      refs: false,
      pairId: 'edit',
      params: [],
      pricing: { unit: 'image', usd: 0.1 },
    },
    {
      id: 'edit',
      name: 'По референсу',
      kind: 'image',
      refs: true,
      maxImageRefs: 2,
      params: [],
      pricing: { unit: 'image', usd: 0.2 },
    },
  ]
  const graph = {
    nodes: [
      {
        id: 'file',
        type: 'gen',
        position: { x: 0, y: 0 },
        data: {
          kind: 'media',
          prompt: '',
          status: 'done',
          result: { url: '/media/ref.png', mime: 'image/png' },
        },
      },
      ...(['input', 'output', 'note', 'wait', 'combine'] as const).map((kind, index) => ({
        id: kind,
        type: 'gen',
        position: { x: index, y: 0 },
        data: { kind, prompt: kind === 'note' ? 'текст' : '', status: 'idle' as const },
      })),
      {
        id: 'image',
        type: 'gen',
        position: { x: 10, y: 0 },
        data: { kind: 'image', prompt: 'Готово', status: 'idle', model: 'base' },
      },
    ],
    edges: [
      {
        id: 'ref',
        source: 'file',
        sourceHandle: 'image',
        target: 'image',
        targetHandle: 'ref1',
      },
    ],
  } as GraphSnapshot

  assert.deepEqual(module.estimateMacroCost(graph, models, 3), {
    perRun: 0.2,
    total: 0.6,
    unknownCount: 0,
  })
})

test('оценка макроса учитывает каждый подключённый image-референс', async () => {
  const { estimateMacroCost } = await import('./macroEstimate.js')
  const models: CatalogModel[] = [
    {
      id: 'base',
      name: 'База',
      kind: 'image',
      refs: false,
      pairId: 'edit',
      params: [],
      pricing: { unit: 'image', usd: 0.145 },
    },
    {
      id: 'edit',
      name: 'По референсам',
      kind: 'image',
      refs: true,
      maxImageRefs: 16,
      params: [],
      pricing: {
        unit: 'image',
        usd: 0.413,
        additionalReferenceUsd: 0.013,
      },
    },
  ]
  const refNodes = Array.from({ length: 16 }, (_, index) => ({
    id: `ref-${index}`,
    type: 'gen' as const,
    position: { x: index, y: 0 },
    data: {
      kind: 'media' as const,
      prompt: '',
      status: 'done' as const,
      result: { url: `/media/ref-${index}.png`, mime: 'image/png' },
    },
  }))
  const graph = {
    nodes: [
      ...refNodes,
      {
        id: 'image',
        type: 'gen',
        position: { x: 20, y: 0 },
        data: {
          kind: 'image',
          prompt: 'Собери коллаж',
          status: 'idle',
          model: 'base',
        },
      },
    ],
    edges: refNodes.map((node, index) => ({
      id: `edge-${index}`,
      source: node.id,
      sourceHandle: 'image',
      target: 'image',
      targetHandle: `ref${index + 1}`,
    })),
  } as GraphSnapshot

  assert.deepEqual(estimateMacroCost(graph, models, 2), {
    perRun: 0.608,
    total: 1.216,
    unknownCount: 0,
  })
})

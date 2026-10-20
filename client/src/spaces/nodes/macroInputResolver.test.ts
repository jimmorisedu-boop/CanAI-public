// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import * as inputResolverModule from './macroContextPreflight.js'
import * as inputPortsModule from './macroInputPorts.js'
import type { GenRef } from '../../types.js'
import type { GraphSnapshot } from './types.js'

type ResolvedRun = {
  refs: readonly GenRef[]
  refsByEdge: Readonly<Record<string, readonly GenRef[]>>
  assetsBySlot: Readonly<Record<string, GenRef | null>>
  diagnostics: readonly {
    nodeId: string
    handleId: string
    message: string
  }[]
}

type ResolveMacroInputs = (
  graph: GraphSnapshot,
  options: {
    refBatches: readonly (readonly GenRef[])[]
    getAsset: (slot: number) =>
      | {
          slot: number
          kind: 'image' | 'video' | 'text'
          src?: string
          text?: string
          width?: number
          height?: number
        }
      | undefined
  },
) => {
  runs: readonly ResolvedRun[]
}

const resolveMacroInputs = (
  inputResolverModule as unknown as {
    resolveMacroInputs?: ResolveMacroInputs
  }
).resolveMacroInputs

type InputPortModel = {
  getPort: (
    nodeId: string,
    handleId: string,
  ) => { kind: 'image' | 'video' | 'text'; ordinal: number; label: string } | undefined
  resolveEdgeOrdinal?: (
    edge: GraphSnapshot['edges'][number],
  ) => number | undefined
}

const buildMacroInputPortModel = (
  inputPortsModule as unknown as {
    buildMacroInputPortModel?: (
      nodes: GraphSnapshot['nodes'],
      edges: GraphSnapshot['edges'],
    ) => InputPortModel
  }
).buildMacroInputPortModel

function input(id: string, y: number, assetSlot?: number): GraphSnapshot['nodes'][number] {
  return {
    id,
    type: 'gen',
    position: { x: 0, y },
    data: { kind: 'input', prompt: '', status: 'idle', assetSlot },
  }
}

function target(id: string): GraphSnapshot['nodes'][number] {
  return {
    id,
    type: 'gen',
    position: { x: 300, y: 0 },
    data: { kind: 'video', prompt: 'готово', status: 'idle' },
  }
}

test('один dynamic Input сохраняет legacy-нумерацию по ref1/ref2', () => {
  assert.equal(typeof resolveMacroInputs, 'function')
  assert.equal(typeof buildMacroInputPortModel, 'function')
  const graph: GraphSnapshot = {
    nodes: [
      input('image-input', 0),
      target('target'),
    ],
    edges: [
      {
        id: 'image-ref1',
        source: 'image-input',
        sourceHandle: 'images',
        target: 'target',
        targetHandle: 'ref1',
      },
      {
        id: 'image-ref2',
        source: 'image-input',
        sourceHandle: 'images',
        target: 'target',
        targetHandle: 'ref2',
      },
    ],
  }
  const portModel = buildMacroInputPortModel!(graph.nodes, graph.edges)

  assert.equal(portModel.getPort('image-input', 'images')?.label, 'image')
  assert.equal(portModel.resolveEdgeOrdinal?.(graph.edges[0]), 0)
  assert.equal(portModel.resolveEdgeOrdinal?.(graph.edges[1]), 1)

  const resolution = resolveMacroInputs!(graph, {
    refBatches: [[
      { kind: 'image', src: '/media/image-1.png' },
      { kind: 'image', src: '/media/image-2.png' },
    ]],
    getAsset: () => undefined,
  })

  assert.deepEqual(resolution.runs[0].refsByEdge['image-ref1'], [
    { kind: 'image', src: '/media/image-1.png' },
  ])
  assert.deepEqual(resolution.runs[0].refsByEdge['image-ref2'], [
    { kind: 'image', src: '/media/image-2.png' },
  ])
})

test('heterogeneous image/video Input используют type ordinal даже на ref2/frame2', () => {
  assert.equal(typeof resolveMacroInputs, 'function')
  assert.equal(typeof buildMacroInputPortModel, 'function')
  const graph: GraphSnapshot = {
    nodes: [
      input('image-input', 0),
      input('video-input', 100),
      target('image-target'),
      target('video-target'),
    ],
    edges: [
      {
        id: 'image-edge',
        source: 'image-input',
        sourceHandle: 'images',
        target: 'image-target',
        targetHandle: 'ref2',
      },
      {
        id: 'video-edge',
        source: 'video-input',
        sourceHandle: 'video',
        target: 'video-target',
        targetHandle: 'frame2',
      },
    ],
  }
  const portModel = buildMacroInputPortModel!(graph.nodes, graph.edges)

  assert.equal(portModel.getPort('image-input', 'images')?.label, 'image #1')
  assert.equal(portModel.getPort('video-input', 'video')?.label, 'video #1')

  const resolution = resolveMacroInputs!(graph, {
    refBatches: [
      [
        { kind: 'image', src: '/media/image-1.png' },
        { kind: 'image', src: '/media/image-2.png' },
        { kind: 'video', src: '/media/video-1.mp4' },
      ],
      [
        { kind: 'image', src: '/media/image-1.png' },
        { kind: 'video', src: '/media/video-1.mp4' },
      ],
    ],
    getAsset: () => undefined,
  })

  assert.deepEqual(resolution.runs[0].refsByEdge['image-edge'], [
    { kind: 'image', src: '/media/image-1.png' },
  ])
  assert.deepEqual(resolution.runs[0].refsByEdge['video-edge'], [
    { kind: 'video', src: '/media/video-1.mp4' },
  ])
  assert.deepEqual(resolution.runs[1].refsByEdge['image-edge'], [
    { kind: 'image', src: '/media/image-1.png' },
  ])
  assert.deepEqual(resolution.runs[1].diagnostics, [])
  assert.equal(portModel.resolveEdgeOrdinal?.(graph.edges[0]), 0)
  assert.equal(portModel.resolveEdgeOrdinal?.(graph.edges[1]), 0)
})

test('несколько Input одного типа выбирают свой image/video/text ref независимо от target handle', () => {
  assert.equal(typeof resolveMacroInputs, 'function')
  assert.equal(typeof buildMacroInputPortModel, 'function')
  const graph: GraphSnapshot = {
    nodes: [
      input('image-1', 0),
      input('video-1', 50),
      input('text-1', 100),
      input('image-2', 150),
      input('video-2', 200),
      input('text-2', 250),
      target('image-target-1'),
      target('image-target-2'),
      target('video-target-1'),
      target('video-target-2'),
      target('text-target-1'),
      target('text-target-2'),
    ],
    edges: [
      { id: 'image-edge-1', source: 'image-1', sourceHandle: 'images', target: 'image-target-1', targetHandle: 'ref2' },
      { id: 'image-edge-2', source: 'image-2', sourceHandle: 'images', target: 'image-target-2', targetHandle: 'ref1' },
      { id: 'video-edge-1', source: 'video-1', sourceHandle: 'video', target: 'video-target-1', targetHandle: 'frame2' },
      { id: 'video-edge-2', source: 'video-2', sourceHandle: 'video', target: 'video-target-2', targetHandle: 'frame1' },
      { id: 'text-edge-1', source: 'text-1', sourceHandle: 'text', target: 'text-target-1', targetHandle: 'ctx' },
      { id: 'text-edge-2', source: 'text-2', sourceHandle: 'text', target: 'text-target-2', targetHandle: 'prompt' },
    ],
  }
  const portModel = buildMacroInputPortModel!(graph.nodes, graph.edges)
  const expectedPorts = [
    ['image-1', 'images', 'image #1'],
    ['image-2', 'images', 'image #2'],
    ['video-1', 'video', 'video #1'],
    ['video-2', 'video', 'video #2'],
    ['text-1', 'text', 'text #1'],
    ['text-2', 'text', 'text #2'],
  ] as const
  expectedPorts.forEach(([nodeId, handleId, label]) => {
    assert.equal(portModel.getPort(nodeId, handleId)?.label, label)
  })
  graph.edges.forEach((edge, index) => {
    assert.equal(portModel.resolveEdgeOrdinal?.(edge), index % 2)
  })

  const resolution = resolveMacroInputs!(graph, {
    refBatches: [[
      { kind: 'image', src: '/media/image-1.png' },
      { kind: 'video', src: '/media/video-1.mp4' },
      { kind: 'text', text: 'текст 1' },
      { kind: 'image', src: '/media/image-2.png' },
      { kind: 'video', src: '/media/video-2.mp4' },
      { kind: 'text', text: 'текст 2' },
    ]],
    getAsset: () => undefined,
  })

  const expectedRefs: Record<string, GenRef> = {
    'image-edge-1': { kind: 'image', src: '/media/image-1.png' },
    'image-edge-2': { kind: 'image', src: '/media/image-2.png' },
    'video-edge-1': { kind: 'video', src: '/media/video-1.mp4' },
    'video-edge-2': { kind: 'video', src: '/media/video-2.mp4' },
    'text-edge-1': { kind: 'text', text: 'текст 1' },
    'text-edge-2': { kind: 'text', text: 'текст 2' },
  }
  Object.entries(expectedRefs).forEach(([edgeId, expected]) => {
    assert.deepEqual(resolution.runs[0].refsByEdge[edgeId], [expected])
  })
})

test('один Input разрешает смешанные image и video handles из одного снимка', () => {
  assert.equal(typeof resolveMacroInputs, 'function')
  const graph: GraphSnapshot = {
    nodes: [input('mixed-input', 0), target('target')],
    edges: [
      {
        id: 'image-edge',
        source: 'mixed-input',
        sourceHandle: 'images',
        target: 'target',
        targetHandle: 'ref1',
      },
      {
        id: 'video-edge',
        source: 'mixed-input',
        sourceHandle: 'video',
        target: 'target',
        targetHandle: 'frame1',
      },
    ],
  }

  const resolution = resolveMacroInputs!(graph, {
    refBatches: [[
      { kind: 'image', src: '/media/image.png' },
      { kind: 'video', src: '/media/video.mp4' },
    ]],
    getAsset: () => undefined,
  })

  assert.equal(resolution.runs[0].refsByEdge['image-edge'][0]?.kind, 'image')
  assert.equal(resolution.runs[0].refsByEdge['video-edge'][0]?.kind, 'video')
})

test('resolver клонирует и замораживает refs и fixed assets на старте', () => {
  assert.equal(typeof resolveMacroInputs, 'function')
  const selected: GenRef = { kind: 'image', src: '/media/original.png' }
  const fixed = {
    slot: 2,
    kind: 'text' as const,
    text: 'старый ассет',
  }
  const graph: GraphSnapshot = {
    nodes: [input('fixed-input', 0, 2), target('target')],
    edges: [
      {
        id: 'fixed-edge',
        source: 'fixed-input',
        sourceHandle: 'text',
        target: 'target',
        targetHandle: 'prompt',
      },
    ],
  }

  const resolution = resolveMacroInputs!(graph, {
    refBatches: [[selected]],
    getAsset: () => fixed,
  })
  selected.src = '/media/mutated.png'
  fixed.text = 'новый ассет'

  const run = resolution.runs[0]
  assert.deepEqual(run.refs, [
    { kind: 'image', src: '/media/original.png' },
  ])
  assert.deepEqual(run.assetsBySlot['2'], {
    kind: 'text',
    text: 'старый ассет',
  })
  assert.deepEqual(run.refsByEdge['fixed-edge'], [
    { kind: 'text', text: 'старый ассет' },
  ])
  assert.equal(Object.isFrozen(resolution.runs), true)
  assert.equal(Object.isFrozen(run), true)
  assert.equal(Object.isFrozen(run.refs), true)
  assert.equal(Object.isFrozen(run.refs[0]), true)
  assert.equal(Object.isFrozen(run.assetsBySlot), true)
})

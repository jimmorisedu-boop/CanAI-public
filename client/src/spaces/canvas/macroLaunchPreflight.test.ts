// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { startAfterMacroPreflight } from './macroLaunchPreflight.js'
import type { GraphSnapshot } from '../nodes/types.js'
import type { SelectionRef } from './konva/selection.js'
import type { PinnedAsset } from './konva/types.js'

const note = (id: string, prompt: string): GraphSnapshot['nodes'][number] => ({
  id,
  type: 'gen',
  position: { x: 0, y: 0 },
  data: { kind: 'note', prompt, status: 'idle' },
})

const output = (id: string): GraphSnapshot['nodes'][number] => ({
  id,
  type: 'gen',
  position: { x: 0, y: 0 },
  data: { kind: 'output', prompt: '', status: 'idle' },
})

const input = (
  id: string,
  assetSlot?: number,
): GraphSnapshot['nodes'][number] => ({
  id,
  type: 'gen',
  position: { x: 0, y: 0 },
  data: { kind: 'input', prompt: '', status: 'idle', assetSlot },
})

const generated = (
  id: string,
  kind: 'image' | 'video',
): GraphSnapshot['nodes'][number] => ({
  id,
  type: 'gen',
  position: { x: 0, y: 0 },
  data: { kind, prompt: 'готово', status: 'idle' },
})

function launchContext(
  refs: SelectionRef[],
  assets: PinnedAsset[] = [],
): {
  refs: SelectionRef[]
  getAsset: (slot: number) => PinnedAsset | undefined
} {
  return {
    refs,
    getAsset: (slot) => assets.find((asset) => asset.slot === slot),
  }
}

test('blocking diagnostics prevent macro effects before graph execution', () => {
  let effects = 0
  const result = startAfterMacroPreflight(
    { nodes: [note('orphan', 'готово')], edges: [] },
    launchContext([]),
    () => {
      effects++
    },
  )

  assert.equal(result.started, false)
  assert.equal(result.diagnostics.some((item) => item.severity === 'error'), true)
  assert.equal(effects, 0)
})

test('warning diagnostics do not prevent macro effects', () => {
  let effects = 0
  const result = startAfterMacroPreflight(
    {
      nodes: [note('source', 'готово'), note('orphan', 'лишняя'), output('output')],
      edges: [
        {
          id: 'to-output',
          source: 'source',
          sourceHandle: 'out',
          target: 'output',
          targetHandle: 'in-text',
        },
      ],
    },
    launchContext([]),
    () => {
      effects++
    },
  )

  assert.equal(result.started, true)
  assert.equal(result.diagnostics.some((item) => item.severity === 'warning'), true)
  assert.equal(effects, 1)
})

test('input.video rejects an image before running or any launch effect', () => {
  let effects = 0
  const graph: GraphSnapshot = {
    nodes: [input('input'), generated('video', 'video'), output('output')],
    edges: [
      {
        id: 'input-video',
        source: 'input',
        sourceHandle: 'video',
        target: 'video',
        targetHandle: 'frame1',
      },
      {
        id: 'video-output',
        source: 'video',
        sourceHandle: 'out',
        target: 'output',
        targetHandle: 'in-video',
      },
    ],
  }

  const result = startAfterMacroPreflight(
    graph,
    launchContext([
      {
        shapeId: 'image',
        kind: 'image',
        label: 'картинка',
        src: '/media/image.png',
      },
    ]),
    () => {
      effects++
    },
  )

  assert.equal(result.started, false)
  assert.match(result.message ?? '', /video/i)
  assert.equal(effects, 0)
})

test('input.images and input.text validate their exact selected types', () => {
  const graph: GraphSnapshot = {
    nodes: [input('input'), generated('image', 'image'), output('output')],
    edges: [
      {
        id: 'input-image',
        source: 'input',
        sourceHandle: 'images',
        target: 'image',
        targetHandle: 'ref1',
      },
      {
        id: 'input-text',
        source: 'input',
        sourceHandle: 'text',
        target: 'image',
        targetHandle: 'prompt',
      },
      {
        id: 'image-output',
        source: 'image',
        sourceHandle: 'out',
        target: 'output',
        targetHandle: 'in-image',
      },
    ],
  }

  const wrongTypes = startAfterMacroPreflight(
    graph,
    launchContext([
      {
        shapeId: 'video',
        kind: 'video',
        label: 'видео',
        src: '/media/video.mp4',
      },
    ]),
    () => {
      throw new Error('запуск не должен начаться')
    },
  )
  assert.equal(wrongTypes.started, false)
  assert.match(wrongTypes.message ?? '', /image/i)
  assert.match(wrongTypes.message ?? '', /text/i)

  let effects = 0
  const exactTypes = startAfterMacroPreflight(
    graph,
    launchContext([
      {
        shapeId: 'image',
        kind: 'image',
        label: 'картинка',
        src: '/media/image.png',
      },
      {
        shapeId: 'text',
        kind: 'text',
        label: 'описание',
        text: 'описание',
      },
    ]),
    () => {
      effects++
    },
  )
  assert.equal(exactTypes.started, true)
  assert.equal(effects, 1)
})

test('fixed asset slot is checked for presence and exact handle type', () => {
  const graph: GraphSnapshot = {
    nodes: [input('fixed', 0), generated('video', 'video'), output('output')],
    edges: [
      {
        id: 'fixed-video',
        source: 'fixed',
        sourceHandle: 'video',
        target: 'video',
        targetHandle: 'frame1',
      },
      {
        id: 'video-output',
        source: 'video',
        sourceHandle: 'out',
        target: 'output',
        targetHandle: 'in-video',
      },
    ],
  }

  const empty = startAfterMacroPreflight(graph, launchContext([]), () => {
    throw new Error('пустой слот не запускается')
  })
  assert.equal(empty.started, false)
  assert.match(empty.message ?? '', /Asset 1.*empty/i)

  const wrong = startAfterMacroPreflight(
    graph,
    launchContext([], [
      { slot: 0, kind: 'image', src: '/media/image.png' },
    ]),
    () => {
      throw new Error('неверный тип не запускается')
    },
  )
  assert.equal(wrong.started, false)
  assert.match(wrong.message ?? '', /Asset 1.*video/i)

  let effects = 0
  const exact = startAfterMacroPreflight(
    graph,
    launchContext([], [
      { slot: 0, kind: 'video', src: '/media/video.mp4' },
    ]),
    () => {
      effects++
    },
  )
  assert.equal(exact.started, true)
  assert.equal(effects, 1)
})

test('fixed text asset satisfies only a connected text handle', () => {
  const graph: GraphSnapshot = {
    nodes: [input('fixed-text', 2), generated('image', 'image'), output('output')],
    edges: [
      {
        id: 'fixed-prompt',
        source: 'fixed-text',
        sourceHandle: 'text',
        target: 'image',
        targetHandle: 'prompt',
      },
      {
        id: 'image-output',
        source: 'image',
        sourceHandle: 'out',
        target: 'output',
        targetHandle: 'in-image',
      },
    ],
  }
  let effects = 0
  const result = startAfterMacroPreflight(
    graph,
    launchContext([], [
      { slot: 2, kind: 'text', text: 'описание' },
    ]),
    () => {
      effects++
    },
  )

  assert.equal(result.started, true)
  assert.equal(effects, 1)
})

test('invalid context creates neither pending placeholders nor paid API work', () => {
  const graph: GraphSnapshot = {
    nodes: [input('video-input'), generated('video', 'video'), output('output')],
    edges: [
      {
        id: 'input-video',
        source: 'video-input',
        sourceHandle: 'video',
        target: 'video',
        targetHandle: 'frame1',
      },
      {
        id: 'video-output',
        source: 'video',
        sourceHandle: 'out',
        target: 'output',
        targetHandle: 'in-video',
      },
    ],
  }
  let pending = 0
  let paidApiCalls = 0

  const result = startAfterMacroPreflight(
    graph,
    launchContext([
      {
        shapeId: 'wrong-image',
        kind: 'image',
        label: 'картинка',
        src: '/media/wrong.png',
      },
    ]),
    () => {
      pending++
      paidApiCalls++
    },
  )

  assert.equal(result.started, false)
  assert.equal(pending, 0)
  assert.equal(paidApiCalls, 0)
})

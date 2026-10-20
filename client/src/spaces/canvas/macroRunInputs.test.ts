// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { planMacroSeedBatches } from './macroRunInputs.js'
import type { GraphSnapshot } from '../nodes/types.js'
import type { SelectionRef } from './konva/selection.js'

const input: GraphSnapshot['nodes'][number] = {
  id: 'input',
  type: 'gen',
  position: { x: 0, y: 0 },
  data: { kind: 'input', prompt: '', status: 'idle' },
}
const target: GraphSnapshot['nodes'][number] = {
  id: 'target',
  type: 'gen',
  position: { x: 0, y: 0 },
  data: { kind: 'video', prompt: 'тест', status: 'idle' },
}
const refs: SelectionRef[] = [
  { shapeId: 'image', kind: 'image', label: 'картинка', src: '/media/image.png' },
  { shapeId: 'video', kind: 'video', label: 'видео', src: '/media/video.mp4' },
  { shapeId: 'text', kind: 'text', label: 'текст', text: 'описание' },
]

function graph(handles: Array<'images' | 'video' | 'text'>): GraphSnapshot {
  return {
    nodes: [input, target],
    edges: handles.map((handle) => ({
      id: handle,
      source: 'input',
      sourceHandle: handle,
      target: 'target',
      targetHandle:
        handle === 'text' ? 'prompt' : handle === 'video' ? 'frame1' : 'frame1',
    })),
  }
}

test('single typed media handle batches only compatible selected objects', () => {
  assert.deepEqual(
    planMacroSeedBatches(graph(['images']), refs).batches.map((batch) =>
      batch.map((ref) => ref.kind),
    ),
    [['image', 'text']],
  )
  assert.deepEqual(
    planMacroSeedBatches(graph(['video']), refs).batches.map((batch) =>
      batch.map((ref) => ref.kind),
    ),
    [['video', 'text']],
  )
})

test('image and video handles run together while text-only input ignores media', () => {
  assert.deepEqual(
    planMacroSeedBatches(graph(['images', 'video']), refs).batches.map((batch) =>
      batch.map((ref) => ref.kind),
    ),
    [['image', 'video', 'text']],
  )
  assert.deepEqual(
    planMacroSeedBatches(graph(['text']), refs).batches.map((batch) =>
      batch.map((ref) => ref.kind),
    ),
    [['text']],
  )
})

test('multiple images get mapped to separate batches when only a single images input is connected', () => {
  const multipleRefs: SelectionRef[] = [
    { shapeId: 'image1', kind: 'image', label: 'фото 1', src: '/media/1.png' },
    { shapeId: 'image2', kind: 'image', label: 'фото 2', src: '/media/2.png' },
    { shapeId: 'text', kind: 'text', label: 'текст', text: 'описание' },
  ]
  const plan = planMacroSeedBatches(graph(['images']), multipleRefs)
  assert.equal(plan.isMultiInput, false)
  assert.deepEqual(
    plan.batches.map((batch) => batch.map((ref) => ref.shapeId)),
    [
      ['image1', 'text'],
      ['image2', 'text'],
    ],
  )
})

// @ts-expect-error Тест запускается серверным tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается серверным tsx с Node-типами.
import test from 'node:test'
import { CATALOG } from '../../../../server/src/catalog.js'
import { nodeInputPorts, nodeOutputPorts } from './nodePortContracts.js'

const models = CATALOG.map((model) => ({
  ...model,
  refs: Boolean(model.refs),
  params: model.params ?? [],
  promptRequired: model.promptInputField !== null,
}))

test('Qwen показывает отдельные входы картинки и видео, но не аудио', () => {
  assert.deepEqual(
    nodeInputPorts({ models, kind: 'text', modelId: 'qwen', connectedHandles: [] })
      .map(({ id, type }) => ({ id, type })),
    [
      { id: 'ctx', type: 'text' },
      { id: 'ref1', type: 'image' },
      { id: 'video1', type: 'video' },
    ],
  )
})
test('Gemini добавляет следующий свободный video-порт и отдельный audio-порт', () => {
  assert.deepEqual(
    nodeInputPorts({
      models,
      kind: 'text',
      modelId: 'gemini',
      connectedHandles: ['video1'],
    }).map(({ id, type }) => ({ id, type })),
    [
      { id: 'ctx', type: 'text' },
      { id: 'ref1', type: 'image' },
      { id: 'video1', type: 'video' },
      { id: 'video2', type: 'video' },
      { id: 'audio1', type: 'audio' },
    ],
  )
})

test('видео-нода показывает возможности всех парных endpoint выбранной базы', () => {
  assert.deepEqual(
    nodeInputPorts({
      models,
      kind: 'video',
      modelId: 'seedance-2',
      connectedHandles: [],
    }).map(({ id, type }) => ({ id, type })),
    [
      { id: 'prompt', type: 'text' },
      { id: 'frame1', type: 'image' },
      { id: 'video1', type: 'video' },
      { id: 'audio1', type: 'audio' },
    ],
  )
})

test('SeedVR Seamless показывает единственный image-вход и оба реальных выхода', () => {
  assert.deepEqual(
    nodeInputPorts({
      models,
      kind: 'other',
      modelId: 'seedvr-seamless-upscale',
      connectedHandles: [],
    }),
    [{ id: 'image_url', type: 'image', label: 'image' }],
  )
  assert.deepEqual(
    nodeOutputPorts({ models, kind: 'other', modelId: 'seedvr-seamless-upscale' }),
    [
      { id: 'out', type: 'image', label: 'image' },
      { id: 'seed', type: 'text', label: 'seed' },
    ],
  )
})

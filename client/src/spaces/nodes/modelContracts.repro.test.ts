// @ts-expect-error Тест запускается серверным tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается серверным tsx с Node-типами.
import test from 'node:test'
import { CATALOG } from '../../../../server/src/catalog.js'
import { api } from '../../api.js'
import * as nodeModel from './nodeModel.js'
import * as ports from './ports.js'
import type { CanaiEdge, CanaiNode, NodeKind } from './types.js'
import './nodePortContracts.test.js'

function makeNode(id: string, kind: NodeKind, prompt = ''): CanaiNode {
  return {
    id,
    type: 'gen',
    position: { x: 0, y: 0 },
    data: { kind, prompt, status: 'idle' },
  }
}

function model(id: string) {
  const found = CATALOG.find((item) => item.id === id)
  assert.ok(found, `в каталоге нет модели ${id}`)
  return found
}

// Случаи, проверявшие сам обход графа, переехали в server/src/macroEngine.test.ts
// вместе с движком: он теперь исполняется на сервере, и проверять его в
// браузере стало нечем.

test('Nano Banana 2 заменяет обычную Nano Banana без смены внутренних id', () => {
  const nano = model('nano-banana')
  const nanoEdit = model('nano-banana-edit')
  const nanoPro = model('nano-banana-pro')
  const nanoAspect = nano.params?.find((param) => param.name === 'aspect_ratio')
  const editAspect = nanoEdit.params?.find((param) => param.name === 'aspect_ratio')
  const nanoResolution = nano.params?.find((param) => param.name === 'resolution')
  const editResolution = nanoEdit.params?.find((param) => param.name === 'resolution')

  assert.equal(nano.name, 'Nano Banana 2')
  assert.equal(nano.endpoint, 'fal-ai/nano-banana-2')
  assert.equal(nano.pairId, 'nano-banana-edit')
  assert.equal(nanoEdit.name, 'Nano Banana 2 — by reference')
  assert.equal(nanoEdit.endpoint, 'fal-ai/nano-banana-2/edit')
  assert.equal(nanoEdit.maxImageRefs, 14)
  assert.equal(nanoAspect?.default, '1:1')
  assert.equal(editAspect?.default, 'auto')
  assert.deepEqual(
    nanoAspect?.options?.map((option) => option.value),
    [
      'auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5',
      '3:4', '2:3', '9:16', '4:1', '1:4', '8:1', '1:8',
    ],
  )
  assert.deepEqual(
    nanoResolution?.options?.map((option) => option.value),
    ['0.5K', '1K', '2K', '4K'],
  )
  assert.equal(nanoResolution?.default, '1K')
  assert.deepEqual(editResolution, nanoResolution)
  assert.equal(nano.pricing?.usd, 0.08)
  assert.deepEqual(nano.pricing?.byParam, {
    name: 'resolution',
    usd: { '0.5K': 0.06, '1K': 0.08, '2K': 0.12, '4K': 0.16 },
  })
  assert.equal(nanoEdit.pricing?.usd, 0.08)
  assert.equal(nanoPro.endpoint, 'fal-ai/nano-banana-pro')
})

test('параметры Seedance 2.0 не меняют типы и дефолты fal API', () => {
  const seedance = model('seedance-2')
  const seedanceI2v = model('seedance-2-i2v')
  const resolution = seedance.params?.find((param) => param.name === 'resolution')
  const i2vResolution = seedanceI2v.params?.find((param) => param.name === 'resolution')
  const duration = seedance.params?.find((param) => param.name === 'duration')
  const bitrate = seedance.params?.find((param) => param.name === 'bitrate_mode')

  assert.equal(resolution?.default, '720p')
  assert.deepEqual(
    resolution?.options?.map((option) => option.value),
    ['480p', '720p', '1080p', '4k'],
  )
  assert.deepEqual(
    i2vResolution?.options?.map((option) => option.value),
    ['480p', '720p', '1080p', '4k'],
  )
  assert.equal(duration?.widget, 'select')
  assert.equal(duration?.default, 'auto')
  assert.deepEqual(
    duration?.options?.map((option) => option.value),
    ['auto', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
  )
  assert.equal(bitrate?.default, 'standard')
  assert.deepEqual(
    bitrate?.options?.map((option) => option.value),
    ['standard', 'high'],
  )
})

test('GPT Image 2 и Seedream показывают единые пропорции и разрешение, а сервер адаптирует API', () => {
  for (const id of ['chatgpt-image-2', 'chatgpt-image-2-edit']) {
    const current = model(id)
    assert.ok(current.params?.some((param) => param.name === 'aspect_ratio'), `${id}: нет aspect_ratio`)
    assert.equal(current.params?.some((param) => param.name === 'image_size'), false)
    assert.ok(current.params?.some((param) => param.name === 'resolution'), `${id}: нет resolution`)
  }
  for (const id of ['seedream-5-pro', 'seedream-5-pro-edit']) {
    const current = model(id)
    assert.ok(current.params?.some((param) => param.name === 'aspect_ratio'), `${id}: нет aspect_ratio`)
    assert.ok(current.params?.some((param) => param.name === 'resolution'), `${id}: нет resolution`)
    assert.equal(current.params?.some((param) => param.name === 'image_size'), false)
  }
  assert.equal(
    model('chatgpt-image-2').params?.find((param) => param.name === 'aspect_ratio')?.default,
    '4:3',
  )
  assert.equal(
    model('chatgpt-image-2-edit').params?.find((param) => param.name === 'aspect_ratio')?.default,
    'auto',
  )
  assert.equal(
    model('seedream-5-pro').params?.find((param) => param.name === 'resolution')?.default,
    '2K',
  )
  assert.equal(
    model('chatgpt-image-2').pricing?.byParams?.usd['1:1|1K|high'],
    0.21072,
  )
  assert.equal(
    model('chatgpt-image-2-edit').pricing?.byParams?.usd['1:1|1K|high'],
    0.22372,
  )
  assert.equal(
    model('chatgpt-image-2-edit').pricing?.byParams?.usd['auto|auto|high'],
    0.29458,
  )
  assert.equal(
    model('chatgpt-image-2-edit').pricing?.additionalReferenceUsd,
    0.013,
  )
})

test('дефолты Grok, Seedance и Gemini совпадают с текущими fal-схемами', () => {
  const grokImage = model('grok-image')
  const grokImageAspect = grokImage.params?.find((param) => param.name === 'aspect_ratio')
  const grokImageResolution = grokImage.params?.find((param) => param.name === 'resolution')
  assert.equal(grokImageAspect?.default, '1:1')
  assert.equal(grokImageAspect?.options?.some((option) => option.value === 'auto'), false)
  assert.deepEqual(grokImageResolution?.options?.map((option) => option.value), ['1k', '2k'])

  const grokVideoAspect = model('grok').params?.find((param) => param.name === 'aspect_ratio')
  assert.equal(grokVideoAspect?.default, '16:9')
  assert.equal(grokVideoAspect?.options?.some((option) => option.value === 'auto'), false)

  const grokI2vAspect = model('grok-i2v').params?.find((param) => param.name === 'aspect_ratio')
  assert.equal(grokI2vAspect?.default, 'auto')
  assert.deepEqual(grokI2vAspect?.options?.map((option) => option.value), [
    'auto',
    '16:9',
    '4:3',
    '3:2',
    '1:1',
    '2:3',
    '3:4',
    '9:16',
  ])

  const seedanceAspect = model('seedance-2').params?.find((param) => param.name === 'aspect_ratio')
  assert.equal(seedanceAspect?.default, 'auto')

  const geminiAspect = model('veo-omni').params?.find((param) => param.name === 'aspect_ratio')
  assert.equal(geminiAspect?.default, '16:9')
  assert.deepEqual(geminiAspect?.options?.map((option) => option.value), ['16:9', '9:16'])

  assert.equal(model('sam-image').name, 'SAM 3')
})

test('каталог хранит реальные лимиты референсов, чтобы ноды не угадывали их по id', () => {
  type RefLimits = {
    maxImageRefs?: number
    maxVideoRefs?: number
    maxAudioRefs?: number
    maxTotalRefs?: number
  }

  const gptImage = model('chatgpt-image-2-edit') as typeof CATALOG[number] & RefLimits
  assert.equal(gptImage.maxImageRefs, 16)

  const nanoPro = model('nano-banana-pro-edit') as typeof CATALOG[number] & RefLimits
  assert.equal(nanoPro.maxImageRefs, 14)

  const seedream = model('seedream-5-pro-edit') as typeof CATALOG[number] & RefLimits
  assert.equal(seedream.maxImageRefs, 10)

  const grokImage = model('grok-image-edit') as typeof CATALOG[number] & RefLimits
  assert.equal(grokImage.maxImageRefs, 3)
  assert.equal(grokImage.maxTotalRefs, 3)

  const seedanceI2v = model('seedance-2-i2v') as typeof CATALOG[number] & RefLimits
  assert.equal(seedanceI2v.maxImageRefs, 2)

  const seedanceRefs = model('seedance-2-refs') as typeof CATALOG[number] & RefLimits
  assert.equal(seedanceRefs.maxImageRefs, 9)
  assert.equal(seedanceRefs.maxVideoRefs, 3)
  assert.equal(seedanceRefs.maxAudioRefs, 3)
  assert.equal(seedanceRefs.maxTotalRefs, 12)

  const grokI2v = model('grok-i2v') as typeof CATALOG[number] & RefLimits
  assert.equal(grokI2v.maxImageRefs, 1)
  assert.equal(grokI2v.maxTotalRefs, 1)

  const grokVideoEdit = model('grok-video-edit') as typeof CATALOG[number] & RefLimits
  assert.equal(grokVideoEdit.maxVideoRefs, 1)
  assert.equal(grokVideoEdit.maxTotalRefs, 1)

  const geminiVideoEdit = model('veo-omni-video-edit') as typeof CATALOG[number] & RefLimits
  assert.equal(geminiVideoEdit.maxVideoRefs, 1)
  assert.equal(geminiVideoEdit.maxTotalRefs, 1)

  const sam = model('sam-image') as typeof CATALOG[number] & RefLimits
  assert.equal(sam.maxImageRefs, 1)
  assert.equal(sam.maxTotalRefs, 1)
})

test('клиент разрешает генерацию только с ключом fal.ai или в явном demo-режиме', async () => {
  const module = await import('../canvas/generationAvailability.js').catch(() => null)
  assert.ok(module, 'нужен единый клиентский контракт доступности генерации')

  assert.equal(module.canGenerate(null), false)
  assert.equal(module.canGenerate({ falConfigured: false, mockMode: false }), false)
  assert.equal(module.canGenerate({ falConfigured: true, mockMode: false }), true)
  assert.equal(module.canGenerate({ falConfigured: false, mockMode: true }), true)
  assert.equal(
    module.canStartGeneration?.({ falConfigured: true, mockMode: false }, false),
    false,
  )
  assert.equal(
    module.canStartGeneration?.({ falConfigured: true, mockMode: false }, true),
    true,
  )
})

test('нода файла показывает только выход, соответствующий загруженному MIME', () => {
  const visibleOutputs = (
    ports as typeof ports & {
      visibleOutputs?: (
        kind: NodeKind,
        result?: { mime?: string },
      ) => Array<{ id: string }>
    }
  ).visibleOutputs
  assert.equal(typeof visibleOutputs, 'function')

  assert.deepEqual(
    visibleOutputs?.('media', { mime: 'image/png' }).map((port) => port.id),
    ['image'],
  )
  assert.deepEqual(
    visibleOutputs?.('media', { mime: 'video/mp4' }).map((port) => port.id),
    ['video'],
  )
  assert.deepEqual(
    visibleOutputs?.('media', { mime: 'audio/mpeg' }).map((port) => port.id),
    ['audio'],
  )
  assert.deepEqual(
    visibleOutputs?.('media').map((port) => port.id),
    ['image', 'video', 'audio'],
  )
})

test('ёмкость входов ноды берётся из эффективной и парных моделей', () => {
  const referenceCapacity = (
    nodeModel as typeof nodeModel & {
      referenceCapacity?: (
        models: typeof CATALOG,
        kind: NodeKind,
        modelId?: string,
      ) => number
    }
  ).referenceCapacity
  assert.equal(typeof referenceCapacity, 'function')

  assert.equal(referenceCapacity?.(CATALOG, 'image', 'chatgpt-image-2'), 16)
  assert.equal(referenceCapacity?.(CATALOG, 'image', 'grok-image'), 3)
  assert.equal(referenceCapacity?.(CATALOG, 'video', 'seedance-2'), 12)
  assert.equal(referenceCapacity?.(CATALOG, 'video', 'seedance-2-i2v'), 2)
  assert.equal(ports.portType('video', 'inputs', 'frame2', false, true), 'media')
})

test('нодовый редактор не разрешает собрать набор референсов, который отвергнет fal', () => {
  const referenceLimitError = (
    nodeModel as typeof nodeModel & {
      referenceLimitError?: (
        models: typeof CATALOG,
        kind: NodeKind,
        modelId: string | undefined,
        counts: { image: number; video: number; audio: number },
      ) => string | null
    }
  ).referenceLimitError
  assert.equal(typeof referenceLimitError, 'function')

  assert.equal(
    referenceLimitError?.(CATALOG, 'video', 'seedance-2', {
      image: 2,
      video: 0,
      audio: 0,
    }),
    null,
  )
  assert.match(
    referenceLimitError?.(CATALOG, 'video', 'seedance-2', {
      image: 3,
      video: 0,
      audio: 0,
    }) ?? '',
    /images.*2/i,
  )
  assert.equal(
    referenceLimitError?.(CATALOG, 'video', 'seedance-2', {
      image: 7,
      video: 2,
      audio: 3,
    }),
    null,
  )
  assert.match(
    referenceLimitError?.(CATALOG, 'video', 'seedance-2', {
      image: 7,
      video: 3,
      audio: 3,
    }) ?? '',
    /no more than 12/i,
  )
  assert.match(
    referenceLimitError?.(CATALOG, 'video', 'veo-omni', {
      image: 0,
      video: 2,
      audio: 0,
    }) ?? '',
    /video.*1/i,
  )
  assert.match(
    referenceLimitError?.(CATALOG, 'video', 'veo-omni', {
      image: 1,
      video: 1,
      audio: 0,
    }) ?? '',
    /images.*does not accept/i,
  )
  assert.match(
    referenceLimitError?.(CATALOG, 'video', 'seedance-2', {
      image: 0,
      video: 0,
      audio: 1,
    }) ?? '',
    /image.*video/i,
  )
})

test('аудиовход макроса переключает Seedance на мультимодальную ref-модель', () => {
  const input = makeNode('input', 'input')
  const video = makeNode('video', 'video')
  video.data.model = 'seedance-2'
  const edge: CanaiEdge = {
    id: 'audio-edge',
    source: 'input',
    sourceHandle: 'audio',
    target: 'video',
    targetHandle: 'frame1',
  }

  const refs = nodeModel.inspectNodeMediaRefs('video', [edge], [input, video])
  assert.deepEqual(refs, { hasImage: false, hasVideo: false, hasAudio: true, imageCount: 0 })
  assert.equal(
    nodeModel.resolveNodeModel(
      CATALOG,
      'video',
      'seedance-2',
      refs.hasImage,
      refs.hasVideo,
      refs.hasAudio,
    )?.id,
    'seedance-2-refs',
  )
})

test('загрузка распознаёт распространённые аудиофайлы даже без MIME от Windows', async () => {
  const apiModule = await import('../../api.js') as typeof import('../../api.js') & {
    uploadMimeFromName?: (name: string) => string
  }
  assert.equal(typeof apiModule.uploadMimeFromName, 'function')
  assert.equal(apiModule.uploadMimeFromName?.('music.MP3'), 'audio/mpeg')
  assert.equal(apiModule.uploadMimeFromName?.('voice.wav'), 'audio/wav')
  assert.equal(apiModule.uploadMimeFromName?.('voice.m4a'), '')
  assert.equal(apiModule.uploadMimeFromName?.('master.flac'), '')
  assert.equal(apiModule.uploadMimeFromName?.('clip.ogv'), 'video/ogg')
  assert.equal(apiModule.uploadMimeFromName?.('sound.ogg'), '')
})

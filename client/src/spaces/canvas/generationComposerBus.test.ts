import assert from 'node:assert/strict'
import test from 'node:test'
import {
  registerGenerationComposer,
  requestGenerationComposerFill,
  requestGenerationComposerGenerate,
} from './generationComposerBus'

const request = {
  prompt: 'cinematic portrait',
  refs: [{
    shapeId: 'shape-1',
    kind: 'image' as const,
    label: 'Референс',
    src: '/media/ref.png',
  }],
}

test('returns false when the prompt composer is not mounted', async () => {
  registerGenerationComposer(null)
  assert.equal(requestGenerationComposerFill(request), false)
  assert.equal(await requestGenerationComposerGenerate(request), false)
})

test('delivers fill and generate only to the current composer', async () => {
  const calls: string[] = []
  const first = {
    fill: () => calls.push('first-fill'),
    generate: async () => {
      calls.push('first-generate')
    },
  }
  const second = {
    fill: () => calls.push('second-fill'),
    generate: async () => {
      calls.push('second-generate')
    },
  }

  const unregisterFirst = registerGenerationComposer(first)
  assert.equal(requestGenerationComposerFill(request), true)
  await requestGenerationComposerGenerate(request)

  registerGenerationComposer(second)
  unregisterFirst()
  assert.equal(requestGenerationComposerFill(request), true)
  await requestGenerationComposerGenerate(request)

  assert.deepEqual(calls, [
    'first-fill',
    'first-generate',
    'second-fill',
    'second-generate',
  ])

  registerGenerationComposer(null)
})

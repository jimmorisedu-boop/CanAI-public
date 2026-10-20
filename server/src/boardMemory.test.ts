import assert from 'node:assert/strict'
import test from 'node:test'
import { extractBoardMemory, formatBoardMemoryForContext } from './boardMemory.js'

test('extractBoardMemory: handles empty board gracefully', () => {
  const memory = extractBoardMemory([])
  assert.equal(memory.totalItems, 0)
  assert.equal(memory.imageCount, 0)
  assert.equal(memory.preferredImageModel, undefined)
  const formatted = formatBoardMemoryForContext(memory)
  assert.match(formatted, /The canvas is empty/u)
})

test('extractBoardMemory: accurately detects preferred GPT Image model and recent prompts', () => {
  const dummyItems = [
    {
      id: 'item-1',
      kind: 'image',
      modelId: 'gpt-image-2',
      prompt: 'Девушка в белой футболке на заднем сиденье автомобиля',
      w: 768,
      h: 1024,
      sourceLaunch: { modelName: 'GPT Image 2', modelId: 'gpt-image-2' },
    },
    {
      id: 'item-2',
      kind: 'image',
      modelId: 'gpt-image-2',
      prompt: 'Девушка в свитере на набережной у моста',
      w: 768,
      h: 1024,
      sourceLaunch: { modelName: 'GPT Image 2', modelId: 'gpt-image-2' },
    },
    {
      id: 'item-3',
      kind: 'image',
      modelId: 'gpt-image-2',
      prompt: 'Портрет девушки крупным планом, закатный свет',
      w: 768,
      h: 1024,
      sourceLaunch: { modelName: 'GPT Image 2', modelId: 'gpt-image-2' },
    },
    {
      id: 'item-4',
      kind: 'image',
      modelId: 'nano-banana',
      prompt: 'Быстрый набросок концепта',
      w: 1024,
      h: 1024,
      sourceLaunch: { modelName: 'Nano Banana', modelId: 'nano-banana' },
    },
    {
      id: 'item-5',
      kind: 'text',
      text: 'Серия кадров для осеннего лукбука',
      w: 300,
      h: 100,
    },
  ]

  const memory = extractBoardMemory(dummyItems)
  assert.equal(memory.totalItems, 5)
  assert.equal(memory.imageCount, 4)
  assert.equal(memory.textCount, 1)

  assert.ok(memory.preferredImageModel)
  assert.equal(memory.preferredImageModel.modelId, 'gpt-image-2')
  assert.equal(memory.preferredImageModel.count, 3)
  assert.equal(memory.preferredImageModel.percentage, 75)

  assert.equal(memory.recentPrompts.length, 4)
  assert.equal(memory.textNotes.length, 1)
  assert.match(memory.textNotes[0], /Серия кадров для осеннего лукбука/)

  const formatted = formatBoardMemoryForContext(memory)
  assert.match(formatted, /main image model: GPT Image 2/u)
  assert.match(formatted, /MODEL DETAILS \(GPT Image\)/u)
  assert.match(formatted, /Recent canvas topics and prompts/u)
  assert.match(formatted, /Девушка в белой футболке/u)
  assert.match(formatted, /Серия кадров для осеннего лукбука/u)
})

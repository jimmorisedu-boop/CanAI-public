import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLocalCanvasActionSystemPrompt,
  parseCanvasActionPreparationResponse,
  validateCanvasActionRefs,
} from './canvasActionPreparation.js'

const image = { kind: 'image' as const, src: '/media/source.png', width: 640, height: 480 }

test('canvas action refs are image-only and bounded', () => {
  assert.equal(validateCanvasActionRefs([]), null)
  assert.equal(validateCanvasActionRefs([image]), null)
  assert.equal(validateCanvasActionRefs([
    { kind: 'text', text: 'не картинка' },
  ]), 'Make mode accepts images only')
  assert.match(
    validateCanvasActionRefs(Array.from({ length: 17 }, () => image)) ?? '',
    /at most 16 images/u,
  )
})

test('preparation accepts only a plain prompt from malformed/provider-shaped output', () => {
  assert.deepEqual(
    parseCanvasActionPreparationResponse('{"prompt":"замени мужчин на девушек","model":"fal","tools":[]}'),
    { prompt: 'замени мужчин на девушек' },
  )
  assert.deepEqual(
    parseCanvasActionPreparationResponse('```json\n{"prompt":"замени мужчин на девушек"}\n```'),
    { prompt: 'замени мужчин на девушек' },
  )
  assert.deepEqual(
    parseCanvasActionPreparationResponse('Вот ваш промпт:\n```\n{"prompt":"замени мужчин на девушек"}\n```\nУдачи!'),
    { prompt: 'замени мужчин на девушек' },
  )
  assert.deepEqual(
    parseCanvasActionPreparationResponse('Конечно! {"prompt":"замени мужчин на девушек"} Надеюсь, помог.'),
    { prompt: 'замени мужчин на девушек' },
  )
  for (const raw of [
    '',
    'not json',
    'просто текст без объекта',
    '{"model":"fal"}',
    '{"prompt":""}',
    '[]',
  ]) {
    assert.throws(() => parseCanvasActionPreparationResponse(raw), /Preparation LLM/u)
  }
})

test('selected local guidance is included in the frozen text contract', () => {
  const local = buildLocalCanvasActionSystemPrompt('DOC: лица в естественном свете')
  assert.match(local, /DOC: лица в естественном свете/u)
  assert.match(local, /style guidance only/u)
})


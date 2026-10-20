import assert from 'node:assert/strict'
import test from 'node:test'
import { CATALOG } from '../../../../packages/model-catalog/catalog.js'
import type { CatalogModel } from '../../types'
import type { GraphSnapshot } from '../nodes/types'
import { estimateGenerationCost } from './generationEstimate'
import { estimateMacroCost, macroCostContext } from './macroEstimate'

// Сторож цен по прайсу fal (страницы моделей, сверено 20.10.2026). Цена на
// кнопке и в подтверждении макроса обязана следовать за тем, за что fal
// реально берёт деньги: секунды, знаки, мегапиксели результата.
// Правило проекта: занизить хуже, чем завысить.

const models = CATALOG as unknown as CatalogModel[]
const byId = (id: string): CatalogModel => {
  const found = models.find((model) => model.id === id)
  assert.ok(found, `в каталоге нет ${id}`)
  return found
}

test('звуковые эффекты ElevenLabs стоят $0.002 за секунду длительности', () => {
  const sfx = byId('eleven-sfx')
  // по умолчанию слайдер стоит на 4 с — столько и уйдёт в fal
  assert.equal(estimateGenerationCost(sfx, {}, 1), 0.008)
  assert.equal(estimateGenerationCost(sfx, { duration_seconds: 10 }, 1), 0.02)
  // самый длинный эффект — 22 с
  assert.equal(estimateGenerationCost(sfx, { duration_seconds: 22 }, 1), 0.044)
})

test('озвучка ElevenLabs стоит $0.05 за каждые 1000 знаков текста', () => {
  const tts = byId('eleven-tts')
  assert.equal(estimateGenerationCost(tts, {}, 1, 0, { promptChars: 120 }), 0.05)
  assert.equal(estimateGenerationCost(tts, {}, 1, 0, { promptChars: 1000 }), 0.05)
  assert.equal(estimateGenerationCost(tts, {}, 1, 0, { promptChars: 1001 }), 0.1)
  assert.equal(estimateGenerationCost(tts, {}, 1, 0, { promptChars: 2500 }), 0.15)
  // Длину текста заранее не узнать — цены нет, а не «как за короткую фразу».
  assert.equal(estimateGenerationCost(tts, {}, 1), null)
})

test('апскейл SeedVR стоит $0.0025 за мегапиксель РЕЗУЛЬТАТА, в том числе в режиме «×N»', () => {
  const seedvr = byId('seedvr-seamless-upscale')
  // режим по умолчанию — «×2»: результат вчетверо больше входа по площади
  assert.equal(estimateGenerationCost(seedvr, {}, 1, 1, { inputImage: { width: 4096, height: 4096 } }), 0.167772)
  assert.equal(estimateGenerationCost(seedvr, {}, 1, 1, { inputImage: { width: 1024, height: 1024 } }), 0.010486)
  assert.equal(
    estimateGenerationCost(seedvr, { upscale_factor: 4 }, 1, 1, { inputImage: { width: 1000, height: 500 } }),
    0.02,
  )
  // «до разрешения»: короткая сторона становится целевой, пропорции — от входа
  const target = (target_resolution: string, width: number, height: number) => estimateGenerationCost(
    seedvr, { upscale_mode: 'target', target_resolution }, 1, 1, { inputImage: { width, height } },
  )
  assert.equal(target('1080p', 3840, 2160), 0.005184)
  assert.equal(target('2160p', 1000, 1000), 0.011664)
  assert.equal(target('1080p', 1080, 2520), 0.006804)
  // размер входа неизвестен — цену не выдумываем
  assert.equal(estimateGenerationCost(seedvr, {}, 1, 1), null)
  assert.equal(estimateGenerationCost(seedvr, { upscale_mode: 'target' }, 1, 1), null)
})

function node(id: string, data: Record<string, unknown>) {
  return { id, type: 'gen', position: { x: 0, y: 0 }, data: { prompt: '', status: 'idle', ...data } }
}
function edge(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return { id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle }
}

test('подтверждение макроса считает звуковые ноды, а не держит их бесплатными', () => {
  const graph = {
    nodes: [
      node('sfx', { kind: 'audio', model: 'eleven-sfx', prompt: 'гром', params: { duration_seconds: 22 } }),
      node('tts', { kind: 'audio', model: 'eleven-tts', prompt: 'а'.repeat(1500) }),
    ],
    edges: [],
  } as unknown as GraphSnapshot
  // Граф без «Входа»: корни получают выделение доски — здесь оно без текста.
  assert.deepEqual(
    estimateMacroCost(graph, models, 1, { selectionTextChars: 0 }),
    { perRun: 0.144, total: 0.144, unknownCount: 0 },
  )
})

test('озвучка с текстом от другой ноды — цена неизвестна, макрос спросит подтверждение', () => {
  const graph = {
    nodes: [
      node('llm', { kind: 'text', model: 'gemini', prompt: 'напиши речь' }),
      node('tts', { kind: 'audio', model: 'eleven-tts', prompt: 'Прочитай:' }),
    ],
    edges: [edge('llm', 'out', 'tts', 'prompt')],
  } as unknown as GraphSnapshot
  const estimate = estimateMacroCost(graph, models, 1)
  assert.equal(estimate.unknownCount, 1)
})

test('текст постоянной ноды в озвучке считается знаками вместе с промптом', () => {
  const graph = {
    nodes: [
      node('note', { kind: 'note', prompt: 'б'.repeat(990) }),
      node('tts', { kind: 'audio', model: 'eleven-tts', prompt: 'в'.repeat(20) }),
    ],
    // 990 + 20 знаков и разделитель «\n\n» (buildPrompt сервера) — уже вторая тысяча
    edges: [edge('note', 'out', 'tts', 'prompt')],
  } as unknown as GraphSnapshot
  assert.deepEqual(estimateMacroCost(graph, models, 1), { perRun: 0.1, total: 0.1, unknownCount: 0 })
})

test('апскейл в макросе берёт размер выделенной картинки', () => {
  const graph = {
    nodes: [
      node('in', { kind: 'input' }),
      node('up', { kind: 'other', model: 'seedvr-seamless-upscale' }),
    ],
    edges: [edge('in', 'images', 'up', 'image_url')],
  } as unknown as GraphSnapshot
  // ×2 по умолчанию: 2048×2048 → 4096×4096 = 16.78 Мп
  assert.deepEqual(
    estimateMacroCost(graph, models, 2, { inputImage: { width: 2048, height: 2048 } }),
    { perRun: 0.041943, total: 0.083886, unknownCount: 0 },
  )
  // без размера — неизвестно, а не прежние $0.005
  assert.equal(estimateMacroCost(graph, models, 1).unknownCount, 1)
})

test('озвучка в макросе считает и выделенный на доске текст, пришедший через «Вход»', () => {
  const graph = {
    nodes: [
      node('in', { kind: 'input' }),
      node('tts', { kind: 'audio', model: 'eleven-tts', prompt: '' }),
    ],
    edges: [edge('in', 'text', 'tts', 'prompt')],
  } as unknown as GraphSnapshot
  assert.deepEqual(
    estimateMacroCost(graph, models, 1, { selectionTextChars: 2400 }),
    { perRun: 0.15, total: 0.15, unknownCount: 0 },
  )
  // что выделено, не знаем — цену не выдумываем
  assert.equal(estimateMacroCost(graph, models, 1).unknownCount, 1)
})

test('контекст цены макроса: самая крупная выделенная картинка и все тексты, как их склеит движок', () => {
  assert.deepEqual(
    macroCostContext([
      { kind: 'image', w: 1024, h: 1024 },
      { kind: 'image', w: 4096, h: 2048 },
      { kind: 'video', w: 8000, h: 8000 },
      { kind: 'text', text: '  привет  ' },
      { kind: 'text', text: 'мир' },
    ]),
    { inputImage: { width: 4096, height: 2048 }, selectionTextChars: 6 + 3 + 2 },
  )
  assert.deepEqual(macroCostContext([]), { selectionTextChars: 0 })
})

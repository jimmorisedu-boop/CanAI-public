import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogModel } from '../../types'
import type { CanvasItem } from './konva/types'
import { extractBoardMemory, resolveModelForAssistantGeneration } from './boardMemory'

const mockCatalog: CatalogModel[] = [
  { id: 'gpt-image-2', name: 'GPT Image 2', kind: 'image', params: [] },
  { id: 'nano-banana-2', name: 'Nano Banana 2', kind: 'image', params: [] },
  { id: 'flux-pro', name: 'Flux Pro', kind: 'image', params: [] },
  { id: 'kling-video', name: 'Kling Video', kind: 'video', params: [] },
]

test('extractBoardMemory: detects GPT Image 2 as dominant preferred model from items', () => {
  const items: CanvasItem[] = [
    { id: '1', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2', prompt: 'девушка в машине' },
    { id: '2', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2', prompt: 'девушка на улице' },
    { id: '3', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'nano-banana-2', prompt: 'концепт' },
  ]
  const memory = extractBoardMemory(items)
  assert.equal(memory.totalItems, 3)
  assert.equal(memory.preferredImageModel?.modelId, 'gpt-image-2')
  assert.equal(memory.preferredImageModel?.count, 2)
})

test('resolveModelForAssistantGeneration: selects preferred board model if no specific model named', () => {
  const items: CanvasItem[] = [
    { id: '1', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2', prompt: 'девушка в машине' },
    { id: '2', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2', prompt: 'девушка на улице' },
  ]
  const model = resolveModelForAssistantGeneration(items, mockCatalog, 'image')
  assert.equal(model?.id, 'gpt-image-2')
})

test('resolveModelForAssistantGeneration: «банан на столе» НЕ переключает модель на банановую', () => {
  // Доска предпочитает GPT Image 2; слово «банан» в запросе (просто сцена на столе)
  // не должно уводить генерацию на Nano Banana — модель выбирается только из памяти доски.
  const items: CanvasItem[] = [
    { id: '1', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2', prompt: 'девушка в машине' },
    { id: '2', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2', prompt: 'девушка на улице' },
  ]
  const model = resolveModelForAssistantGeneration(items, mockCatalog, 'image', 'на столе лежит банан')
  assert.equal(model?.id, 'gpt-image-2')
})

test('resolveModelForAssistantGeneration: «не используй GPT» НЕ переключает модель, предпочитаемая остаётся', () => {
  // Доска предпочитает Nano Banana 2; фраза «не используй GPT» не должна подсветить GPT
  // (раньше подстрока «gpt» находила GPT и включала запрещённую модель — ложный выбор).
  const items: CanvasItem[] = [
    { id: '1', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'nano-banana-2', prompt: 'девушка в машине' },
    { id: '2', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'nano-banana-2', prompt: 'девушка на улице' },
  ]
  const model = resolveModelForAssistantGeneration(items, mockCatalog, 'image', 'не используй GPT вообще')
  assert.equal(model?.id, 'nano-banana-2')
})

// --- Задача 1.3: отделить статистику объектов от статистики реальных job usages ---

test('extractBoardMemory: копии одного запуска НЕ задваивают realUsages и предпочтение', () => {
  // 4 объекта GPT Image 2 — но ВСЕ из ОДНОГО реального запуска (один sourceJobId,
  // остальные — копии Alt+drag). 2 объекта Flux Pro — два РАЗНЫХ запуска.
  // Объектно GPT «больше» (4>2), но реальных запусков больше у Flux (2>1):
  // предпочтение обязано считаться по usages, а не по числу картинок на доске.
  const items: CanvasItem[] = [
    { id: '1', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2', sourceJobId: 'job-gpt' },
    { id: '2', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2', sourceJobId: 'job-gpt' },
    { id: '3', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2', sourceJobId: 'job-gpt' },
    { id: '4', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2', sourceJobId: 'job-gpt' },
    { id: '5', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'flux-pro', sourceJobId: 'job-flux-1' },
    { id: '6', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'flux-pro', sourceJobId: 'job-flux-2' },
  ]
  const memory = extractBoardMemory(items)

  // Объектная статистика по-прежнему считает каждую картинку (копии видны).
  assert.equal(memory.modelsUsage.find((m) => m.modelId === 'gpt-image-2')?.count, 4)
  assert.equal(memory.modelsUsage.find((m) => m.modelId === 'flux-pro')?.count, 2)

  // Реальные usages — по уникальным sourceJobId: 1 запуск GPT против 2 запусков Flux.
  assert.equal(memory.hasRealUsages, true)
  assert.equal(memory.realUsages.find((m) => m.modelId === 'gpt-image-2')?.usages, 1)
  assert.equal(memory.realUsages.find((m) => m.modelId === 'flux-pro')?.usages, 2)

  // Предпочтение идёт по реальным запускам (2>1), а не по числу копий (4>2).
  assert.equal(memory.preferredImageModel?.modelId, 'flux-pro')
  assert.equal(memory.preferredImageModel?.basis, 'usages')
  assert.equal(memory.preferredImageModel?.count, 2)
})

test('extractBoardMemory: legacy-доска без sourceJobId остаётся на объектной статистике', () => {
  // У старых досок sourceJobId нет вовсе — считаем по объектам, иначе автовыбор
  // модели умер бы на legacy-проектах (фолбэк, задокументирован в boardMemory.ts).
  const items: CanvasItem[] = [
    { id: '1', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2' },
    { id: '2', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2' },
    { id: '3', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'flux-pro' },
  ]
  const memory = extractBoardMemory(items)
  assert.equal(memory.hasRealUsages, false)
  assert.equal(memory.realUsages.length, 0)
  assert.equal(memory.preferredImageModel?.basis, 'objects')
  assert.equal(memory.preferredImageModel?.modelId, 'gpt-image-2')
  assert.equal(memory.preferredImageModel?.count, 2)
})

test('extractBoardMemory: video usages — по уникальным запускам (3 копии, 2 job id → 2 usages), legacy-микс не мешает', () => {
  // 3 ролика Kling: два РАЗНЫХ реальных запуска плюс копия первого — usages
  // обязаны быть 2, а не 3. Рядом legacy-картинки GPT без sourceJobId: их фон
  // не должен притянуть предпочтение image-модели к video-предпочтению.
  const items: CanvasItem[] = [
    { id: '1', kind: 'video', x: 0, y: 0, w: 100, h: 100, modelId: 'kling-video', sourceJobId: 'job-k1' },
    { id: '2', kind: 'video', x: 0, y: 0, w: 100, h: 100, modelId: 'kling-video', sourceJobId: 'job-k2' },
    { id: '3', kind: 'video', x: 0, y: 0, w: 100, h: 100, modelId: 'kling-video', sourceJobId: 'job-k1' },
    { id: '4', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2' },
    { id: '5', kind: 'image', x: 0, y: 0, w: 100, h: 100, modelId: 'gpt-image-2' },
  ]
  const memory = extractBoardMemory(items)
  assert.equal(memory.hasRealUsages, true)
  assert.equal(memory.realUsages.find((m) => m.modelId === 'kling-video')?.usages, 2)
  assert.equal(memory.preferredVideoModel?.modelId, 'kling-video')
  assert.equal(memory.preferredVideoModel?.basis, 'usages')
  assert.equal(memory.preferredVideoModel?.count, 2)
})

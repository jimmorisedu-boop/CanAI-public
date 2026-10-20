import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasItem } from './konva/types'
import { BoardMemoryCache } from './boardMemoryCache'

/**
 * Доказательство «повторных обходов доски больше НЕ БЫВАЕТ» ведётся
 * детерминированно через счётчик recomputeCount внутри BoardMemoryCache
 * (план: строка 574 — тесты проверяют ЧИСЛО обходов, а не wall-clock;
 * строка 665 — приёмочные counters «устранение повторных обходов»,
 * «Тиканье ответа» — T02: 10 000 объектов × 30 сообщений).
 * Wall-clock замеры в этих тестах НЕ используются.
 */

function makeItem(id: string, modelId: string, prompt: string, sourceJobId?: string): CanvasItem {
  const item: CanvasItem = {
    id,
    kind: 'image',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    modelId,
    prompt,
  }
  if (sourceJobId !== undefined) item.sourceJobId = sourceJobId
  return item
}

test('BoardMemoryCache: 10 000 картинок x 30 сообщений с тиками — ровно один обход (T02)', () => {
  // Доска масштаба T02: 10 000 объектов. Между сообщениями содержимое холста
  // не меняется (тик таймера ответа, ре-рендер ленты, пан/зум/выделение
  // content-версию не трогают) — повторного полного обхода памяти быть не должно.
  const items: CanvasItem[] = []
  for (let i = 0; i < 10000; i += 1) {
    items.push(makeItem(i, `model-${i % 40}`, `промпт ${i % 40}`, `job-${i % 700}`))
  }

  const cache = new BoardMemoryCache()

  // Первое прочтение — первый (и единственный) полный обход.
  const first = cache.get(items, 7)
  assert.equal(cache.recomputeCount, 1)
  assert.equal(first.totalItems, 10000)

  // Тридцать «сообщений» — тики с той же content-версией.
  for (let tick = 0; tick < 30; tick += 1) {
    assert.equal(cache.get(items, 7), first)
  }
  assert.equal(cache.recomputeCount, 1, 'за 30 тиков не должно быть повторных обходов')

  // Реальные usages дедуплицированы по уникальным запускам: 700 уникальных job
  // id дали ровно 700 usages даже при 10 000 объектов. recentPrompts — без
  // дублей (Set) и не больше 8.
  assert.equal(first.hasRealUsages, true)
  assert.equal(first.realUsages.reduce((s, u) => s + u.usages, 0), 700)
  assert.equal(first.recentPrompts.length, 8)
  assert.equal(new Set(first.recentPrompts.map((p) => p.prompt)).size, 8)
})

test('BoardMemoryCache: пан/зум/выделение и ре-рендер обходов не дают, реальные изменения — по разу', () => {
  const cache = new BoardMemoryCache()
  const items = [makeItem('1', 'gpt-image-2', 'девушка')]

  const v1 = cache.get(items, 5)
  assert.equal(cache.recomputeCount, 1)

  // Ре-рендер, пан/зум/выделение (версия та же) — обхода нет.
  for (let i = 0; i < 20; i += 1) {
    assert.equal(cache.get(items, 5), v1)
  }
  assert.equal(cache.recomputeCount, 1)

  // Изменилось содержимое холста (новый массив и новая версия) — ровно один обход.
  const changed = [
    makeItem('1', 'gpt-image-2', 'девушка'),
    makeItem('2', 'flux-pro', 'комната', 'job-9'),
  ]
  const v2 = cache.get(changed, 6)
  assert.notEqual(v2, v1)
  assert.equal(v2.totalItems, 2)
  assert.equal(cache.recomputeCount, 2)

  // Снова тики без изменений — счётчик замирает.
  cache.get(changed, 6)
  cache.get(changed, 6)
  assert.equal(cache.recomputeCount, 2)
})
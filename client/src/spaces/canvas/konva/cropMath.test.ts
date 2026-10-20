// @ts-expect-error Тест запускается серверным tsx с Node-типами; клиентский tsconfig их намеренно не подключает.
import assert from 'node:assert/strict'
// @ts-expect-error См. пояснение выше: production-клиент не должен зависеть от Node-типов.
import test from 'node:test'
import { resizeFromCorner, type Rect } from './cropMath.js'

test('corner resize stays inside an image smaller than the crop minimum', () => {
  const bounds = { w: 20, h: 20 }
  const rect: Rect = { x: 0, y: 0, w: 20, h: 20 }

  const next = resizeFromCorner(rect, 'se', { x: 5, y: 5 }, bounds, null)

  assert.ok(next.x >= 0)
  assert.ok(next.y >= 0)
  assert.ok(next.x + next.w <= bounds.w)
  assert.ok(next.y + next.h <= bounds.h)
})

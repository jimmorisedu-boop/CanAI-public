import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findFreeNodePosition,
  placementScreenArea,
  visibleFlowViewportForPlacement,
} from './nodePlacement'
import './nodeToolbarLayout.test'
import './nodePaletteDnd.test'

test('следующая нода встаёт справа и не пересекает предыдущую', () => {
  const result = findFreeNodePosition({
    preferred: { x: 100, y: 100 },
    existing: [{ x: 100, y: 100, width: 280, height: 150 }],
    viewport: { x: 0, y: 0, width: 1200, height: 700 },
    nodeSize: { width: 280, height: 150 },
    gap: 48,
  })
  assert.deepEqual(result, { x: 428, y: 100 })
})

test('при нехватке ширины размещение переносится на следующий ряд', () => {
  const result = findFreeNodePosition({
    preferred: { x: 420, y: 100 },
    existing: [{ x: 420, y: 100, width: 280, height: 150 }],
    viewport: { x: 0, y: 0, width: 760, height: 700 },
    nodeSize: { width: 280, height: 150 },
    gap: 48,
  })
  assert.deepEqual(result, { x: 0, y: 298 })
})

test('свободная точка контекстного меню сохраняется', () => {
  const result = findFreeNodePosition({
    preferred: { x: 612, y: 244 },
    existing: [],
    viewport: { x: 0, y: 0, width: 1200, height: 700 },
    nodeSize: { width: 280, height: 150 },
    gap: 48,
  })
  assert.deepEqual(result, { x: 612, y: 244 })
})

test('на узком экране занятая середина отправляет ноду в свободный ряд сверху, а не за экран', () => {
  const result = findFreeNodePosition({
    preferred: { x: 264, y: 259 },
    existing: [
      { x: 520, y: 259, width: 240, height: 150 },
      { x: 808, y: 259, width: 240, height: 150 },
      { x: 0, y: 457, width: 240, height: 150 },
      { x: 288, y: 457, width: 240, height: 150 },
    ],
    viewport: { x: 0, y: 0, width: 768, height: 668 },
    nodeSize: { width: 240, height: 150 },
    gap: 48,
  })

  assert.deepEqual(result, { x: 0, y: 61 })
})

test('на мобильном тулбар исключается из области размещения, а интервал уплотняется', () => {
  const result = placementScreenArea({
    flow: { x: 0, y: 52, width: 768, height: 668 },
    toolbar: { x: 16, y: 68, width: 736, height: 60 },
    baseGap: 48,
    compactGap: 32,
    compactWidth: 900,
  })

  assert.deepEqual(result, {
    rect: { x: 0, y: 128, width: 768, height: 592 },
    gap: 32,
  })
})

test('при добавлении ноды масштаб выше 100% раскрывает рабочую область вокруг прежнего центра', () => {
  const result = visibleFlowViewportForPlacement({
    center: { x: 266, y: 167 },
    screenSize: { width: 1064, height: 668 },
    currentZoom: 2,
    maxZoom: 1,
  })

  assert.deepEqual(result, {
    viewport: { x: -266, y: -167, width: 1064, height: 668 },
    zoom: 1,
  })
})

// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { contextActionsFor } from './contextActionModel'

const item = (kind: CanvasItem['kind'], id = kind): CanvasItem => ({
  id, kind, x: 0, y: 0, w: 100, h: 100,
  ...(kind === 'text' ? { text: 'Текст' } : {}),
}) as CanvasItem

test('картинка сразу показывает крупный просмотр и resize, остальное уходит в меню', () => {
  assert.deepEqual(contextActionsFor([item('image')]), {
    primary: ['view', 'resize', 'crop'],
    overflow: ['sketch', 'pin', 'front', 'back', 'download', 'archive'],
  })
})

test('у видео сразу доступны крупный просмотр и resize', () => {
  assert.deepEqual(contextActionsFor([item('video')]), {
    primary: ['view', 'resize', 'clip'],
    overflow: ['pin', 'front', 'back', 'download', 'archive'],
  })
})

test('звук и текст получают явный resize вместе со своими действиями', () => {
  assert.deepEqual(contextActionsFor([item('audio')]).primary, ['resize', 'duplicate', 'download'])
  assert.deepEqual(contextActionsFor([item('text')]).primary, ['edit-text', 'resize', 'duplicate'])
})

test('группа получает сетку и сравнение только для совместимых кадров', () => {
  assert.deepEqual(contextActionsFor([item('image', 'a'), item('image', 'b')]).primary, ['grid', 'compare', 'duplicate'])
  assert.deepEqual(contextActionsFor([item('image', 'a'), item('text', 'b')]).primary, ['grid', 'duplicate'])
  assert.ok(!contextActionsFor([item('image', 'a'), item('image', 'b')]).overflow.includes('delete'))
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { isCanvasSnapshot } from './canvasSnapshot.js'

const BASE64_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

const base = {
  version: 1,
  items: [],
  camera: { x: 0, y: 0, scale: 1 },
}

const mediaItem = {
  id: 'i1',
  kind: 'image',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  src: '/media/ok.png',
}

test('контроль: base64 в items отвергается, обычная ссылка проходит', () => {
  assert.equal(isCanvasSnapshot({ ...base, items: [mediaItem] }), true)
  assert.equal(isCanvasSnapshot({ ...base, items: [{ ...mediaItem, src: BASE64_SRC }] }), false)
})

test('контроль: base64 в assets и pending тоже отвергается', () => {
  assert.equal(
    isCanvasSnapshot({ ...base, assets: [{ slot: 0, kind: 'image', src: BASE64_SRC }] }),
    false,
  )
})

test('base64 в archive обязан отвергаться так же, как в items', () => {
  // Архив — такая же коллекция доски, и на неё распространяется тот же
  // инвариант: в project.json только ссылки /media/…, никакого base64.
  // Путь достижим: заархивированный объект уходит из items (те проверяются) в
  // archive (который сторож не смотрит) и попадает на диск.
  const snapshot = {
    ...base,
    archive: [{ ...mediaItem, src: BASE64_SRC, archivedAt: 1786012345678 }],
  }
  assert.equal(isCanvasSnapshot(snapshot), false)
})

test('нормальный архив со ссылкой /media/ проходит', () => {
  const snapshot = {
    ...base,
    archive: [{ ...mediaItem, archivedAt: 1786012345678 }],
  }
  assert.equal(isCanvasSnapshot(snapshot), true)
})

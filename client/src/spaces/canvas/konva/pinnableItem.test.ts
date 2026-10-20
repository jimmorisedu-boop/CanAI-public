import assert from 'node:assert/strict'
import test from 'node:test'
import { canPinCanvasItem } from './pinnableItem.js'

test('link-карточка не закрепляется как генерационный ассет', () => {
  assert.equal(canPinCanvasItem({ kind: 'link', link: { url: 'https://youtu.be/a' } }), false)
  assert.equal(canPinCanvasItem({ kind: 'image', src: '/media/a.png' }), true)
  assert.equal(canPinCanvasItem({ kind: 'text', text: 'заметка' }), true)
})

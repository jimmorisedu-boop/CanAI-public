import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextMenu } from './ContextMenu.js'
import { itemDownloadLabel, isItemToolbarEligible } from './ItemToolbar.js'
import type { CanvasItem } from './types.js'
import type { CanvasStore } from './canvasStore.js'

function item(kind: CanvasItem['kind'], src = '/media/file.bin'): CanvasItem {
  return { id: kind, kind, x: 0, y: 0, w: 320, h: 180, src, mime: kind === 'audio' ? 'audio/mpeg' : `${kind}/test` }
}

test('single audio is eligible for the item toolbar and has an audio download label', () => {
  assert.equal(isItemToolbarEligible(item('audio')), true)
  assert.equal(itemDownloadLabel(item('audio')), 'Download audio')
})

test('text and link items do not get media toolbar download actions', () => {
  assert.equal(isItemToolbarEligible(item('text')), false)
  assert.equal(isItemToolbarEligible({ ...item('link'), src: undefined, link: undefined }), false)
})

test('audio context menu exposes a direct audio download action', () => {
  const audio = item('audio', '/media/voice.mp3')
  const store = {
    getItem: () => audio,
    getPending: () => [],
    getSelectedItems: () => [audio],
    getSelectedIds: () => [audio.id],
    looksEditable: () => true,
  } as unknown as CanvasStore
  const output = renderToStaticMarkup(
    React.createElement(ContextMenu, {
      store,
      menu: { x: 0, y: 0, itemId: audio.id, world: { x: 0, y: 0 } },
      viewport: { w: 800, h: 600 },
      onAdd: () => {},
      onClose: () => {},
    }),
  )
  assert.match(output, /Download audio/u)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { projectPreviewFromSnapshot } from './projectPreview.js'

test('доска только с видео получает video-preview', () => {
  assert.deepEqual(
    projectPreviewFromSnapshot({
      version: 1,
      items: [
        { id: 'note', kind: 'text', text: 'идея' },
        { id: 'clip', kind: 'video', src: '/media/launch.mp4' },
      ],
    }),
    { src: '/media/launch.mp4', kind: 'video' },
  )
})
test('preview следует порядку холста и не принимает внешние или inline ссылки', () => {
  assert.deepEqual(
    projectPreviewFromSnapshot({
      items: [
        { kind: 'image', src: 'data:image/png;base64,AAAA' },
        { kind: 'video', src: 'https://example.com/out.mp4' },
        { kind: 'image', src: '/media/board.webp?v=2' },
        { kind: 'video', src: '/media/later.mp4' },
      ],
    }),
    { src: '/media/board.webp?v=2', kind: 'image' },
  )
  assert.equal(projectPreviewFromSnapshot({ items: 'broken' }), null)
})

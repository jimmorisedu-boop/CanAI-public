import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyCanvasTextPaste, isSafeCanvasLinkData, standaloneMediaUrl } from './mediaLinkUrl.js'

test('одна web-ссылка занимает весь вставленный текст', () => {
  assert.equal(standaloneMediaUrl('  https://youtu.be/abc?t=2\n'), 'https://youtu.be/abc?t=2')
  assert.equal(standaloneMediaUrl('http://example.test/photo.jpg'), 'http://example.test/photo.jpg')
})

test('routes only a standalone URL to a link card', () => {
  assert.deepEqual(classifyCanvasTextPaste(' https://youtu.be/a '), { kind: 'link', url: 'https://youtu.be/a' })
  assert.deepEqual(classifyCanvasTextPaste('смотри https://youtu.be/a'), { kind: 'text', text: 'смотри https://youtu.be/a' })
})

test('заметка, несколько ссылок и не-web схемы остаются текстом', () => {
  assert.equal(standaloneMediaUrl('смотри https://youtu.be/abc'), null)
  assert.equal(standaloneMediaUrl('https://a.test/x https://b.test/y'), null)
  assert.equal(standaloneMediaUrl('file:///C:/photo.jpg'), null)
  assert.equal(standaloneMediaUrl('javascript:alert(1)'), null)
})

test('persisted Vimeo link data passes the same safe local-preview guard', () => {
  assert.equal(isSafeCanvasLinkData({
    url: 'https://vimeo.com/12345',
    normalizedUrl: 'https://player.vimeo.com/video/12345',
    provider: 'vimeo',
    sourceLabel: 'Vimeo',
    title: 'Vimeo ролик',
    state: 'ready',
    previewSrc: '/media/link-preview-vimeo.webp',
    entries: [{ id: 'vimeo-video', kind: 'video', title: 'Vimeo ролик', aspectRatio: 16 / 9 }],
  }), true)
})

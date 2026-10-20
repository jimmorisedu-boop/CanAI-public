import assert from 'node:assert/strict'
import test from 'node:test'
import { MediaLinkError, normalizeMediaLink } from './mediaLinkUrl.js'

test('площадки распознаются только по точному известному хосту', () => {
  assert.equal(normalizeMediaLink('https://youtu.be/abc').provider, 'youtube')
  assert.equal(normalizeMediaLink('https://www.tiktok.com/@u/video/1').provider, 'tiktok')
  assert.equal(normalizeMediaLink('https://instagram.com/p/abc/').provider, 'instagram')
  assert.equal(normalizeMediaLink('https://vimeo.com/12345').provider, 'vimeo')
  assert.equal(normalizeMediaLink('https://www.vimeo.com/12345').provider, 'vimeo')
  assert.equal(normalizeMediaLink('https://player.vimeo.com/video/12345').provider, 'vimeo')
  assert.equal(normalizeMediaLink('https://youtube.com.evil.test/x').provider, 'direct')
})

test('http повышается до https только для известных площадок', () => {
  assert.equal(normalizeMediaLink('http://youtu.be/abc').url, 'https://youtu.be/abc')
  assert.equal(normalizeMediaLink('http://vimeo.com/12345').url, 'https://vimeo.com/12345')
  assert.throws(() => normalizeMediaLink('http://files.test/a.mp4'), MediaLinkError)
})

test('не-web URL и URL с учётными данными отвергаются', () => {
  assert.throws(() => normalizeMediaLink('file:///tmp/a.jpg'), MediaLinkError)
  assert.throws(() => normalizeMediaLink('https://user:secret@example.test/a.jpg'), MediaLinkError)
})

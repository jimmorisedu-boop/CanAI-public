import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaFilesFromClipboard, mediaKind } from './clipboardMedia.js'

function clipboardItem(kind: string, file: File | null) {
  return {
    kind,
    type: file?.type ?? 'text/plain',
    getAsFile: () => file,
  }
}

test('скриншот и видео из clipboard извлекаются как media, текст остаётся редактору', () => {
  const screenshot = new File(['png'], 'image.png', { type: 'image/png' })
  const video = new File(['mp4'], 'clip.mp4', { type: 'video/mp4' })

  const files = mediaFilesFromClipboard({
    items: [
      clipboardItem('string', null),
      clipboardItem('file', screenshot),
      clipboardItem('file', new File(['pdf'], 'notes.pdf', { type: 'application/pdf' })),
      clipboardItem('file', video),
    ],
  })

  assert.deepEqual(files, [screenshot, video])
})
test('звук распознаётся, а .ogg разводится по типу, а не по расширению', () => {
  assert.equal(mediaKind({ type: 'audio/mpeg', name: 'voice.mp3' }), 'audio')
  assert.equal(mediaKind({ type: '', name: 'voice.wav' }), 'audio')
  assert.equal(mediaKind({ type: '', name: 'track.m4a' }), 'audio')
  // .ogg живёт в обоих списках расширений: только тип отличает звук от видео.
  // По одному расширению звук уехал бы в видео-ветку и встал бы на холст
  // чёрным прямоугольником вместо плашки.
  assert.equal(mediaKind({ type: 'audio/ogg', name: 'sound.ogg' }), 'audio')
  assert.equal(mediaKind({ type: 'video/ogg', name: 'sound.ogg' }), 'video')
  assert.equal(mediaKind({ type: '', name: 'sound.ogg' }), 'video')
  // картинки и видео не должны пострадать от нового порядка проверок
  assert.equal(mediaKind({ type: 'image/png', name: 'shot.png' }), 'image')
  assert.equal(mediaKind({ type: '', name: 'clip.mp4' }), 'video')
  assert.equal(mediaKind({ type: 'application/pdf', name: 'notes.pdf' }), null)
})

test('звук из clipboard попадает на холст наравне с картинкой', () => {
  const voice = new File(['mp3'], 'voice.mp3', { type: 'audio/mpeg' })
  assert.deepEqual(mediaFilesFromClipboard({ items: [clipboardItem('file', voice)] }), [voice])
})

test('обычный текстовый clipboard не перехватывается канвасом', () => {
  assert.deepEqual(
    mediaFilesFromClipboard({
      items: [clipboardItem('string', null)],
    }),
    [],
  )
})

test('скриншот Windows сохраняет MIME и имя из clipboard item, если File пришёл без метаданных', () => {
  const screenshot = new File(['png'], '', { type: '' })
  const [normalized] = mediaFilesFromClipboard({
    items: [{
      kind: 'file',
      type: 'image/png',
      getAsFile: () => screenshot,
    }],
  })

  assert.ok(normalized)
  assert.equal(normalized.type, 'image/png')
  assert.equal(normalized.name, 'clipboard.png')
})

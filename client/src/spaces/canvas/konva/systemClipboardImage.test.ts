import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasItem } from './types.js'
import {
  clipboardImageSource,
  copyImageToSystemClipboard,
  needsPngConversion,
} from './systemClipboardImage.js'

function image(patch: Partial<CanvasItem> = {}): CanvasItem {
  return {
    id: 'item_1', kind: 'image', x: 0, y: 0, w: 100, h: 100,
    src: '/media/photo.png', ...patch,
  } as CanvasItem
}

/**
 * ⚠️ Просьба пользователя (07.09.2026): «скопировать фотку и вставить в
 * фотошоп». Своим буфером это не решается — картинка должна лечь в СИСТЕМНЫЙ.
 */
test('из выделения берётся первая картинка: системный буфер держит одну', () => {
  const text = { id: 'text_1', kind: 'text' } as CanvasItem
  const video = { id: 'video_1', kind: 'video', src: '/media/clip.mp4' } as CanvasItem
  assert.equal(clipboardImageSource([text, video]), null, 'видео буфер не принимает')
  assert.equal(clipboardImageSource([text, image({ id: 'a' }), image({ id: 'b' })])?.id, 'a')
})

test('в буфер кладём PNG: другого формата браузер не принимает', () => {
  assert.equal(needsPngConversion('image/jpeg'), true)
  assert.equal(needsPngConversion('image/webp'), true)
  assert.equal(needsPngConversion('image/png'), false)
  assert.equal(needsPngConversion(undefined), true)
})

test('картинка и метка нашего буфера едут ОДНИМ элементом', async () => {
  const written: Array<Record<string, unknown>> = []
  class FakeClipboardItem {
    constructor(readonly parts: Record<string, unknown>) {}
  }
  ;(globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem
  const ok = await copyImageToSystemClipboard(image(), '{"type":"canai"}', {
    fetch: (async () => new Response(new Blob(['png'], { type: 'image/png' }))) as typeof fetch,
    write: async (items) => { written.push(...(items as unknown as FakeClipboardItem[]).map((i) => i.parts)) },
  })
  assert.equal(ok, true)
  assert.deepEqual(Object.keys(written[0]!), ['image/png', 'text/plain'])
})

test('без метки кладём только картинку — пустой текст в буфере не нужен', async () => {
  const written: Array<Record<string, unknown>> = []
  class FakeClipboardItem {
    constructor(readonly parts: Record<string, unknown>) {}
  }
  ;(globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem
  await copyImageToSystemClipboard(image(), '', {
    fetch: (async () => new Response(new Blob(['png'], { type: 'image/png' }))) as typeof fetch,
    write: async (items) => { written.push(...(items as unknown as FakeClipboardItem[]).map((i) => i.parts)) },
  })
  assert.deepEqual(Object.keys(written[0]!), ['image/png'])
})

test('отказ браузера не роняет копирование внутри приложения', async () => {
  class FakeClipboardItem {
    constructor(readonly parts: Record<string, unknown>) {}
  }
  ;(globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem
  const ok = await copyImageToSystemClipboard(image(), 'payload', {
    fetch: (async () => new Response(new Blob(['png'], { type: 'image/png' }))) as typeof fetch,
    write: async () => { throw new Error('нет разрешения') },
  })
  assert.equal(ok, false)
})

test('видео и текст в системный буфер не отправляются', async () => {
  const video = { id: 'v', kind: 'video', src: '/media/clip.mp4' } as CanvasItem
  assert.equal(await copyImageToSystemClipboard(video, 'payload'), false)
})

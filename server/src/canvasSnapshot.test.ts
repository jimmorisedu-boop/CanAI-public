import assert from 'node:assert/strict'
import test from 'node:test'
import { isCanvasSnapshot, isValidMediaSrc } from './canvasSnapshot.js'

const baseCamera = { x: 0, y: 0, scale: 1 }

test('isValidMediaSrc accepts local media paths and cache busters', () => {
  assert.equal(isValidMediaSrc('/media/abc-123.png'), true)
  assert.equal(isValidMediaSrc('/media/edit-uuid.webp?v=123'), true)
  assert.equal(isValidMediaSrc('data:image/png;base64,aaa'), false)
  assert.equal(isValidMediaSrc('https://evil.example/x.png'), false)
  assert.equal(isValidMediaSrc('/media/../secret.png'), false)
  assert.equal(isValidMediaSrc('/media/foo/bar.png'), false)
})

test('isCanvasSnapshot rejects base64 and external image src', () => {
  const ok = {
    version: 1 as const,
    camera: baseCamera,
    items: [{ id: '1', kind: 'image', x: 0, y: 0, w: 100, h: 100, src: '/media/a.png' }],
  }
  assert.equal(isCanvasSnapshot(ok), true)

  assert.equal(
    isCanvasSnapshot({
      ...ok,
      items: [{ id: '1', kind: 'image', x: 0, y: 0, w: 100, h: 100, src: 'data:image/png;base64,xxx' }],
    }),
    false,
  )
  assert.equal(
    isCanvasSnapshot({
      ...ok,
      items: [{ id: '1', kind: 'image', x: 0, y: 0, w: 100, h: 100, src: 'https://cdn.example/a.png' }],
    }),
    false,
  )
})

test('isCanvasSnapshot validates non-destructive crop metadata', () => {
  const item = {
    id: 'crop-1', kind: 'image', x: 10, y: 20, w: 640, h: 480,
    src: '/media/crop.png',
    crop: {
      sourceSrc: '/media/original.png',
      sourceMime: 'image/png',
      sourceNaturalWidth: 1600,
      sourceNaturalHeight: 1200,
      rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    },
  }
  const snapshot = { version: 1, camera: baseCamera, items: [item] }

  assert.equal(isCanvasSnapshot(snapshot), true)
  assert.equal(isCanvasSnapshot({
    ...snapshot,
    items: [{ ...item, crop: { ...item.crop, sourceSrc: 'data:image/png;base64,unsafe' } }],
  }), false)
  assert.equal(isCanvasSnapshot({
    ...snapshot,
    items: [{ ...item, crop: { ...item.crop, rect: { x: 0.5, y: 0, w: 0.6, h: 1 } } }],
  }), false)
  assert.equal(isCanvasSnapshot({
    ...snapshot,
    items: [{ ...item, crop: { ...item.crop, sourceNaturalWidth: 0 } }],
  }), false)
  assert.equal(isCanvasSnapshot({
    ...snapshot,
    items: [{ id: 'text-1', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'hello', crop: item.crop }],
  }), false)
})

test('isCanvasSnapshot allows text without src and rejects huge text', () => {
  assert.equal(
    isCanvasSnapshot({
      version: 1,
      camera: baseCamera,
      items: [{ id: 't', kind: 'text', x: 0, y: 0, w: 200, h: 100, text: 'привет' }],
    }),
    true,
  )
  assert.equal(
    isCanvasSnapshot({
      version: 1,
      camera: baseCamera,
      items: [{ id: 't', kind: 'text', x: 0, y: 0, w: 200, h: 100, text: 'x'.repeat(50_001) }],
    }),
    false,
  )
})

test('snapshot принимает link-карточку только с локальным превью', () => {
  const link = {
    id: 'link-1',
    kind: 'link',
    x: 10,
    y: 20,
    w: 360,
    h: 280,
    link: {
      url: 'https://youtu.be/abc',
      normalizedUrl: 'https://youtu.be/abc',
      provider: 'youtube',
      sourceLabel: 'YouTube',
      title: 'Ролик',
      state: 'ready',
      previewSrc: '/media/link-preview.webp',
      previewKind: 'image',
      entries: [{ id: 'video-1', kind: 'video', title: 'Ролик', aspectRatio: 16 / 9 }],
      downloadedItemIds: { 'video-1': 'canvas-video-1' },
    },
  }
  const snapshot = { version: 1, camera: baseCamera, items: [link] }

  assert.equal(isCanvasSnapshot(snapshot), true)
  assert.equal(isCanvasSnapshot({
    ...snapshot,
    items: [{ ...link, link: { ...link.link, previewSrc: 'https://cdn.test/preview.webp' } }],
  }), false)
  assert.equal(isCanvasSnapshot({
    ...snapshot,
    items: [{ ...link, link: { ...link.link, previewSrc: 'data:image/webp;base64,unsafe' } }],
  }), false)
})

test('snapshot сохраняет Vimeo provider с локальным превью', () => {
  const snapshot = {
    version: 1,
    camera: baseCamera,
    items: [{
      id: 'vimeo-link',
      kind: 'link',
      x: 0,
      y: 0,
      w: 360,
      h: 280,
      link: {
        url: 'https://vimeo.com/12345',
        normalizedUrl: 'https://player.vimeo.com/video/12345',
        provider: 'vimeo',
        sourceLabel: 'Vimeo',
        title: 'Vimeo ролик',
        state: 'ready',
        previewSrc: '/media/link-preview-vimeo.webp',
        previewKind: 'image',
        entries: [{ id: 'vimeo-video', kind: 'video', title: 'Vimeo ролик', aspectRatio: 16 / 9 }],
      },
    }],
  }

  assert.equal(isCanvasSnapshot(snapshot), true)
})

test('snapshot валидирует durable поля media-import placeholder', () => {
  const pending = {
    id: 'pending-import-1',
    jobId: 'import-1',
    x: 400,
    y: 20,
    w: 320,
    h: 180,
    kind: 'video',
    label: 'Ролик',
    status: 'loading',
    startedAt: 100,
    taskType: 'media-import',
    importEntryId: 'video-1',
    sourceLinkId: 'link-1',
    downloadedBytes: 1024,
    totalBytes: 4096,
    percent: 25,
    stage: 'Скачивание…',
  }
  const snapshot = { version: 1, camera: baseCamera, items: [], pending: [pending] }

  assert.equal(isCanvasSnapshot(snapshot), true)
  assert.equal(isCanvasSnapshot({ ...snapshot, pending: [{ ...pending, percent: 101 }] }), false)
  assert.equal(isCanvasSnapshot({ ...snapshot, pending: [{ ...pending, importEntryId: '' }] }), false)
})

test('snapshot принимает ожидающую audio-генерацию', () => {
  const snapshot = {
    version: 1,
    camera: baseCamera,
    items: [],
    pending: [{
      id: 'pending-audio-1',
      jobId: 'job-audio-1',
      x: 40,
      y: 60,
      w: 320,
      h: 96,
      kind: 'audio',
      label: 'Аудио',
      status: 'loading',
      startedAt: 100,
      retry: {
        kind: 'audio',
        prompt: 'Раздели вокал и музыку',
        refs: [{ kind: 'audio', src: '/media/source.mp3' }],
        model: 'audio-separation',
      },
    }],
  }

  assert.equal(isCanvasSnapshot(snapshot), true)
})

test('isCanvasSnapshot validates pinned assets', () => {
  assert.equal(
    isCanvasSnapshot({
      version: 1,
      camera: baseCamera,
      items: [],
      assets: [{ slot: 0, kind: 'image', src: '/media/pin.png' }],
    }),
    true,
  )
  assert.equal(
    isCanvasSnapshot({
      version: 1,
      camera: baseCamera,
      items: [],
      assets: [{ slot: 0, kind: 'image', src: 'data:image/png;base64,x' }],
    }),
    false,
  )
})

test('isCanvasSnapshot rejects data-url inside a pending retry descriptor', () => {
  const pending = {
    id: 'pending-1',
    jobId: 'job-1',
    x: 0,
    y: 0,
    w: 320,
    h: 320,
    kind: 'image',
    label: 'Модель',
    status: 'loading',
    startedAt: 100,
  }
  const snapshot = {
    version: 1,
    camera: baseCamera,
    items: [],
    pending: [{
      ...pending,
      retry: {
        kind: 'image',
        prompt: 'Дорисуй изображение',
        refs: [{ kind: 'image', src: '/media/reference.png' }],
      },
    }],
  }

  assert.equal(isCanvasSnapshot(snapshot), true)
  assert.equal(
    isCanvasSnapshot({
      ...snapshot,
      pending: [{
        ...pending,
        retry: {
          kind: 'image',
          prompt: 'Дорисуй изображение',
          refs: [{ kind: 'image', src: 'data:image/png;base64,unsafe' }],
        },
      }],
    }),
    false,
  )
})

test('isCanvasSnapshot validates persisted usedReferences on a pending generation', () => {
  const pending = {
    id: 'pending-1',
    jobId: 'job-1',
    x: 0,
    y: 0,
    w: 320,
    h: 320,
    kind: 'image',
    label: 'Модель',
    status: 'loading',
    startedAt: 100,
  }
  const snapshot = { version: 1, camera: baseCamera, items: [], pending: [{ ...pending, usedReferences: true }] }

  assert.equal(isCanvasSnapshot(snapshot), true)
  assert.equal(isCanvasSnapshot({ ...snapshot, pending: [{ ...pending, usedReferences: 'yes' }] }), false)
})

test('externalEditSessionId accepts only a bounded safe identifier', () => {
  const item = {
    id: 'image-1', kind: 'image', x: 0, y: 0, w: 100, h: 100,
    src: '/media/edit.png', externalEditSessionId: 'session_1-safe',
  }
  const snapshot = { version: 1, camera: baseCamera, items: [item] }
  assert.equal(isCanvasSnapshot(snapshot), true)
  assert.equal(isCanvasSnapshot({
    ...snapshot, items: [{ ...item, externalEditSessionId: '' }],
  }), false)
  assert.equal(isCanvasSnapshot({
    ...snapshot, items: [{ ...item, externalEditSessionId: 'bad id!' }],
  }), false)
  assert.equal(isCanvasSnapshot({
    ...snapshot, items: [{ ...item, externalEditSessionId: 'x'.repeat(101) }],
  }), false)
})

test('snapshot принимает не более 100 безопасных launch id', () => {
  const snapshot = {
    version: 1,
    camera: baseCamera,
    items: [],
    handledGenerationLaunchIds: ['launch-a'],
  }

  assert.equal(isCanvasSnapshot(snapshot), true)
  assert.equal(isCanvasSnapshot({
    ...snapshot,
    handledGenerationLaunchIds: Array.from({ length: 101 }, (_, index) => `launch-${index}`),
  }), false)
})

test('snapshot fail-closed отклоняет небезопасные launch id', () => {
  const snapshot = { version: 1, camera: baseCamera, items: [] }

  assert.equal(isCanvasSnapshot({ ...snapshot, handledGenerationLaunchIds: 'launch-a' }), false)
  assert.equal(isCanvasSnapshot({ ...snapshot, handledGenerationLaunchIds: [''] }), false)
  assert.equal(isCanvasSnapshot({ ...snapshot, handledGenerationLaunchIds: ['x'.repeat(101)] }), false)
  assert.equal(isCanvasSnapshot({ ...snapshot, handledGenerationLaunchIds: [42] }), false)
  assert.equal(isCanvasSnapshot({ ...snapshot, handledGenerationLaunchIds: ['launch-a', 'launch-a'] }), false)
})

test('имя файла может быть не латиницей, но выйти из папки media нельзя', () => {
  // Приложение всегда даёт латинские имена, но в media попадает и то, что
  // человек положил руками (восстановил из бэкапа, вытащил потерянный
  // результат). Список из одной латиницы отвергал такую ссылку, а вместе с ней
  // и ВСЮ доску: сохранение молча переставало работать.
  assert.equal(isValidMediaSrc('/media/проба-звук.mp3'), true)
  assert.equal(isValidMediaSrc('/media/файл с пробелом.png'), true)
  assert.equal(isValidMediaSrc('/media/a.png?v=12'), true)
  // А опасное по-прежнему закрыто.
  assert.equal(isValidMediaSrc('/media/../secret.png'), false)
  assert.equal(isValidMediaSrc('/media/sub/dir.png'), false)
  assert.equal(isValidMediaSrc('/media/a\\b.png'), false)
  assert.equal(isValidMediaSrc('/media/'), false)
})

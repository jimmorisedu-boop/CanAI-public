import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasLinkData } from './types.js'
import { linkCardPresentation } from './linkItemPresentation.js'
import './linkActionButton.test.js'
import './media.test.js'

const readyLink: CanvasLinkData = {
  url: 'https://youtu.be/a',
  normalizedUrl: 'https://youtu.be/a',
  provider: 'youtube',
  sourceLabel: 'YouTube',
  title: 'Демо видео',
  state: 'ready',
  entries: [{ id: 'video', kind: 'video', title: 'Демо видео', aspectRatio: 16 / 9 }],
}

test('ready card exposes source, title and download action', () => {
  const view = linkCardPresentation(readyLink)
  assert.equal(view.source, 'YouTube')
  assert.equal(view.title, 'Демо видео')
  assert.equal(view.openLabel, 'Open link')
  assert.equal(view.primaryAction, 'Download')
})

test('loading preview keeps download enabled as a separate action', () => {
  const view = linkCardPresentation({ ...readyLink, state: 'loading-preview', entries: [] })
  assert.equal(view.primaryAction, 'Download')
  assert.equal(view.previewStatus, 'Loading preview…')
  assert.equal(view.canRetryPreview, false)
})

test('preview error exposes retry without replacing download', () => {
  const view = linkCardPresentation({ ...readyLink, state: 'error', error: 'CDN недоступен' })
  assert.equal(view.primaryAction, 'Download')
  assert.equal(view.previewStatus, 'The CDN is unavailable.')
  assert.equal(view.canRetryPreview, true)
})

test('completed card remains downloadable while an active import reports progress', () => {
  assert.equal(linkCardPresentation({ ...readyLink, downloadedItemIds: { video: 'canvas-video' } }).primaryAction, 'Download')
  assert.equal(linkCardPresentation({ ...readyLink, activeImportId: 'task' }).primaryAction, 'Downloading…')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { MediaImportTask, MediaLinkPreview } from '../mediaImportTypes.js'
import { CanvasStore } from './canvasStore.js'
import type { CanvasMutationEnvelope } from './canvasMutations.js'
import {
  createMediaLinkController,
  PREVIEW_NO_ANSWER,
  PREVIEW_PARALLEL,
  refreshUnsettledLinkPreviews,
  transientLinkError,
  type MediaLinkController,
} from './mediaLinkController.js'
import { registerMediaImportCancelHandler } from '../mediaImportCancelBus.js'
import { ApiError, LOCAL_SERVICE_UNAVAILABLE, LOCAL_SERVICE_UNAVAILABLE_MESSAGE } from '../../../api.js'
import { linkCardPresentation } from './linkItemPresentation.js'

const preview: MediaLinkPreview = {
  normalizedUrl: 'https://cdn.test/post', provider: 'direct', sourceLabel: 'Ссылка', title: 'Пост',
  entries: [
    { id: 'one', kind: 'image', title: 'Один', aspectRatio: 1 },
    { id: 'two', kind: 'video', title: 'Два', aspectRatio: 16 / 9 },
  ],
}

function task(status: MediaImportTask['status'] = 'queued'): MediaImportTask {
  return {
    id: 'task-1', sourceUrl: preview.normalizedUrl, provider: 'direct', status,
    createdAt: 1, updatedAt: 2,
    items: preview.entries.map((entry) => ({ ...entry, status, downloadedBytes: status === 'completed' ? 10 : 0 })),
  }
}

function readyStoreWithDownloadedEntries(entryIds: string[]) {
  const store = new CanvasStore()
  const linkId = store.placeLink('https://cdn.test/post')
  store.applyLinkPreview(linkId, preview)
  const downloadedItemIds: Record<string, string> = {}
  for (const entryId of entryIds) {
    const entry = preview.entries.find((candidate) => candidate.id === entryId)!
    const canvasId = `canvas-${entryId}`
    store.addItem({
      id: canvasId,
      kind: entry.kind,
      x: entryId === 'one' ? 0 : 120,
      y: 400,
      w: 100,
      h: 100,
      src: entry.kind === 'image' ? `/media/${entryId}.png` : `/media/${entryId}.mp4`,
    })
    downloadedItemIds[entryId] = canvasId
  }
  store.updateItem(linkId, {
    link: { ...store.getItem(linkId)!.link!, downloadedItemIds },
  }, false)
  return { store, linkId }
}

function controllerRecordingStarts(requested: Array<string[] | undefined>) {
  return createMediaLinkController({
    preview: async () => preview,
    start: async (_url, entryIds) => {
      requested.push(entryIds)
      return { task: task() }
    },
    track: () => undefined,
  })
}

test('preview failure leaves the link item and original URL', async () => {
  const store = new CanvasStore()
  const controller = createMediaLinkController({
    preview: async () => { throw new Error('Сайт недоступен') },
    start: async () => ({ task: task() }),
    track: () => undefined,
  })
  const id = await controller.previewPastedLink(store, 'https://cdn.test/original')
  const item = store.getItem(id)
  assert.equal(item?.kind, 'link')
  assert.equal(item?.link?.url, 'https://cdn.test/original')
  assert.equal(item?.link?.state, 'error')
  assert.match(item?.link?.error ?? '', /Сайт недоступен/)
})

test('reserveMediaImport creates every placeholder before registry tracking', async () => {
  const calls: string[] = []
  const fakeStore = {
    getItem: () => ({ kind: 'link', link: { entries: preview.entries, downloadedItemIds: {} } }),
    reuseDownloadedLinkItems: () => ({ copiedEntryIds: [], missingEntryIds: preview.entries.map((entry) => entry.id) }),
    reserveMediaImport: () => { calls.push('reserve'); return ['p1', 'p2'] },
  }
  const controller = createMediaLinkController({
    preview: async () => preview,
    start: async () => { calls.push('start'); return { task: task() } },
    track: () => calls.push('track'),
  })
  await controller.downloadLink(fakeStore as never, 'project-1', 'link-1')
  assert.deepEqual(calls, ['start', 'reserve', 'track'])
})

test('download before preview resolution starts the whole URL once', async () => {
  const store = new CanvasStore()
  const linkId = store.placeLink('https://youtu.be/demo')
  let starts = 0
  let release!: (value: { task: MediaImportTask }) => void
  const pendingStart = new Promise<{ task: MediaImportTask }>((resolve) => { release = resolve })
  const controller = createMediaLinkController({
    preview: async () => preview,
    start: async (_url, entryIds) => {
      starts++
      assert.equal(entryIds, undefined)
      return pendingStart
    },
    track: () => undefined,
  })

  const first = controller.downloadLink(store, 'project-1', linkId)
  const second = controller.downloadLink(store, 'project-1', linkId)
  assert.equal(starts, 1)
  release({ task: task() })
  await Promise.all([first, second])
  assert.equal(store.getItem(linkId)?.link?.activeImportId, 'task-1')
})

test('отказ Vimeo при скачивании обновляет старую карточку до действия «Войти»', async () => {
  const store = new CanvasStore()
  const linkId = store.placeLink('https://vimeo.com/932447991')
  store.failLinkPreview(linkId, 'Не удалось прочитать Vimeo. Проверьте ссылку и доступность публикации')
  const login = new ApiError('Vimeo отдаёт видео только после входа в аккаунт', 'MEDIA_LINK_LOGIN_REQUIRED', 400)
  login.details = { provider: 'vimeo', sourceLabel: 'Vimeo' }
  const controller = createMediaLinkController({
    preview: async () => { throw new Error('превью не нужно') },
    start: async () => { throw login },
    track: () => { throw new Error('не должно быть задачи без доступа') },
  })
  const published: string[] = []
  store.subscribeMutations(event => published.push(event.mutation.type))

  await assert.rejects(controller.downloadLink(store, 'project-1', linkId), /Sign in to the source website/u)
  const link = store.getItem(linkId)?.link
  assert.equal(link?.state, 'error')
  assert.equal(link?.needsLogin, true)
  assert.equal(link?.provider, 'vimeo')
  assert.equal(link?.sourceLabel, 'Vimeo')
  assert.equal(link?.activeImportId, undefined)
  assert.equal(linkCardPresentation(link!).primaryAction, 'Sign in on Vimeo')
  assert.deepEqual(published, ['item.patch'], 'остальные участники видят обновлённую карточку сразу')
})

test('открытие доски дозапрашивает «не дождавшиеся» превью, но не настоящие отказы', async () => {
  const store = new CanvasStore()
  const loading = store.placeLink('https://youtu.be/loading')
  const ready = store.placeLink('https://youtu.be/ready')
  store.applyLinkPreview(ready, preview)
  const late = store.placeLink('https://youtu.be/late')
  store.failLinkPreview(late, PREVIEW_NO_ANSWER, { transient: true })
  // Карточка, сохранённая до признака, — с прежней фразой (жалоба 27.09.2026).
  const legacy = store.placeLink('https://youtu.be/legacy')
  store.failLinkPreview(legacy, LOCAL_SERVICE_UNAVAILABLE_MESSAGE)
  const refused = store.placeLink('https://youtu.be/private')
  store.failLinkPreview(refused, 'Не удалось прочитать YouTube. Проверьте ссылку и доступность публикации')
  const refreshed: string[] = []

  await refreshUnsettledLinkPreviews(store, {
    refreshLinkPreview: async (_store, id) => { refreshed.push(id) },
  } as MediaLinkController)

  assert.deepEqual(refreshed, [loading, late, legacy])
})

test('CanAI не ответил вовремя — карточка не выдаёт это за отказ ссылки и чинится повтором', async () => {
  const store = new CanvasStore()
  let answer: () => Promise<MediaLinkPreview> = async () => {
    throw new ApiError(LOCAL_SERVICE_UNAVAILABLE_MESSAGE, LOCAL_SERVICE_UNAVAILABLE)
  }
  const controller = createMediaLinkController({
    preview: () => answer(),
    start: async () => ({ task: task() }),
    track: () => undefined,
  })
  const id = await controller.previewPastedLink(store, 'https://youtu.be/slow')
  const failed = store.getItem(id)!.link!
  assert.equal(failed.error, PREVIEW_NO_ANSWER, 'не «CanAI временно недоступен»: приложение работало')
  assert.equal(failed.transientError, true)
  assert.equal(transientLinkError(failed), true)
  assert.equal(linkCardPresentation(failed).canRetryPreview, true)

  answer = async () => preview
  await controller.refreshLinkPreview(store, id, 'https://youtu.be/slow')
  const healed = store.getItem(id)!.link!
  assert.equal(healed.state, 'ready')
  assert.equal(healed.transientError, undefined, 'признак не переживает удачное превью')
  assert.equal(transientLinkError(healed), false)
})

test('семь ссылок разом — превью идут не больше чем по два, и доходят все', async () => {
  const store = new CanvasStore()
  let inFlight = 0
  let peak = 0
  const releases: Array<() => void> = []
  const controller = createMediaLinkController({
    preview: async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>((release) => releases.push(release))
      inFlight -= 1
      return preview
    },
    start: async () => ({ task: task() }),
    track: () => undefined,
  })
  const pasted = Array.from({ length: 7 }, (_, index) => (
    controller.previewPastedLink(store, `https://youtu.be/v${index}`)
  ))
  const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }
  await settle()
  assert.equal(releases.length, PREVIEW_PARALLEL, 'в пути ровно два запроса')
  while (releases.length) {
    releases.shift()!()
    await settle()
    assert.ok(inFlight <= PREVIEW_PARALLEL)
  }
  const ids = await Promise.all(pasted)
  assert.equal(peak, PREVIEW_PARALLEL)
  assert.ok(ids.every((id) => store.getItem(id)?.link?.state === 'ready'))
})

test('progress updates pending without adding history entries', () => {
  const store = new CanvasStore()
  const linkId = store.placeLink('https://cdn.test/post')
  store.applyLinkPreview(linkId, preview)
  store.reserveMediaImport(linkId, task())
  const progress = task('downloading')
  progress.items[0].downloadedBytes = 5
  progress.items[0].totalBytes = 10
  progress.items[0].percent = 50
  progress.items[0].stage = 'Скачивание'
  store.updateMediaImportProgress(progress)
  assert.equal(store.getPending()[0].percent, 50)
  const repeated: CanvasMutationEnvelope[] = []
  const unsubscribe = store.subscribeMutations((event) => repeated.push(event))
  store.updateMediaImportProgress(progress)
  unsubscribe()
  assert.deepEqual(repeated, [])
  assert.equal(store.undo(), true)
  assert.equal(store.getItem(linkId), undefined)
})

test('terminal mixed result replaces successes together and leaves failed cards', async () => {
  const store = new CanvasStore()
  const linkId = store.placeLink('https://cdn.test/post')
  store.applyLinkPreview(linkId, preview)
  store.reserveMediaImport(linkId, task())
  const complete = task('completed')
  complete.items[0] = {
    ...complete.items[0], status: 'completed',
    result: { url: '/media/one.png', mime: 'image/png', name: 'one.png', width: 400, height: 400 },
  }
  complete.items[1] = { ...complete.items[1], status: 'error', error: 'Видео недоступно' }
  await store.completeMediaImport(complete)
  assert.equal(store.getItems().filter((item) => item.kind === 'image').length, 1)
  assert.equal(store.getPending().length, 1)
  assert.equal(store.getPending()[0].status, 'error')
  assert.match(store.getPending()[0].error ?? '', /Видео недоступно/)
  assert.equal(store.getItem(linkId)?.link?.downloadedItemIds?.one !== undefined, true)
})

test('one undo removes successful group and link mappings but keeps the link card', async () => {
  const store = new CanvasStore()
  const linkId = store.placeLink('https://cdn.test/post')
  store.applyLinkPreview(linkId, preview)
  store.reserveMediaImport(linkId, task())
  const complete = task('completed')
  complete.items = complete.items.map((item, index) => ({
    ...item,
    status: 'completed',
    result: {
      url: `/media/${item.id}.${index ? 'mp4' : 'png'}`,
      mime: index ? 'video/mp4' : 'image/png',
      name: item.id,
      width: index ? 1600 : 400,
      height: index ? 900 : 400,
    },
  }))
  await store.completeMediaImport(complete)
  assert.equal(store.getItems().length, 3)
  assert.equal(store.undo(), true)
  assert.equal(store.getItems().length, 1)
  assert.equal(store.getItem(linkId)?.kind, 'link')
  assert.deepEqual(store.getItem(linkId)?.link?.downloadedItemIds ?? {}, {})
})

test('repeat download copies existing result without starting the API', async () => {
  const { store, linkId } = readyStoreWithDownloadedEntries(['one'])
  let starts = 0
  const controller = createMediaLinkController({
    preview: async () => preview,
    start: async () => { starts++; return { task: task() } },
    track: () => undefined,
  })

  await controller.downloadLink(store, 'project-1', linkId, ['one'])

  assert.equal(starts, 0)
  assert.equal(store.getItems().filter((item) => item.kind === 'image').length, 2)
  assert.notEqual(store.getItem(linkId)?.link?.downloadedItemIds?.one, 'canvas-one')
  assert.equal(store.undo(), true)
  assert.equal(store.getItems().filter((item) => item.kind === 'image').length, 1)
  assert.equal(store.getItem(linkId)?.link?.downloadedItemIds?.one, 'canvas-one')
})

test('repeat download starts missing entry after its canvas item was deleted', async () => {
  const { store, linkId } = readyStoreWithDownloadedEntries(['one'])
  store.removeItems(['canvas-one'])
  const requested: Array<string[] | undefined> = []

  await controllerRecordingStarts(requested).downloadLink(store, 'project-1', linkId, ['one'])

  assert.deepEqual(requested, [['one']])
})

test('mixed repeat copies existing entries and downloads missing entries', async () => {
  const { store, linkId } = readyStoreWithDownloadedEntries(['one'])
  const requested: Array<string[] | undefined> = []

  await controllerRecordingStarts(requested).downloadLink(store, 'project-1', linkId)

  assert.equal(store.getItems().filter((item) => item.kind === 'image').length, 2)
  assert.deepEqual(requested, [['two']])
})

test('delete, archive and redo cancel removed active imports, board load does not', () => {
  const cancelled: string[] = []
  const unregister = registerMediaImportCancelHandler((id) => cancelled.push(id))
  try {
    const removed = new CanvasStore()
    const removedId = removed.placeLink('https://cdn.test/remove')
    removed.updateItem(removedId, { link: { ...removed.getItem(removedId)!.link!, activeImportId: 'remove-task' } }, false)
    removed.removeItems([removedId])

    const archived = new CanvasStore()
    const archivedId = archived.placeLink('https://cdn.test/archive')
    archived.updateItem(archivedId, { link: { ...archived.getItem(archivedId)!.link!, activeImportId: 'archive-task' } }, false)
    archived.archiveItems([archivedId])

    const history = new CanvasStore()
    const historyId = history.placeLink('https://cdn.test/history')
    history.updateItem(historyId, { link: { ...history.getItem(historyId)!.link!, activeImportId: 'history-task' } }, false)
    history.addItem({ kind: 'text', x: 0, y: 0, w: 100, h: 100, text: 'шаг' })
    history.updateItem(historyId, { link: { ...history.getItem(historyId)!.link!, activeImportId: undefined } }, false)
    history.undo()
    history.redo()

    const loaded = new CanvasStore()
    loaded.loadDoc(history.toDoc())
    assert.deepEqual(cancelled, ['remove-task', 'archive-task', 'history-task'])
  } finally {
    unregister()
  }
})

test('ход скачивания в общую доску не уезжает — только статус и стадия (3.8, С-8)', () => {
  const store = new CanvasStore()
  const linkId = store.placeLink('https://cdn.test/post')
  store.applyLinkPreview(linkId, preview)
  store.reserveMediaImport(linkId, task())
  const sent: CanvasMutationEnvelope[] = []
  const unsubscribe = store.subscribeMutations((event) => sent.push(event))

  // Стадия сменилась — коллегам это видно.
  const started = task('downloading')
  started.items[0].stage = 'Скачивание'
  store.updateMediaImportProgress(started)
  const stagePatches = sent.length
  assert.ok(stagePatches > 0, 'смена стадии уехала на доску')
  assert.ok(sent.every((event) => JSON.stringify(event).includes('stage') || JSON.stringify(event).includes('status')))

  // Байты и проценты раз в 0,8 с — только на своём экране.
  for (let step = 1; step <= 5; step += 1) {
    const progress = task('downloading')
    progress.items[0].stage = 'Скачивание'
    progress.items[0].downloadedBytes = step * 10
    progress.items[0].totalBytes = 100
    progress.items[0].percent = step * 10
    store.updateMediaImportProgress(progress)
  }
  unsubscribe()
  assert.equal(sent.length, stagePatches, 'счётчики не будили коллег')
  assert.equal(store.getPending()[0].percent, 50, 'а у себя ход виден')
})

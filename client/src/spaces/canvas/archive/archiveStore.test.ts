import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from '../konva/canvasStore'
import { sanitizeArchive } from '../konva/archive'
import type { CanvasDoc } from '../konva/types'

function storeWithTwoImages(): { store: CanvasStore; first: string; second: string } {
  const store = new CanvasStore()
  const first = store.addItem({ kind: 'image', x: 0, y: 0, w: 200, h: 200, src: '/media/a.png', name: 'первая' })
  const second = store.addItem({ kind: 'image', x: 400, y: 0, w: 200, h: 200, src: '/media/b.png', name: 'вторая' })
  return { store, first, second }
}

test('отправка в архив снимает объекты с холста и снимает с них выделение', () => {
  const { store, first, second } = storeWithTwoImages()
  store.setSelection([first, second])

  assert.equal(store.archiveItems([first, second]), 2)
  assert.equal(store.getItems().length, 0)
  assert.equal(store.getArchive().length, 2)
  assert.equal(store.getSelectedIds().size, 0)
  assert.ok(store.getArchive().every((entry) => entry.archivedAt > 0))
})

test('Ctrl+Z возвращает объект на холст и убирает его из архива (id не живёт в двух местах)', () => {
  const { store, first } = storeWithTwoImages()
  store.archiveItems([first])

  store.undo()
  assert.equal(store.getArchive().length, 0)
  assert.deepEqual(store.getItems().map((i) => i.id).sort(), [...new Set(store.getItems().map((i) => i.id))].sort())
  assert.ok(store.getItems().some((i) => i.id === first))

  store.redo()
  assert.equal(store.getArchive().length, 1)
  assert.ok(!store.getItems().some((i) => i.id === first))
})

test('возврат на холст ставит объект на прежнее место и выделяет его', () => {
  const { store, first } = storeWithTwoImages()
  store.archiveItems([first])

  const [restored] = store.restoreArchived([first])
  const item = store.getItem(restored)
  assert.ok(item)
  assert.equal(item.x, 0)
  assert.equal(item.y, 0)
  assert.equal(item.name, 'первая')
  assert.equal(store.getArchive().length, 0)
  assert.deepEqual([...store.getSelectedIds()], [restored])
})

test('если прежнее место занято, возвращённый объект встаёт рядом, а не поверх', () => {
  const { store, first } = storeWithTwoImages()
  store.archiveItems([first])
  // на освободившееся место кладём другой объект
  store.addItem({ kind: 'image', x: 0, y: 0, w: 200, h: 200, src: '/media/c.png' })

  const [restored] = store.restoreArchived([first])
  const item = store.getItem(restored)
  assert.ok(item)
  assert.ok(item.x > 0, 'объект сдвинулся вправо от занятого места')
})

test('удаление из архива — отдельный шаг истории, Ctrl+Z его отменяет', () => {
  const { store, first } = storeWithTwoImages()
  store.archiveItems([first])

  assert.equal(store.removeArchived([first]), 1)
  assert.equal(store.getArchive().length, 0)

  store.undo()
  assert.equal(store.getArchive().length, 1)
  assert.equal(store.getItems().length, 1, 'холст при этом не изменился')
})

test('архив переживает сохранение и загрузку доски', () => {
  const { store, first } = storeWithTwoImages()
  store.archiveItems([first])
  const doc = store.toDoc()

  const reopened = new CanvasStore()
  reopened.loadDoc(doc)
  assert.equal(reopened.getArchive().length, 1)
  assert.equal(reopened.getArchive()[0].src, '/media/a.png')

  reopened.loadDoc(null)
  assert.equal(reopened.getArchive().length, 0)
})

test('в архив доски не пускаем base64 — только ссылки /media/ и текст', () => {
  const cleaned = sanitizeArchive([
    { id: '1', kind: 'image', src: 'data:image/png;base64,AAA', x: 0, y: 0, w: 10, h: 10, archivedAt: 1 },
    { id: '2', kind: 'image', src: '/media/ok.png', x: 0, y: 0, w: 10, h: 10, archivedAt: 1 },
    { id: '3', kind: 'text', text: 'привет', x: 0, y: 0, w: 10, h: 10, archivedAt: 1 },
    { id: '4', kind: 'image', x: 0, y: 0, w: 10, h: 10, archivedAt: 1 },
    { kind: 'image', src: '/media/no-id.png' },
    null,
  ])
  assert.deepEqual(cleaned.map((entry) => entry.id), ['2', '3'])
})

test('архив принимает безопасную карточку ссылки и отбрасывает битую', () => {
  const validLink = {
    url: 'https://www.youtube.com/watch?v=test',
    normalizedUrl: 'https://www.youtube.com/watch?v=test',
    provider: 'youtube',
    sourceLabel: 'YouTube',
    title: 'Ролик',
    entries: [],
    state: 'ready',
  }
  const cleaned = sanitizeArchive([
    { id: 'link-ok', kind: 'link', link: validLink, x: 0, y: 0, w: 320, h: 280, archivedAt: 1 },
    { id: 'link-bad', kind: 'link', link: { ...validLink, url: 'file:///secret' }, x: 0, y: 0, w: 320, h: 280, archivedAt: 1 },
  ])

  assert.deepEqual(cleaned.map((entry) => entry.id), ['link-ok'])
})

test('битый архив в файле доски не роняет загрузку', () => {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, items: [], camera: { x: 0, y: 0, scale: 1 }, archive: 'мусор' } as unknown as CanvasDoc)
  assert.deepEqual(store.getArchive(), [])
})

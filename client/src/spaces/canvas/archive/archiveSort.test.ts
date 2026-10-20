import assert from 'node:assert/strict'
import test from 'node:test'
import type { ArchivedItem } from '../konva/types'
import { OBJECTS, pluralWithCount } from '../../../ui/plural'
import { filterArchive, formatBytes, sortArchive } from './archiveSort'

function entry(patch: Partial<ArchivedItem> & { id: string }): ArchivedItem {
  return {
    kind: 'image',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    archivedAt: 0,
    src: `/media/${patch.id}.png`,
    ...patch,
  }
}

const cat = entry({ id: 'a', name: 'Кот на крыше', archivedAt: 100 })
const dog = entry({ id: 'b', name: 'Пёс', archivedAt: 300, prompt: 'портрет собаки, seedance' })
const note = entry({ id: 'c', kind: 'text', src: undefined, text: 'заметка про кота', archivedAt: 200 })
const clip = entry({ id: 'd', kind: 'video', name: 'Ролик', archivedAt: 50 })
const link = entry({
  id: 'e',
  kind: 'link',
  src: undefined,
  archivedAt: 25,
  link: {
    url: 'https://youtu.be/abc',
    normalizedUrl: 'https://youtu.be/abc',
    provider: 'youtube',
    sourceLabel: 'YouTube',
    title: 'Ссылка на ролик',
    state: 'ready',
    entries: [],
  },
})

test('сортировка по дате: сначала новые и сначала старые', () => {
  const list = [cat, dog, note, clip]
  assert.deepEqual(sortArchive(list, 'new').map((e) => e.id), ['b', 'c', 'a', 'd'])
  assert.deepEqual(sortArchive(list, 'old').map((e) => e.id), ['d', 'a', 'c', 'b'])
})

test('сортировка не мутирует исходный список', () => {
  const list = [cat, dog]
  sortArchive(list, 'old')
  assert.deepEqual(list.map((e) => e.id), ['a', 'b'])
})

test('сортировка по типу: картинки, видео, текст, ссылки', () => {
  const ids = sortArchive([link, note, clip, cat], 'kind').map((e) => e.id)
  assert.deepEqual(ids, ['a', 'd', 'c', 'e'])
})

test('сортировка по размеру: известные байты по убыванию, неизвестные — в конец', () => {
  const sizes = new Map([
    ['/media/a.png', 1_000],
    ['/media/d.png', 5_000],
  ])
  const ids = sortArchive([cat, dog, clip], 'size', sizes).map((e) => e.id)
  assert.deepEqual(ids, ['d', 'a', 'b'])
})

test('поиск идёт по имени, тексту и промпту, все слова должны совпасть', () => {
  assert.deepEqual(filterArchive([cat, dog, note, clip], 'кот').map((e) => e.id), ['a', 'c'])
  assert.deepEqual(filterArchive([cat, dog, note, clip], 'seedance').map((e) => e.id), ['b'])
  assert.deepEqual(filterArchive([cat, dog], 'кот крыше').map((e) => e.id), ['a'])
  assert.equal(filterArchive([cat, dog], '   ').length, 2)
})

test('object counts use English plurals', () => {
  assert.equal(pluralWithCount(1, OBJECTS), '1 object')
  assert.equal(pluralWithCount(3, OBJECTS), '3 objects')
  assert.equal(pluralWithCount(5, OBJECTS), '5 objects')
  assert.equal(pluralWithCount(11, OBJECTS), '11 objects')
  assert.equal(pluralWithCount(21, OBJECTS), '21 objects')
  assert.equal(pluralWithCount(112, OBJECTS), '112 objects')
  assert.equal(pluralWithCount(0, OBJECTS), '0 objects')
})

test('размер файла читается по-человечески', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(900), '900 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
})

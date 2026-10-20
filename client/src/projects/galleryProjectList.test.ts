// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import type { ProjectMeta } from '../api'
import {
  mergeGalleryProjects,
  visibleGalleryProjects,
  visibleProjects,
} from './galleryProjectList'

type PinnedProject = ProjectMeta & { pinned: boolean }

const ids = (projects: ProjectMeta[]) => projects.map((project) => project.id)

test('merges local boards without changing ids or editability', () => {
  const local: ProjectMeta = { id: 'same', name: 'Локальная', createdAt: 1, updatedAt: 10 }
  const list = mergeGalleryProjects([local])

  assert.deepEqual(list.map((item) => `${item.ref.source}:${item.ref.id}`), ['local:same'])
  assert.equal(list[0]?.availability, 'editable')
  assert.equal(list[0]?.local?.name, 'Локальная')
})

test('filters the local gallery by source and trimmed case-insensitive search', () => {
  const local: ProjectMeta = { id: 'local', name: 'Альфа', createdAt: 1, updatedAt: 10 }
  const list = mergeGalleryProjects([local])

  assert.deepEqual(
    visibleGalleryProjects(list, '', 'recent', 'local').map((item) => item.name),
    ['Альфа'],
  )
  assert.deepEqual(
    visibleGalleryProjects(list, '  альфа ', 'recent', 'all').map((item) => item.name),
    ['Альфа'],
  )
})

test('does not let a pinned local board lose priority in the gallery sort', () => {
  const local = { id: 'local', name: 'Локальная', createdAt: 1, updatedAt: 1, pinned: true } as ProjectMeta
  const list = mergeGalleryProjects([local])

  assert.equal(visibleGalleryProjects(list, '', 'recent', 'all')[0]?.ref.source, 'local')
})

test('sorts pinned boards by updated date', () => {
  const projects = [
    { id: 'regular-old', name: 'Гамма', pinned: false, createdAt: 1, updatedAt: 10 },
    { id: 'pin-old', name: 'Бета', pinned: true, createdAt: 2, updatedAt: 20 },
    { id: 'regular-tie', name: 'Дельта', pinned: false, createdAt: 3, updatedAt: 10 },
    { id: 'pin-recent', name: 'Альфа', pinned: true, createdAt: 4, updatedAt: 40 },
    { id: 'regular-recent', name: 'Бета', pinned: false, createdAt: 5, updatedAt: 30 },
  ] as PinnedProject[]

  assert.deepEqual(ids(visibleProjects(projects, '', 'recent')), [
    'pin-recent',
    'pin-old',
    'regular-recent',
    'regular-old',
    'regular-tie',
  ])
})

test('sorts pinned boards by name without case sensitivity', () => {
  const projects = [
    { id: 'regular-gamma', name: 'Гамма', pinned: false, createdAt: 1, updatedAt: 1 },
    { id: 'pin-beta', name: 'бета', pinned: true, createdAt: 2, updatedAt: 2 },
    { id: 'regular-beta', name: 'Бета', pinned: false, createdAt: 3, updatedAt: 3 },
    { id: 'pin-alpha', name: 'Альфа', pinned: true, createdAt: 4, updatedAt: 4 },
    { id: 'regular-alpha', name: 'альфа', pinned: false, createdAt: 5, updatedAt: 5 },
  ] as PinnedProject[]

  assert.deepEqual(ids(visibleProjects(projects, '', 'name')), [
    'pin-alpha',
    'pin-beta',
    'regular-alpha',
    'regular-beta',
    'regular-gamma',
  ])
})

test('puts the most recently updated board first when names tie', () => {
  const projects = [
    { id: 'pin-a-old', name: 'Альфа', pinned: true, createdAt: 1, updatedAt: 10 },
    { id: 'regular-a-old', name: 'Альфа', pinned: false, createdAt: 2, updatedAt: 20 },
    { id: 'pin-z-new', name: 'Альфа', pinned: true, createdAt: 3, updatedAt: 40 },
    { id: 'regular-z-new', name: 'Альфа', pinned: false, createdAt: 4, updatedAt: 50 },
  ] as PinnedProject[]

  assert.deepEqual(ids(visibleProjects(projects, '', 'name')), [
    'pin-z-new',
    'pin-a-old',
    'regular-z-new',
    'regular-a-old',
  ])
})

test('sorts pinned boards by creation date', () => {
  const projects = [
    { id: 'regular-mid', name: 'Бета', pinned: false, createdAt: 30, updatedAt: 1 },
    { id: 'pin-old', name: 'Гамма', pinned: true, createdAt: 20, updatedAt: 2 },
    { id: 'regular-old', name: 'Дельта', pinned: false, createdAt: 10, updatedAt: 3 },
    { id: 'pin-new', name: 'Альфа', pinned: true, createdAt: 50, updatedAt: 4 },
    { id: 'regular-new', name: 'альфа', pinned: false, createdAt: 40, updatedAt: 5 },
  ] as PinnedProject[]

  assert.deepEqual(ids(visibleProjects(projects, '', 'created')), [
    'pin-new',
    'pin-old',
    'regular-new',
    'regular-mid',
    'regular-old',
  ])
})

test('uses updated date as tie-breaker when creation dates match', () => {
  const projects = [
    { id: 'pin-a-old', name: 'Бета', pinned: true, createdAt: 10, updatedAt: 10 },
    { id: 'regular-a-old', name: 'Гамма', pinned: false, createdAt: 20, updatedAt: 20 },
    { id: 'pin-z-new', name: 'Альфа', pinned: true, createdAt: 10, updatedAt: 40 },
    { id: 'regular-z-new', name: 'Дельта', pinned: false, createdAt: 20, updatedAt: 50 },
  ] as PinnedProject[]

  assert.deepEqual(ids(visibleProjects(projects, '', 'created')), [
    'pin-z-new',
    'pin-a-old',
    'regular-z-new',
    'regular-a-old',
  ])
})

test('searches by a trimmed query without case sensitivity', () => {
  const projects = [
    { id: 'match', name: 'Моя Альфа', pinned: false, createdAt: 1, updatedAt: 1 },
    { id: 'other', name: 'Бета', pinned: true, createdAt: 2, updatedAt: 2 },
  ] as PinnedProject[]

  assert.deepEqual(ids(visibleProjects(projects, '  аЛьФА  ', 'recent')), ['match'])
})

test('does not mutate the input array', () => {
  const projects = [
    { id: 'regular', name: 'Бета', pinned: false, createdAt: 1, updatedAt: 1 },
    { id: 'pin', name: 'Альфа', pinned: true, createdAt: 2, updatedAt: 2 },
  ] as PinnedProject[]

  visibleProjects(projects, '', 'recent')

  assert.deepEqual(ids(projects), ['regular', 'pin'])
})

test('treats legacy metadata without pinned as unpinned', () => {
  const projects: ProjectMeta[] = [
    { id: 'legacy-b', name: 'Бета', createdAt: 1, updatedAt: 10 },
    { id: 'pin', name: 'Гамма', createdAt: 2, updatedAt: 1, pinned: true } as PinnedProject,
    { id: 'legacy-a', name: 'Альфа', createdAt: 3, updatedAt: 10 },
  ]

  assert.deepEqual(ids(visibleProjects(projects, '', 'recent')), ['pin', 'legacy-a', 'legacy-b'])
})

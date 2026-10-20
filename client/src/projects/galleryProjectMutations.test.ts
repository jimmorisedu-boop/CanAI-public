// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import type { ProjectMeta } from '../api'
import {
  finishPendingProjectPin,
  planProjectPin,
  planProjectRemoval,
  planProjectRename,
  rollbackProjectPin,
  rollbackProjectRemoval,
  rollbackProjectRename,
  startPendingProjectPin,
} from './galleryProjectMutations'

const projects = [
  { id: 'one', name: 'Первая', updatedAt: 1, pinned: false },
  { id: 'two', name: 'Вторая', updatedAt: 2, pinned: false },
] as ProjectMeta[]

test('закрепление меняет только выбранную доску и сохраняет исходный массив для отката', () => {
  const plan = planProjectPin(projects, 'one', true)

  assert.equal(plan.next[0]?.pinned, true)
  assert.equal(plan.next[1], projects[1])
  assert.equal(plan.rollback, projects)
})

test('параллельные закрепления хранят независимые pending ID и локальный откат не стирает другую доску', () => {
  let pending = startPendingProjectPin(new Set(), 'one')
  pending = startPendingProjectPin(pending, 'two')

  assert.deepEqual([...pending], ['one', 'two'])

  const afterFirst = planProjectPin(projects, 'one', true).next
  const afterBoth = planProjectPin(afterFirst, 'two', true).next
  const afterFirstRollback = rollbackProjectPin(afterBoth, 'one', false)

  assert.deepEqual(afterFirstRollback.map((project) => project.pinned), [false, true])

  const bothPending = pending
  pending = finishPendingProjectPin(pending, 'one')
  assert.deepEqual([...bothPending], ['one', 'two'])
  assert.deepEqual([...pending], ['two'])
  assert.notEqual(pending, bothPending)
})

test('переименование имеет точный локальный откат без повторной загрузки', () => {
  const plan = planProjectRename(projects, 'one', 'Новое имя')

  assert.equal(plan.next[0]?.name, 'Новое имя')
  assert.deepEqual(plan.rollback, projects)
})

test('откат переименования возвращает только имя и сохраняет текущие поля обеих досок', () => {
  const current = [
    { ...projects[0], name: 'Новое имя', pinned: true, updatedAt: 90 },
    { ...projects[1], pinned: true, updatedAt: 80 },
  ] as ProjectMeta[]

  const restored = rollbackProjectRename(current, 'one', 'Первая')

  assert.deepEqual(restored[0], {
    id: 'one', name: 'Первая', updatedAt: 90, pinned: true,
  })
  assert.equal(restored[1], current[1])
})

test('удаление имеет точный локальный откат с сохранением порядка', () => {
  const plan = planProjectRemoval(projects, 'one')

  assert.deepEqual(plan.next.map((project) => project.id), ['two'])
  assert.deepEqual(plan.rollback, projects)
})

test('откат удаления вставляет только удалённую доску и не затирает параллельные изменения', () => {
  const removed = { id: 'two', name: 'Вторая', updatedAt: 2, pinned: false } as ProjectMeta
  const current = [
    { id: 'one', name: 'Первая', updatedAt: 10, pinned: true },
    { id: 'three', name: 'Третья', updatedAt: 30, pinned: true },
  ] as ProjectMeta[]
  const restored = rollbackProjectRemoval(current, removed, 1)
  const restoredAgain = rollbackProjectRemoval(restored, removed, 1)

  assert.deepEqual(restored.map((project) => project.id), ['one', 'two', 'three'])
  assert.equal(restored[0], current[0])
  assert.equal(restored[2], current[1])
  assert.deepEqual(restoredAgain.map((project) => project.id), ['one', 'two', 'three'])
})

// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import type { ProjectMeta } from '../api'
import { clearRestoredUndoProject } from './projectUndoModel'

function project(id: string): ProjectMeta {
  return { id, name: id, createdAt: 1, updatedAt: 2 }
}

test('восстановление той же доски очищает undo-состояние', () => {
  assert.equal(clearRestoredUndoProject(project('board-1'), 'board-1'), null)
})

test('восстановление другой доски сохраняет актуальное undo-состояние', () => {
  const current = project('board-1')

  assert.equal(clearRestoredUndoProject(current, 'board-2'), current)
})

test('пустое undo-состояние остаётся пустым', () => {
  assert.equal(clearRestoredUndoProject(null, 'board-1'), null)
})

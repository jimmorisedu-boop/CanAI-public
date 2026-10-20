import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveExternalEditNavigation } from './externalEditNavigation.js'

test('находит точную активную доску', async () => {
  const result = await resolveExternalEditNavigation('board-b', {
    listProjects: async () => ({ projects: [{ id: 'board-a', name: 'A' }, { id: 'board-b', name: 'B' }] }),
    listProjectTrash: async () => ({ projects: [{ id: 'board-c', name: 'C', trashedAt: 1 }] }),
  })
  assert.equal(result.kind, 'active')
  if (result.kind === 'active') assert.equal(result.project.id, 'board-b')
})

test('не открывает другую активную доску вместо нужной корзины', async () => {
  const result = await resolveExternalEditNavigation('board-c', {
    listProjects: async () => ({ projects: [{ id: 'board-a', name: 'A' }] }),
    listProjectTrash: async () => ({ projects: [{ id: 'board-c', name: 'C', trashedAt: 1 }] }),
  })
  assert.equal(result.kind, 'trash')
})

test('отличает окончательно отсутствующую доску от сетевой ошибки', async () => {
  const missing = await resolveExternalEditNavigation('gone', {
    listProjects: async () => ({ projects: [] }),
    listProjectTrash: async () => ({ projects: [] }),
  })
  assert.deepEqual(missing, { kind: 'missing' })

  const failed = await resolveExternalEditNavigation('gone', {
    listProjects: async () => { throw new Error('offline') },
    listProjectTrash: async () => ({ projects: [] }),
  })
  assert.equal(failed.kind, 'error')
})

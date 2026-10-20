import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectMeta } from '../api.js'
import { activeLocalProject, requestedProjectRef } from './activeProject.js'

const local: ProjectMeta = {
  id: 'same', name: 'Локальная', createdAt: 1, updatedAt: 2, pinned: false,
}

test('active project keeps local source, name, and edit capabilities', () => {
  const active = activeLocalProject(local)

  assert.deepEqual(active.ref, { source: 'local', id: 'same' })
  assert.equal(active.name, 'Локальная')
  assert.equal(active.canEdit, true)
  assert.deepEqual(active.capabilities, {
    canRead: true,
    canComment: true,
    canEdit: true,
    canRename: true,
    canGenerate: true,
    canManage: true,
    canManageMembers: false,
    canArchive: true,
    canCopy: true,
    canPublish: false,
  })
})

test('local board links keep the local source and reject remote keys', () => {
  assert.deepEqual(requestedProjectRef('local:same'), { source: 'local', id: 'same' })
  assert.deepEqual(requestedProjectRef('legacy-id'), { source: 'local', id: 'legacy-id' })
  assert.throws(() => requestedProjectRef(''), /Empty board ID/)
  assert.throws(() => requestedProjectRef('cloud:same'), /Only local board links are available/)
  assert.throws(() => requestedProjectRef('local:one:two'), /Only local board links are available/)
})

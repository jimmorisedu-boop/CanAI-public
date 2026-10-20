import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../api'
import {
  createProjectConflictSnapshot,
  parseProjectConflictError,
} from './projectConflict'

test('conflict recovery freezes a detached local snapshot and saved copy metadata', () => {
  const local = {
    version: 1 as const,
    items: [{ id: 'one', kind: 'text' as const, x: 0, y: 0, w: 100, h: 40, text: 'one' }],
    camera: { x: 0, y: 0, scale: 1 },
  }
  const recoveryProject = { id: 'conflict-safe', name: 'Моя копия', revision: 0 }
  const conflict = createProjectConflictSnapshot(local, 7, recoveryProject, 'saved')
  local.items[0].id = 'changed'
  recoveryProject.name = 'changed'
  assert.equal(conflict.local.items[0].id, 'one')
  assert.equal(conflict.serverRevision, 7)
  assert.equal(conflict.recoveryProject?.name, 'Моя копия')
  assert.equal(conflict.status, 'saved')
})

test('project conflict parser accepts only complete durable recovery metadata', () => {
  const apiError = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
  apiError.details = {
    serverRevision: 7,
    recoveryProject: {
      id: 'conflict-9b2ca32f-c155-4c5e-b5db-8273070710de',
      name: 'Копия',
      revision: 0,
    },
  }

  assert.deepEqual(parseProjectConflictError(apiError), apiError.details)
})

test('project conflict parser rejects malformed and unrelated errors', () => {
  const broken = new ApiError('conflict', 'PROJECT_CONFLICT', 409)
  broken.details = {
    serverRevision: 7,
    recoveryProject: { id: '../bad', name: '', revision: -1 },
  }
  assert.equal(parseProjectConflictError(broken), null)

  const unrelated = new ApiError('conflict', 'OTHER_CONFLICT', 409)
  unrelated.details = {
    serverRevision: 7,
    recoveryProject: { id: 'conflict-safe', name: 'Копия', revision: 0 },
  }
  assert.equal(parseProjectConflictError(unrelated), null)
})

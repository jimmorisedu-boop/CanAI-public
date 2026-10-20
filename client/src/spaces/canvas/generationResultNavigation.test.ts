import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectMeta, TrashedProjectMeta } from '../../api'
import type { ProjectRef } from '../../types'
import {
  registerGenerationResultNavigationSink,
  requestGenerationResultNavigation,
  resolveGenerationResultProject,
  sameBoard,
  shouldDismissGenerationResultNavigationError,
} from './generationResultNavigation'

function project(id: string, name = id): ProjectMeta {
  return { id, name, createdAt: 1, updatedAt: 2 }
}

function trashedProject(id: string, name = id): TrashedProjectMeta {
  return { ...project(id, name), trashedAt: 3 }
}

function local(id: string): ProjectRef {
  return { source: 'local', id }
}

test('resolves an active local project without consulting trash', async () => {
  let trashCalls = 0
  const result = await resolveGenerationResultProject(local('project-2'), {
    listProjects: async () => ({ projects: [project('project-1'), project('project-2', 'Нужная')] }),
    listProjectTrash: async () => {
      trashCalls++
      return { projects: [] }
    },
  })

  assert.deepEqual(result, { kind: 'active', project: project('project-2', 'Нужная') })
  assert.equal(trashCalls, 0)
})

test('resolves a local project from trash after checking active projects', async () => {
  const result = await resolveGenerationResultProject(local('project-2'), {
    listProjects: async () => ({ projects: [project('project-1')] }),
    listProjectTrash: async () => ({ projects: [trashedProject('project-2', 'Удалённая')] }),
  })

  assert.deepEqual(result, { kind: 'trash', project: trashedProject('project-2', 'Удалённая') })
})

test('reports a permanently missing local project only after both lists succeeded', async () => {
  const result = await resolveGenerationResultProject(local('project-gone'), {
    listProjects: async () => ({ projects: [] }),
    listProjectTrash: async () => ({ projects: [] }),
  })

  assert.deepEqual(result, { kind: 'missing' })
})

test('keeps a project-list network failure distinct from permanent deletion', async () => {
  const result = await resolveGenerationResultProject(local('project-2'), {
    listProjects: async () => { throw new Error('Сервер недоступен') },
    listProjectTrash: async () => ({ projects: [] }),
  })

  assert.deepEqual(result, { kind: 'network-error', message: 'Сервер недоступен' })
})

test('translates a raw browser fetch failure into a useful local-service message', async () => {
  const result = await resolveGenerationResultProject(local('project-2'), {
    listProjects: async () => { throw new TypeError('Failed to fetch') },
    listProjectTrash: async () => ({ projects: [] }),
  })

  assert.deepEqual(result, {
    kind: 'network-error',
    message: 'Failed to contact local server',
  })
})

test('keeps a trash-list network failure distinct from permanent deletion', async () => {
  const result = await resolveGenerationResultProject(local('project-2'), {
    listProjects: async () => ({ projects: [] }),
    listProjectTrash: async () => { throw 'offline' },
  })

  assert.deepEqual(result, {
    kind: 'network-error',
    message: 'Failed to check if board is available',
  })
})

test('parks the latest navigation command until the app registers its sink', () => {
  const received: unknown[] = []

  requestGenerationResultNavigation({ projectRef: local('project-old'), jobIds: ['job-old'] })
  requestGenerationResultNavigation({ projectRef: local('project-new'), jobIds: ['job-1', 'job-2'] })
  const unregister = registerGenerationResultNavigationSink((request) => received.push(request))

  assert.deepEqual(received, [{ projectRef: local('project-new'), jobIds: ['job-1', 'job-2'] }])
  unregister()
})

test('resolved project states invalidate an earlier navigation error', () => {
  assert.equal(shouldDismissGenerationResultNavigationError({ kind: 'active', project: project('active') }), true)
  assert.equal(shouldDismissGenerationResultNavigationError({ kind: 'trash', project: trashedProject('trash') }), true)
  assert.equal(shouldDismissGenerationResultNavigationError({ kind: 'missing' }), true)
})

test('another network failure keeps the retry error visible', () => {
  assert.equal(shouldDismissGenerationResultNavigationError({ kind: 'network-error', message: 'offline' }), false)
})

/** A board is already open: compare its local source and id before moving the camera. */
test('the current board is recognized by source and identifier', () => {
  assert.equal(sameBoard(local('a'), local('a')), true)
  assert.equal(sameBoard(local('a'), local('b')), false)
  assert.equal(sameBoard(null, local('a')), false)
  assert.equal(sameBoard(local('a'), null), false)
})

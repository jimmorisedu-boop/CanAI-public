import assert from 'node:assert/strict'
import test from 'node:test'
import { registerProjectTrashSink, requestProjectTrash } from './projectTrashBus'

test('delivers a trash request made before the gallery mounts', () => {
  const received: unknown[] = []

  requestProjectTrash({ projectId: 'project-7' })
  const unregister = registerProjectTrashSink((request) => received.push(request))

  assert.deepEqual(received, [{ projectId: 'project-7' }])
  unregister()
})

test('keeps only the latest parked trash request', () => {
  const received: unknown[] = []

  requestProjectTrash({ projectId: 'project-old' })
  requestProjectTrash({ projectId: 'project-new' })
  const unregister = registerProjectTrashSink((request) => received.push(request))

  assert.deepEqual(received, [{ projectId: 'project-new' }])
  unregister()
})

test('delivers requests immediately while the gallery is mounted', () => {
  const received: unknown[] = []
  const unregister = registerProjectTrashSink((request) => received.push(request))

  requestProjectTrash({ projectId: 'project-live' })

  assert.deepEqual(received, [{ projectId: 'project-live' }])
  unregister()
})

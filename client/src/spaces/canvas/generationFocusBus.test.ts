import assert from 'node:assert/strict'
import test from 'node:test'
import {
  registerGenerationFocusSink,
  requestGenerationFocus,
} from './generationFocusBus'

test('delivers a focus request immediately to the matching active project', () => {
  const received: unknown[] = []
  const unregister = registerGenerationFocusSink('project-1', (request) => received.push(request))

  requestGenerationFocus({ projectId: 'project-1', jobIds: ['job-1', 'job-2'] })

  assert.deepEqual(received, [{ projectId: 'project-1', jobIds: ['job-1', 'job-2'] }])
  unregister()
})

test('parks a request until its project registers a focus sink', () => {
  const received: unknown[] = []

  requestGenerationFocus({ projectId: 'project-2', jobIds: ['job-4'] })
  const unregister = registerGenerationFocusSink('project-2', (request) => received.push(request))

  assert.deepEqual(received, [{ projectId: 'project-2', jobIds: ['job-4'] }])
  unregister()
})

test('keeps only the latest parked request for each project', () => {
  const received: unknown[] = []

  requestGenerationFocus({ projectId: 'project-3', jobIds: ['job-old'] })
  requestGenerationFocus({ projectId: 'project-3', jobIds: ['job-new'] })
  const unregister = registerGenerationFocusSink('project-3', (request) => received.push(request))

  assert.deepEqual(received, [{ projectId: 'project-3', jobIds: ['job-new'] }])
  unregister()
})

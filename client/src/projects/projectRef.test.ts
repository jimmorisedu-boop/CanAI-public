// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import { parseProjectKey, projectKey } from './projectRef'
import type { ProjectRef } from '../types'

test('local board ids are namespaced and preserve colons', () => {
  assert.equal(projectKey({ source: 'local', id: 'same' }), 'local:same')
  assert.equal(projectKey({ source: 'local', id: 'project:with:colon' }), 'local:project:with:colon')
})

test('a local key parses without assumptions about the id shape', () => {
  assert.deepEqual(parseProjectKey('local:project:with:colon'), {
    source: 'local',
    id: 'project:with:colon',
  })
})

test('non-local source, empty id, and missing separator are rejected', () => {
  assert.throws(() => projectKey({ source: 'remote', id: 'project' } as unknown as ProjectRef), /Only local boards/u)
  assert.throws(() => parseProjectKey('remote:project'), /Only local boards/u)
  assert.throws(() => parseProjectKey('local:'), /Empty board ID/u)
  assert.throws(() => parseProjectKey('project'), /Invalid board key format/u)
  assert.throws(() => projectKey({ source: 'local', id: '' }), /Empty board ID/u)
})

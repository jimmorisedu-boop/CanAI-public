import assert from 'node:assert/strict'
import test from 'node:test'
import { canGenerate, canStartGeneration } from './generationAvailability'
import type { ServerStatus } from '../../types'

const status = (patch: Partial<ServerStatus>): ServerStatus => ({
  falConfigured: false,
  mockMode: false,
  serverFingerprint: null,
  instanceId: 'test',
  shuttingDown: false,
  ...patch,
} as ServerStatus)

test('local generation follows the fal key', () => {
  assert.equal(canGenerate(status({ falConfigured: true }), 'local'), true)
  assert.equal(canGenerate(status({}), 'local'), false)
  assert.equal(canGenerate(null, 'local'), false)
})

test('local generation ignores account compatibility fields', () => {
  assert.equal(canGenerate(status({ accountCloudConfigured: true }), 'local'), false)
  assert.equal(canGenerate(status({ falConfigured: true, accountCloudConfigured: false }), 'local'), true)
})

test('demo mode is available without a configured fal key', () => {
  assert.equal(canGenerate(status({ mockMode: true }), 'local'), true)
})

test('catalog availability gates starting a local generation', () => {
  assert.equal(canStartGeneration(status({ falConfigured: true }), true, 'local'), true)
  assert.equal(canStartGeneration(status({ falConfigured: true }), false, 'local'), false)
  assert.equal(canStartGeneration(status({}), true, 'local'), false)
})

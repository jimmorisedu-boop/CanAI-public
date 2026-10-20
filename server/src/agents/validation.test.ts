import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AgentProtocolValidator, AgentProtocolError } from './validation.js'

const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/agents')
const validator = new AgentProtocolValidator(schemaDir)

test('agent protocol validator accepts canonical hello and rejects wrong direction', () => {
  const hello = {
    protocolVersion: '1.0',
    messageId: 'hello-1',
    taskId: 'task-1',
    executionId: 'execution-1',
    type: 'hello',
    payload: { supportedProtocolVersions: ['1.0'], capabilities: ['checkpoint'] },
  }
  assert.deepEqual(validator.validateEnvelope(hello), [])
  assert.equal(validator.assertEnvelope(hello, 'agent-to-host').type, 'hello')
  assert.throws(() => validator.assertEnvelope(hello, 'host-to-agent'), (error: unknown) => {
    assert.ok(error instanceof AgentProtocolError)
    assert.equal(error.code, 'PROTOCOL_INVALID')
    return true
  })
})

test('agent protocol validator rejects traversal and invalid checkpoint progress', () => {
  assert.throws(() => validator.assertCheckpointFiles({ files: [{ path: '../secret.txt', checksum: 'a'.repeat(64) }] }), (error: unknown) => {
    assert.ok(error instanceof AgentProtocolError)
    assert.equal(error.code, 'PATH_INVALID')
    return true
  })
  assert.throws(() => validator.assertProgress({ stageId: 'plan', label: 'Plan', status: 'running', completed: 3, total: 2 }), /completed/u)
})

test('manifest schema is Draft 2020-12 validated, not partially parsed', () => {
  assert.throws(() => validator.assertManifest({ schemaVersion: 1, id: 'bad' }), (error: unknown) => {
    assert.ok(error instanceof AgentProtocolError)
    assert.equal(error.code, 'MANIFEST_INVALID')
    assert.ok(error.issues.length > 0)
    return true
  })
})

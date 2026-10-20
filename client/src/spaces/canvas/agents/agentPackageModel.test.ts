import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentInputSchemaView,
  AgentPackageCheckView,
  AgentPackageInstallationView,
  AgentPackageSummary,
  AgentTaskView,
} from '../../../../../packages/agent-protocol/index'
import {
  checkCanBeTrusted,
  failedPackageInstallations,
  inputDefaults,
  launchablePackages,
  mergeTaskInputValue,
  packageSourceMatchesInstallation,
  packageCanBeRemoved,
  reinstallPackageRequest,
  sourceCheckKey,
  taskInputPayload,
  validateTaskInput,
} from './agentPackageModel'

const schema: AgentInputSchemaView = {
  type: 'object',
  fields: [
    { key: 'brief', label: 'Описание', kind: 'string', required: true, minLength: 3 },
    { key: 'count', label: 'Количество', kind: 'number', default: 2, minimum: 1, maximum: 4, ...( { integer: true } as Record<string, unknown>) },
    { key: 'mode', label: 'Режим', kind: 'enum', required: true, enum: ['plan', 'review'] },
    { key: 'safe', label: 'Проверить', kind: 'boolean' },
  ],
}

function pkg(overrides: Partial<AgentPackageSummary> = {}): AgentPackageSummary {
  return {
    id: 'demo', name: 'Demo', description: 'Demo', version: '1.0.0', packageSha: 'sha', protocolVersion: '1.0',
    taskTypes: [{ id: 'plan', label: 'План', description: 'План', outputKinds: ['plan'] }],
    permissions: [], lifecycle: { pause: 'checkpoint', resume: true, cancel: true }, handshake: 'ready',
    ...overrides,
  }
}

function task(overrides: Partial<AgentTaskView> = {}): AgentTaskView {
  return {
    taskId: 'task', requestId: 'req', packageId: 'demo', packageVersion: '1.0.0', packageSha: 'sha', protocolVersion: '1.0',
    projectRef: { source: 'local', id: 'board' }, ownerId: 'owner', controllerId: 'host', taskType: 'plan', instruction: 'x', input: {}, inputs: [], workspaceId: 'workspace',
    state: 'running', revision: 1, eventCursor: 1, reviews: [], receipts: [], artifacts: [], canvasItems: [], createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

function check(overrides: Partial<AgentPackageCheckView> = {}): AgentPackageCheckView {
  return {
    checkId: 'check-1', source: { kind: 'git', canonicalUrl: 'https://github.com/acme/agent', requestedRef: 'main' },
    manifest: {
      id: 'acme', name: 'Acme', description: 'A package', version: '1.0.0', protocolVersion: '1.0', taskTypes: [], permissions: ['canvas.read_selected'],
      lifecycle: { pause: 'checkpoint', resume: true, cancel: true }, runtime: { kind: 'node', version: '20', entrypoint: 'dist/index.js', dependencies: 'stdlib' },
    }, packageSha: 'a'.repeat(64), supported: true, issues: [],
    trust: { explicitTrustRequired: true, requiredPermissions: ['canvas.read_selected'], disclaimer: 'Not a sandbox.' }, revision: 4,
    ...overrides,
  }
}

function failedInstallation(overrides: Partial<AgentPackageInstallationView> = {}): AgentPackageInstallationView {
  return {
    installationId: 'install-failed', packageId: 'acme', version: '1.0.0', packageSha: 'a'.repeat(64),
    source: { kind: 'git', canonicalUrl: 'https://github.com/acme/agent', requestedRef: 'main', resolvedSha: 'b'.repeat(40) },
    runtime: { kind: 'node', version: '22.0.0', integrity: 'runtime-sha', environmentId: 'node-22' },
    status: 'failed', active: false, createdAt: 1, updatedAt: 2,
    ...overrides,
  }
}

test('generic task inputs use defaults and reject invalid primitive/enum values', () => {
  assert.deepEqual(inputDefaults(schema), { count: 2, safe: false })
  assert.deepEqual(mergeTaskInputValue(schema, {}, 'brief', 'plan'), { brief: 'plan', count: 2, safe: false })
  assert.deepEqual(validateTaskInput(schema, {}), { brief: 'Field is required', mode: 'Field is required' })
  assert.deepEqual(validateTaskInput(schema, { brief: 'ok', mode: 'other', count: 1.5 }), {
    brief: 'Minimum characters: 3', count: 'An integer is required', mode: 'Choose a value from the list',
  })
  assert.deepEqual(taskInputPayload({ brief: 'plan', mode: 'plan', optional: undefined }), { brief: 'plan', mode: 'plan' })
})

test('only ready enabled packages launch; terminal history remains removable-safe', () => {
  const packages = [pkg(), pkg({ id: 'disabled', status: 'disabled' }), pkg({ id: 'failed', handshake: 'failed' }), pkg({ id: 'unsupported', status: 'unsupported' })]
  assert.deepEqual(launchablePackages(packages).map((value) => value.id), ['demo'])
  assert.equal(packageCanBeRemoved({ id: 'demo', installationId: 'install-1' }, [task({ installationId: 'install-1', state: 'succeeded' })]), true)
  assert.equal(packageCanBeRemoved({ id: 'demo', installationId: 'install-1' }, [task({ installationId: 'install-1', state: 'running' })]), false)
})

test('trust confirmation is exact and never grants an extra permission', () => {
  const candidate = check()
  assert.equal(checkCanBeTrusted(candidate, ['canvas.read_selected']), true)
  assert.equal(checkCanBeTrusted(candidate, []), false)
  assert.equal(checkCanBeTrusted(candidate, ['canvas.read_selected', 'media.read']), false)
  assert.equal(checkCanBeTrusted({ ...candidate, issues: [{ code: 'RUNTIME', message: 'unsupported', severity: 'error' }] }, ['canvas.read_selected']), false)
})

test('failed installations remain visible as recovery history and reinstall keeps the exact prior id', () => {
  const failed = failedInstallation()
  const ready = failedInstallation({ installationId: 'install-ready', status: 'ready', active: true, updatedAt: 3 })
  assert.deepEqual(failedPackageInstallations([ready, failed]).map((value) => value.installationId), ['install-failed'])

  const candidate = check()
  assert.equal(packageSourceMatchesInstallation(candidate, failed), true)
  const request = reinstallPackageRequest(candidate, failed, 'ui-reinstall-1')
  assert.deepEqual(request, {
    requestId: 'ui-reinstall-1', checkId: 'check-1', expectedRevision: 4,
    trustConfirmed: true, approvedPermissions: ['canvas.read_selected'], priorInstallationId: 'install-failed',
  })
  assert.equal(reinstallPackageRequest(check({ packageSha: 'c'.repeat(64) }), failed, 'ui-reinstall-2')?.priorInstallationId, 'install-failed')
  assert.equal(reinstallPackageRequest(check({ source: { ...candidate.source, subdir: 'other' } }), failed, 'ui-reinstall-3'), null)
})

test('archive sources are immutable receipts and new ZIP versions require prior installation', () => {
  const failed = failedInstallation({ source: { kind: 'archive', archiveId: 'upload-1', archiveSha: 'b'.repeat(64) } })
  const candidate = check({ source: { kind: 'archive', archiveId: 'upload-1', archiveSha: 'b'.repeat(64) } })
  assert.equal(packageSourceMatchesInstallation(candidate, failed), true)
  assert.equal(reinstallPackageRequest(candidate, failed, 'ui-archive-reinstall')?.priorInstallationId, 'install-failed')
  const nextZip = check({ source: { kind: 'archive', archiveId: 'upload-2', archiveSha: 'c'.repeat(64) }, packageSha: 'c'.repeat(64) })
  assert.equal(packageSourceMatchesInstallation(nextZip, failed), false)
})

test('source check pin changes when the user switches Git and ZIP', () => {
  assert.notEqual(
    sourceCheckKey({ kind: 'git', url: 'https://github.com/acme/agent', ref: 'main' }),
    sourceCheckKey({ kind: 'archive', archiveId: 'upload-1' }),
  )
  assert.equal(sourceCheckKey({ kind: 'git', url: ' https://github.com/acme/agent ', ref: ' main ' }), sourceCheckKey({ kind: 'git', url: 'https://github.com/acme/agent', ref: 'main' }))
})

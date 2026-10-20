import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentPackageCheckView } from '../../../../../packages/agent-protocol/index'
import type { AgentPanelController } from './agentPanelController'
import type { PendingMutation } from './agentConnectionsModel'
import { startAgentPackageInstall } from './agentConnectionsInstall'

function check(runtime: 'node' | 'python' = 'node'): AgentPackageCheckView {
  return {
    checkId: 'check-cloud',
    source: { kind: 'git', canonicalUrl: 'https://github.com/acme/agent', requestedRef: 'main' },
    manifest: {
      id: 'acme', name: 'Acme', description: 'A package', version: '1.0.0', protocolVersion: '1.0', taskTypes: [],
      permissions: ['canvas.read_selected'], lifecycle: { pause: 'checkpoint', resume: true, cancel: true },
      handshake: 'ready', runtime: { kind: runtime, version: runtime === 'python' ? '3.13.16' : '20', entrypoint: 'index.js', dependencies: 'stdlib',
      },
    },
    packageSha: 'a'.repeat(64), supported: true, issues: [],
    trust: { explicitTrustRequired: true, requiredPermissions: ['canvas.read_selected'], disclaimer: 'Not a sandbox.' }, revision: 4,
  } as AgentPackageCheckView
}

test('Host package settings can request an install after explicit trust', () => {
  let operation: PendingMutation | undefined
  let notice: { title: string } | null = null
  startAgentPackageInstall({
    check: check(), trusted: true, pythonReady: false, reinstallInstallation: undefined,
    archiveUpdateFromFailed: false, checkedPackage: undefined, controller: { packageRevision: 7 } as AgentPanelController,
    runMutation: (value) => { operation = value }, setNotice: (value) => { notice = value ? { title: value.title } : null },
  })
  assert.equal(operation?.kind, 'install')
  assert.equal(notice, null)
})

test('Host Python package install still waits for explicit runtime readiness', () => {
  let operation: PendingMutation | undefined
  let notice: { title: string } | null = null
  startAgentPackageInstall({
    check: check('python'), trusted: true, pythonReady: false, reinstallInstallation: undefined,
    archiveUpdateFromFailed: false, checkedPackage: undefined, controller: { packageRevision: 7 } as AgentPanelController,
    runMutation: (value) => { operation = value }, setNotice: (value) => { notice = value ? { title: value.title } : null },
  })
  assert.equal(operation, undefined)
  assert.equal(notice?.title, 'Prepare portable Python first')
})

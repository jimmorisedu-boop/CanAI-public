import type { AgentPackageCheckView, AgentPackageInstallationView, AgentPackageSummary } from '../../../../../packages/agent-protocol/index'
import type { AgentPanelController } from './agentPanelController'
import type { ConnectionNotice, PendingMutation } from './agentConnectionsModel'
import { newRequestId } from './agentConnectionsModel'
import { reinstallPackageRequest } from './agentPackageModel'

export function startAgentPackageInstall({
  check,
  trusted,
  pythonReady,
  reinstallInstallation,
  archiveUpdateFromFailed,
  checkedPackage,
  controller,
  runMutation,
  setNotice,
}: {
  check: AgentPackageCheckView | null
  trusted: boolean
  pythonReady: boolean
  reinstallInstallation: AgentPackageInstallationView | undefined
  archiveUpdateFromFailed: boolean
  checkedPackage: AgentPackageSummary | undefined
  controller: Pick<AgentPanelController, 'packageRevision'>
  runMutation(operation: PendingMutation): Promise<void> | void
  setNotice(value: ConnectionNotice | null): void
}): void {
  if (!check || !trusted) return
  if (check.manifest.runtime.kind === 'python' && !pythonReady) {
    setNotice({ tone: 'warning', title: 'Prepare portable Python first', detail: 'A verified portable Python runtime for Windows x64 is required.' })
    return
  }
  if (reinstallInstallation) {
    if (archiveUpdateFromFailed) {
      void runMutation({ kind: 'update', input: {
        requestId: newRequestId('archive-update'), checkId: check.checkId,
        expectedRevision: check.revision, trustConfirmed: true,
        approvedPermissions: [...new Set(check.trust.requiredPermissions)],
        priorInstallationId: reinstallInstallation.installationId,
      } })
      return
    }
    const input = reinstallPackageRequest(check, reinstallInstallation, newRequestId('reinstall'))
    if (!input) {
      setNotice({ tone: 'warning', title: 'Recheck does not match', detail: 'Check the same package ID, GitHub source, ref, and subdir. Trust must be approved again.' })
      return
    }
    void runMutation({ kind: 'install', input })
    return
  }
  const prior = checkedPackage?.installationId
  const approvedPermissions = [...new Set(check.trust.requiredPermissions)]
  if (prior && checkedPackage?.packageSha === check.packageSha) {
    if (checkedPackage.status === 'disabled') {
      void runMutation({ kind: 'manage', action: 'enable', input: {
        requestId: newRequestId('enable'), expectedRevision: controller.packageRevision,
        installationId: prior, packageId: checkedPackage.id,
      } })
    } else setNotice({ tone: 'info', title: 'Package is already connected', detail: 'This exact SHA is already installed. No new copy will be created.' })
    return
  }
  if (prior && checkedPackage.packageSha !== check.packageSha) {
    void runMutation({ kind: 'update', input: {
      requestId: newRequestId('update'), checkId: check.checkId,
      expectedRevision: check.revision, trustConfirmed: true, approvedPermissions, priorInstallationId: prior,
    } })
    return
  }
  void runMutation({ kind: 'install', input: {
    requestId: newRequestId('install'), checkId: check.checkId,
    expectedRevision: check.revision, trustConfirmed: true, approvedPermissions,
    ...(prior ? { priorInstallationId: prior } : {}),
  } })
}

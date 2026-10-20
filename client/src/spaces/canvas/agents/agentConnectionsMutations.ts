import type { MutableRefObject } from 'react'
import { AgentHostRequestError } from './agentHostClient'
import type { AgentPackageController } from './agentPanelController'
import type { ConnectionNotice, PendingMutation } from './agentConnectionsModel'

export async function runAgentPackageMutation({
  operation,
  controller,
  serialRef,
  setPending,
  setBusy,
  setNotice,
  showError,
}: {
  operation: PendingMutation
  controller: AgentPackageController
  serialRef: MutableRefObject<number>
  setPending(value: PendingMutation | null): void
  setBusy(value: string | null): void
  setNotice(value: ConnectionNotice | null): void
  showError(error: unknown): void
}): Promise<void> {
  const serial = serialRef.current
  setPending(operation)
  setBusy(operation.kind === 'manage' ? operation.action : operation.kind)
  setNotice(null)
  try {
    if (operation.kind === 'install') await controller.installPackage(operation.input)
    else if (operation.kind === 'update') await controller.updatePackage(operation.input)
    else await controller.managePackage(operation.action, operation.input)
    if (serial !== serialRef.current) return
    setPending(null)
    setNotice({ tone: 'success', title: 'Library updated', detail: 'Host confirmed the saved package state.' })
  } catch (error) {
    if (serial !== serialRef.current) return
    if (error instanceof AgentHostRequestError && error.code === 'LIBRARY_REVISION_STALE') {
      const detail = operation.kind === 'manage'
        ? 'The library changed. Host refreshed the list; run this command again with the new revision.'
        : 'The package check is stale. Check the source again and approve the SHA again.'
      setPending(null)
      setNotice({ tone: 'warning', title: 'Library changed', detail })
    } else showError(error)
  } finally {
    if (serial === serialRef.current) setBusy(null)
  }
}

import type { AgentPackageInstallationView } from '../../../../../packages/agent-protocol/index'
import { isAgentTaskActive } from './agentPanelModel'
import type { AgentPackageController } from './agentPanelController'
import { sourceDrafts, type ConnectionNotice, type SourceDraft } from './agentConnectionsModel'

export function recheckAgentInstallation({
  installation,
  controller,
  projectKey,
  setDraft,
  setNotice,
  checkSource,
}: {
  installation: AgentPackageInstallationView
  controller: Pick<AgentPackageController, 'state'>
  projectKey: string
  setDraft(value: SourceDraft): void
  setNotice(value: ConnectionNotice | null): void
  checkSource(source: SourceDraft, recoveryInstallationId?: string): Promise<void> | void
}): void {
  if (controller.state.tasks.some((task) => task.installationId === installation.installationId && isAgentTaskActive(task.state))) {
    setNotice({ tone: 'warning', title: 'Installation is busy with an active task', detail: 'Wait for it to finish or stop the older task first.' })
    return
  }
  if (installation.source.kind === 'git' && !installation.source.canonicalUrl) {
    setNotice({ tone: 'warning', title: 'Source is unavailable for rechecking', detail: 'Reinstall requires the saved public GitHub HTTPS source.' })
    return
  }
  if (installation.source.kind === 'archive' && !installation.source.archiveId) {
    setNotice({ tone: 'warning', title: 'ZIP upload not found', detail: 'Rechecking requires the saved immutable archive receipt.' })
    return
  }
  const nextDraft: SourceDraft = installation.source.kind === 'archive'
    ? { kind: 'archive', url: '', ref: '', subdir: installation.source.subdir ?? '', archiveId: installation.source.archiveId, archiveSha: installation.source.archiveSha }
    : { kind: 'git', url: installation.source.canonicalUrl!, ref: installation.source.requestedRef ?? '', subdir: installation.source.subdir ?? '' }
  sourceDrafts.set(projectKey, nextDraft)
  setDraft(nextDraft)
  void checkSource(nextDraft, installation.installationId)
}

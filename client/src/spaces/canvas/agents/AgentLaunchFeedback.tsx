import type { AgentPackageSummary } from '../../../../../packages/agent-protocol/index'
import { InlineNotice } from '../../../ui/InlineNotice'
import { IconRun } from '../../../ui/icons'
import type { AgentPresentationCapability } from './agentCapabilities'
import { packageIsDemo } from './agentLaunchHelpers'

export function AgentLaunchFeedback({
  selectedPackage,
  packages,
  capability,
  selectedInputCount,
  launchBusy,
  launchDisabled,
  launchError,
  canLaunch,
  onLaunch,
}: {
  selectedPackage: AgentPackageSummary | undefined
  packages: readonly AgentPackageSummary[]
  capability?: AgentPresentationCapability
  selectedInputCount: number
  launchBusy: boolean
  launchDisabled: boolean
  launchError: string | null
  canLaunch: boolean
  onLaunch(): void
}) {
  if (!selectedPackage) {
    return <InlineNotice
      tone="warning"
      title="No published package"
      detail={packages.length
        ? 'Enable a compatible Node/stdlib package in “Settings → Agents”. Unready packages cannot be run with one click.'
        : 'Connect a package in “Settings → Agents”.'}
    />
  }
  return <>
    <div className="agent-panel-launch-foot">
      <span>{selectedInputCount ? `Selected files: ${selectedInputCount}` : 'No files selected'}</span>
      <button type="button" className="ui-btn primary" disabled={launchDisabled || launchBusy} onClick={onLaunch}>
        <IconRun size={14} /> {launchBusy ? 'Creating…' : 'Create'}
      </button>
    </div>
    {packageIsDemo(selectedPackage.id, selectedPackage.name) && (
      <InlineNotice
        tone="info"
        title="Demo agent"
        detail="This is a local test run. It does not pretend to be a real AI model and does not spend money."
      />
    )}
    {launchError && <InlineNotice tone="error" title={`Run rejected by ${capability?.label ?? 'local host'}`} detail={launchError} />}
    {!canLaunch && <InlineNotice tone="warning" title="Run unavailable" detail={capability?.reason ?? 'The local host did not grant this device permission to run the task.'} />}
  </>
}

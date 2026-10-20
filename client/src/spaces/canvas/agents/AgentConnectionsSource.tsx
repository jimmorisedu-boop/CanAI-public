import type { AgentPackageCheckView } from '../../../../../packages/agent-protocol/index'
import type { KeyboardEvent } from 'react'
import { InlineNotice } from '../../../ui/InlineNotice'
import { IconDone, IconRefresh, IconUpload, IconWarning } from '../../../ui/icons'
import { issueTone, type SourceDraft, type SourceKind } from './agentConnectionsModel'
import { useAgentConnectionsSource } from './useAgentConnectionsSource'

type SourceController = ReturnType<typeof useAgentConnectionsSource>

function sourceDomId(projectRef: { source: string; id: string }, kind: SourceKind, part: 'tab' | 'panel') {
  const projectId = `${projectRef.source}-${projectRef.id}`.replace(/[^a-zA-Z0-9_-]/g, '-') || 'project'
  return `agent-source-${projectId}-${kind}-${part}`
}

export function AgentConnectionsSource({
  projectRef,
  source,
}: {
  projectRef: { source: 'local' | 'cloud'; id: string }
  source: SourceController
}) {
  const sourceLocked = source.sourceLocked
  const check = source.check as AgentPackageCheckView | null
  const activeKind = source.draft.kind
  const gitTabId = sourceDomId(projectRef, 'git', 'tab')
  const archiveTabId = sourceDomId(projectRef, 'archive', 'tab')
  const gitPanelId = sourceDomId(projectRef, 'git', 'panel')
  const archivePanelId = sourceDomId(projectRef, 'archive', 'panel')
  const tabIds: Record<SourceKind, string> = { git: gitTabId, archive: archiveTabId }
  const availableKinds: SourceKind[] = !sourceLocked ? ['git', 'archive'] : ['git']
  const updateSource = (key: keyof SourceDraft, value: string) => source.updateDraft(key, value)
  const selectSource = (kind: SourceKind) => {
    source.setSourceKind(kind)
    document.getElementById(tabIds[kind])?.focus()
  }
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, kind: SourceKind) => {
    if (availableKinds.length < 2 && event.key !== 'Home' && event.key !== 'End') return
    const currentIndex = availableKinds.indexOf(kind)
    if (currentIndex < 0) return
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? availableKinds.length - 1
        : event.key === 'ArrowRight'
          ? (currentIndex + 1) % availableKinds.length
          : event.key === 'ArrowLeft'
            ? (currentIndex - 1 + availableKinds.length) % availableKinds.length
            : currentIndex
    if (nextIndex === currentIndex || !['Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return
    event.preventDefault()
    selectSource(availableKinds[nextIndex])
  }
  return (
    <>
    <section className="agent-panel-section" onKeyDown={(event) => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); void source.checkSource() } }}>
      <div className="agent-panel-section-head"><span>Connect package</span><span className="agent-panel-kicker">Git / ZIP</span></div>
      <div className="agent-source-tabs" role="tablist" aria-label="Package source" aria-orientation="horizontal">
        <button id={gitTabId} type="button" role="tab" aria-controls={gitPanelId} aria-selected={activeKind === 'git'} tabIndex={activeKind === 'git' ? 0 : -1} className={activeKind === 'git' ? 'active' : ''} disabled={sourceLocked} onKeyDown={(event) => onTabKeyDown(event, 'git')} onClick={() => selectSource('git')}>GitHub HTTPS</button>
        <button id={archiveTabId} type="button" role="tab" aria-controls={archivePanelId} aria-selected={activeKind === 'archive'} tabIndex={activeKind === 'archive' ? 0 : -1} className={activeKind === 'archive' ? 'active' : ''} disabled={sourceLocked} onKeyDown={(event) => onTabKeyDown(event, 'archive')} onClick={() => selectSource('archive')}>ZIP archive</button>
      </div>
      <div id={gitPanelId} role="tabpanel" aria-labelledby={gitTabId} tabIndex={0} hidden={activeKind !== 'git'}>
          <label className="agent-panel-label">Repository URL<input value={source.draft.url} disabled={sourceLocked} onChange={(event) => updateSource('url', event.target.value)} placeholder="https://github.com/owner/repository" inputMode="url" /></label>
          <div className="agent-connection-grid">
            <label className="agent-panel-label">Ref<input value={source.draft.ref} disabled={sourceLocked} onChange={(event) => updateSource('ref', event.target.value)} placeholder="branch or tag" /></label>
            <label className="agent-panel-label">Subdir<input value={source.draft.subdir} disabled={sourceLocked} onChange={(event) => updateSource('subdir', event.target.value)} placeholder="optional" /></label>
          </div>
      </div>
      <div id={archivePanelId} role="tabpanel" aria-labelledby={archiveTabId} tabIndex={0} hidden={activeKind !== 'archive'}>
          <label className="agent-upload-control">
            <IconUpload size={15} />
            <span>{source.draft.archiveName ?? 'Choose a .zip package'}</span>
            <input type="file" accept=".zip,application/zip,application/x-zip-compressed" disabled={sourceLocked || source.busy === 'upload'} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void source.uploadArchive(file, file.name) }} />
          </label>
          {source.draft.archiveId && <code className="agent-package-upload-pin">archive {source.draft.archiveId} · SHA-256 {source.draft.archiveSha ?? '—'} · {source.draft.archiveSize ? `${Math.ceil(source.draft.archiveSize / 1024)} KB` : 'size unknown'}</code>}
          <label className="agent-panel-label">Subdir<input value={source.draft.subdir} disabled={sourceLocked} onChange={(event) => updateSource('subdir', event.target.value)} placeholder="optional" /></label>
      </div>
      <div className="agent-source-actions">
        <button type="button" className="ui-btn primary agent-connection-check" disabled={source.busy !== null || (source.draft.kind === 'archive' && !source.draft.archiveId)} onClick={() => void source.checkSource()}><IconRefresh size={13} /> {source.busy === 'check' ? 'Checking…' : 'Check'}</button>
        {sourceLocked && <button type="button" className="ui-btn" onClick={source.resetCheckedSource}>Change source</button>}
      </div>
      {source.uploadPending && !source.busy && <InlineNotice tone="warning" title="Host rejected the ZIP" detail={`File ${source.uploadPending.name} remains in memory; retrying uses the same Idempotency-Key and will not create a second copy.`} action={{ label: 'Retry upload', onClick: () => void source.uploadArchive(source.uploadPending!.archive, source.uploadPending!.name) }} />}
      {source.notice
        ? <InlineNotice tone={source.notice.tone} title={source.notice.title} detail={source.notice.detail} action={source.pending ? { label: 'Retry', onClick: source.retryPending, disabled: source.busy !== null } : source.checkRetry ? { label: 'Check again', onClick: () => void source.checkSource(source.checkRetry!), disabled: source.busy !== null } : undefined} />
        : source.pending && <InlineNotice tone="info" title="Waiting for Host approval" detail="Request saved; closing the tab does not cancel it." />}

    </section>
    {check && <AgentPackageCheck check={check} source={source} />}
    </>
  )
}

function AgentPackageCheck({
  check,
  source,
}: {
  check: AgentPackageCheckView
  source: SourceController
}) {
  return (
    <section className="agent-panel-section agent-package-check" aria-label="Package check result">
      <div className="agent-panel-section-head"><span>{check.manifest.name}</span><span className="agent-panel-kicker">Check</span></div>
      <p className="agent-package-description">{check.manifest.description}</p>
      <dl className="agent-package-facts">
        <div><dt>Version</dt><dd>{check.manifest.version}</dd></div>
        <div><dt>{check.source.kind === 'archive' ? 'Archive ID' : 'Git commit SHA'}</dt><dd className="agent-package-sha">{check.source.kind === 'archive' ? (check.source.archiveId || 'not received') : (check.source.resolvedSha || 'not received')}</dd></div>
        <div><dt>Package SHA-256</dt><dd className="agent-package-sha">{check.packageSha || 'not received'}</dd></div>
        <div><dt>Runtime</dt><dd>{check.manifest.runtime.kind} {check.manifest.runtime.version}</dd></div>
        <div><dt>Source</dt><dd>{check.source.kind === 'archive' ? [`ZIP ${check.source.archiveId ?? 'upload'}`, check.source.archiveSha, check.source.subdir].filter(Boolean).join(' · ') : [check.source.canonicalUrl ?? 'GitHub', check.source.requestedRef, check.source.subdir].filter(Boolean).join(' · ')}</dd></div>
      </dl>
      {check.manifest.permissions.length > 0 && <p className="agent-package-rights"><strong>Permissions:</strong> {check.manifest.permissions.join(', ')}</p>}
      {check.issues.map((issue) => <InlineNotice key={`${issue.code}:${issue.path ?? ''}`} tone={issueTone(issue.severity)} title={issue.code} detail={`${issue.message}${issue.path ? ` · ${issue.path}` : ''}`} />)}
      {!check.supported && <InlineNotice tone="warning" title="Package is not supported yet" detail="Host will not show the ready-to-run button. A compatible Node/stdlib implementation and valid manifest are required." />}
      {check.supported && source.packageSourceConflict && <InlineNotice tone="warning" title="Package ID is already in use" detail="To replace a bundled package or another source type, Host requires a matching prior installation. An archive can be updated only explicitly for the same package ID." />}
      {check.supported && source.reinstallSourceConflict && <InlineNotice tone="warning" title="Source does not match the damaged installation" detail="Reinstall requires the same immutable Git source or ZIP archive receipt. For a new ZIP, use an explicit version update." />}
      {check.supported && (
        <div className="agent-package-trust">
          <InlineNotice tone="warning" title="Code trust is not a sandbox" detail={check.trust.disclaimer || 'The package may run arbitrary code with OS access within Host.'}>
            <span><IconWarning size={14} /> Check the full SHA and every permission before installing.</span>
          </InlineNotice>
          <label className="agent-trust-check">
            <input type="checkbox" checked={source.trustConfirmed} onChange={(event) => source.setTrustConfirmed(event.target.checked)} />
            <span>I trust this exact SHA and approve every listed permission: <strong>{check.trust.requiredPermissions.length ? check.trust.requiredPermissions.join(', ') : 'no additional permissions'}</strong>.</span>
          </label>
          <button type="button" className="ui-btn primary" disabled={!source.trusted || source.sourceConflict || source.busy !== null} onClick={source.startInstall}><IconDone size={13} /> {source.reinstallInstallation ? 'Reinstall version' : source.checkedPackage?.status === 'disabled' && source.checkedPackage.packageSha === check.packageSha ? 'Enable package' : source.checkedPackage && source.checkedPackage.packageSha !== check.packageSha ? 'Install new version' : 'Connect package'}</button>
        </div>
      )}
    </section>
  )
}

import type { AgentPackageInstallationView } from '../../../../../packages/agent-protocol/index'
import { InlineNotice } from '../../../ui/InlineNotice'
import { IconArchive, IconLock, IconTrash } from '../../../ui/icons'
import { isAgentTaskActive } from './agentPanelModel'
import { packageStatusLabel } from './agentPackageModel'
import type { AgentPackageController } from './agentPanelController'
import { installationSourceView } from './agentConnectionsModel'
import type { useAgentConnectionsSource } from './useAgentConnectionsSource'
import { useT } from '../../../i18n/context.js'


type SourceController = ReturnType<typeof useAgentConnectionsSource>

export function AgentConnectionsLibrary({
  controller,
  source,
}: {
  controller: AgentPackageController
  source: SourceController
}) {
  const t = useT()
  const sortedPackages = controller.state.packages.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  return (
    <section className="agent-panel-section">
      <div className="agent-panel-section-head"><span><IconArchive size={14} />  {t('Library')}</span><span className="agent-panel-count">{sortedPackages.length + source.failedInstallations.length}</span></div>
      {sortedPackages.length === 0 && source.failedInstallations.length === 0 ? <p className="agent-panel-empty">{t('Only bundled or unchecked Host packages are available so far.')}</p> : (
        <div className="agent-package-list">
          {source.failedInstallations.map((installation: AgentPackageInstallationView) => {
            const blocked = controller.state.tasks.some((task) => task.installationId === installation.installationId && isAgentTaskActive(task.state))
            return (
              <article className="agent-package-card" key={`failed:${installation.installationId}`}>
                <div className="agent-package-card-head"><strong>{installation.packageId}</strong><span className="agent-package-status failed">{t('Not ready')}</span></div>
                <small>{t('Saved installation · v{0}', { 0: installation.version })}</small>
                <small>{t('Source:')} {installationSourceView(installation)}</small>
                <small>{t('Runtime:')} {installation.runtime.kind} {installation.runtime.version}</small>
                <code>{t('Git commit')} {installation.source.resolvedSha ?? 'not saved'} · {t('Package SHA-256')} {installation.packageSha}</code>
                <InlineNotice tone="warning" title={t('Reinstall required')} detail={t('Host kept this history, but the current runtime rejected the installation. A recheck will ask for explicit trust again; this record cannot be run.')} />
                <div className="agent-package-actions">
                  <button type="button" className="ui-btn primary" disabled={source.busy !== null || blocked} onClick={() => source.recheckFailedInstallation(installation)}>{blocked ? t('Busy with an older task') : t('Check and reinstall')}</button>
                </div>
              </article>
            )
          })}
          {sortedPackages.map((pkg) => {
            const active = source.activeTask(pkg)
            const bundled = pkg.source?.kind === 'bundled' || !pkg.installationId
            return (
              <article className="agent-package-card" key={`${pkg.id}:${pkg.installationId ?? 'bundled'}`}>
                <div className="agent-package-card-head"><strong>{pkg.name}</strong><span className={`agent-package-status ${pkg.status ?? 'ready'}`}>{packageStatusLabel(pkg)}</span></div>
                <small>{pkg.id} · v{pkg.version}</small>
                {pkg.packageSha && <code>{pkg.packageSha.slice(0, 12)}…</code>}
                {active && <span className="agent-package-active"><IconLock size={12} /> {t('used by an active task')}</span>}
                {!bundled && <div className="agent-package-actions">
                  {pkg.status === 'disabled' ? <button type="button" className="ui-btn" disabled={source.busy !== null} onClick={() => source.manage(pkg, 'enable')}>{t('Enable')}</button> : <button type="button" className="ui-btn" disabled={source.busy !== null || active} onClick={() => source.manage(pkg, 'disable')}>{t('Disable')}</button>}
                  <button type="button" className="ui-btn" disabled={source.busy !== null || active || pkg.status === 'disabled'} onClick={() => source.manage(pkg, 'rollback')}>{t('Roll back')}</button>
                  <button type="button" className="ui-btn danger" disabled={source.busy !== null || active} onClick={() => source.manage(pkg, 'remove')}><IconTrash size={13} />  {t('Remove')}</button>
                </div>}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

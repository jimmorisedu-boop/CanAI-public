import { InlineNotice } from '../ui/InlineNotice'
import { AgentConnectionsPanel } from '../spaces/canvas/agents/AgentConnectionsPanel'
import { useAgentSettingsController } from '../spaces/canvas/agents/useAgentSettingsController'
import { useT } from '../i18n/context.js'


/**
 * Desktop-only agent package management. Keeping this outside the board panel
 * makes the download/trust flow explicit and prevents a settings visit from
 * subscribing to any board task stream.
 */
export function AgentsSettingsSection() {
  const t = useT()
  const controller = useAgentSettingsController()
  const projectRef = { source: 'local' as const, id: '__settings__' }
  return (
    <section className="settings-section settings-agents" aria-labelledby="agents-settings-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="agents-settings-title">{t('Agents')}</h3>
          <p>{t('Connect local packages and a verified runtime for tasks on this computer.')}</p>
        </div>
      </div>
      {controller.state.error && (
        <InlineNotice
          tone="warning"
          title={t('Agent host unavailable')}
          detail={controller.state.error}
          system
          action={{ label: t('Retry'), onClick: () => void controller.refresh() }}
        />
      )}
      <AgentConnectionsPanel controller={controller} projectRef={projectRef} />
    </section>
  )
}

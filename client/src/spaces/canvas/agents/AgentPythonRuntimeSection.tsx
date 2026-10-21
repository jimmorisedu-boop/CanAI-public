import { InlineNotice } from '../../../ui/InlineNotice'
import type { AgentPythonRuntimeController } from './useAgentPythonRuntime'
import { useT } from '../../../i18n/context.js'


export function AgentPythonRuntimeSection({
  runtimeState,
}: {
  runtimeState: AgentPythonRuntimeController
}) {
  const t = useT()
  const { runtime, runtimeConsent, runtimeBusy, runtimeOperation, runtimeError, setRuntimeConsent, retryRuntimeStatus, installRuntime } = runtimeState
  return (
    <section className="agent-panel-section agent-python-runtime" aria-label={t('Portable Python runtime')}>
      <div className="agent-panel-section-head"><span>{t('Python runtime')}</span><span className="agent-panel-kicker">{t('official portable')}</span></div>
      {runtime?.ready ? (
        <InlineNotice tone="success" title={t('Python {0} ready', { 0: runtime.version })} detail={t('The verified runtime is pinned by receipt and available to Python packages.')} />
      ) : runtime?.supported === false ? (
        <InlineNotice tone="warning" system title={t('Windows x64 required')} detail={runtime.reason ?? 'Portable Python is not supported on this platform.'} />
      ) : (
        <>
          <InlineNotice tone="warning" system title={t('Python {0} is not ready yet', { 0: runtime?.version ?? '3.13.16' })} detail={runtime?.reason ?? 'CanAI does not download the runtime when the panel opens. Setup starts only after explicit approval.'} />
          {runtimeError && <InlineNotice tone="error" title={t('Runtime is not prepared')} detail={runtimeError} action={{ label: 'Retry status', onClick: retryRuntimeStatus, disabled: runtimeBusy }} />}
          <label className="agent-trust-check">
            <input type="checkbox" checked={runtimeConsent} disabled={runtimeBusy} onChange={(event) => setRuntimeConsent(event.target.checked)} />
            <span>{t('I allow downloading and verifying official portable Python')} <strong>{runtime?.version ?? '3.13.16'}</strong>  {t('for Windows x64.')}</span>
          </label>
          <button type="button" className="ui-btn primary" disabled={!runtimeConsent || runtimeBusy} onClick={installRuntime}>{runtimeOperation === 'status' ? t('Checking…') : runtimeBusy ? 'Preparing…' : 'Prepare Python'}</button>
          <p className="agent-input-help">{t('Setup changes the current Desktop Host portable runtime and runs only after explicit approval.')}</p>
        </>
      )}
    </section>
  )
}

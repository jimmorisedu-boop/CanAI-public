import { InlineNotice } from '../../../ui/InlineNotice'
import type { AgentPythonRuntimeController } from './useAgentPythonRuntime'

export function AgentPythonRuntimeSection({
  runtimeState,
}: {
  runtimeState: AgentPythonRuntimeController
}) {
  const { runtime, runtimeConsent, runtimeBusy, runtimeOperation, runtimeError, setRuntimeConsent, retryRuntimeStatus, installRuntime } = runtimeState
  return (
    <section className="agent-panel-section agent-python-runtime" aria-label="Portable Python runtime">
      <div className="agent-panel-section-head"><span>Python runtime</span><span className="agent-panel-kicker">official portable</span></div>
      {runtime?.ready ? (
        <InlineNotice tone="success" title={`Python ${runtime.version} ready`} detail="The verified runtime is pinned by receipt and available to Python packages." />
      ) : runtime?.supported === false ? (
        <InlineNotice tone="warning" system title="Windows x64 required" detail={runtime.reason ?? 'Portable Python is not supported on this platform.'} />
      ) : (
        <>
          <InlineNotice tone="warning" system title={`Python ${runtime?.version ?? '3.13.16'} is not ready yet`} detail={runtime?.reason ?? 'CanAI does not download the runtime when the panel opens. Setup starts only after explicit approval.'} />
          {runtimeError && <InlineNotice tone="error" title="Runtime is not prepared" detail={runtimeError} action={{ label: 'Retry status', onClick: retryRuntimeStatus, disabled: runtimeBusy }} />}
          <label className="agent-trust-check">
            <input type="checkbox" checked={runtimeConsent} disabled={runtimeBusy} onChange={(event) => setRuntimeConsent(event.target.checked)} />
            <span>I allow downloading and verifying official portable Python <strong>{runtime?.version ?? '3.13.16'}</strong> for Windows x64.</span>
          </label>
          <button type="button" className="ui-btn primary" disabled={!runtimeConsent || runtimeBusy} onClick={installRuntime}>{runtimeOperation === 'status' ? 'Checking…' : runtimeBusy ? 'Preparing…' : 'Prepare Python'}</button>
          <p className="agent-input-help">Setup changes the current Desktop Host portable runtime and runs only after explicit approval.</p>
        </>
      )}
    </section>
  )
}

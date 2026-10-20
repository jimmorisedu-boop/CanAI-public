import { InlineNotice } from '../../../ui/InlineNotice'
import { IconLock } from '../../../ui/icons'
import { formatUsdMicros, type AgentBudgetDraft as ParsedBudget, type AgentLlmLaunchInfo } from './agentBudgetModel'
import type { AgentBudgetDraft } from './agentLaunchModel'
import type { AgentGenerationKind, AgentGenerationLaunchInfo } from './agentGenerationModel'

export function AgentSpendBudgetSection({
  llmInfo,
  generationInfo,
  generationKindOptions,
  generationArtifactLabels,
  generationCeiling,
  budgetDraft,
  parsedBudget,
  generationMediaConsentGranted,
  consentGranted,
  launchBusy,
  compact,
  contextPreview,
  onBudgetInput,
  onLlmConsent,
  onGenerationConsent,
  onGenerationKind,
  onGenerationModel,
}: {
  llmInfo: AgentLlmLaunchInfo | null
  generationInfo: AgentGenerationLaunchInfo | null
  generationKindOptions: readonly AgentGenerationKind[]
  generationArtifactLabels: readonly string[]
  generationCeiling?: number
  budgetDraft: AgentBudgetDraft
  parsedBudget: ParsedBudget
  generationMediaConsentGranted: boolean
  consentGranted: boolean
  launchBusy: boolean
  compact: boolean
  contextPreview: string
  onBudgetInput(value: string): void
  onLlmConsent(value: boolean): void
  onGenerationConsent(value: boolean): void
  onGenerationKind(value: AgentGenerationKind): void
  onGenerationModel(value: string): void
}) {
  if (!llmInfo && !generationInfo) return null
  return (
    <div className="agent-llm-budget" aria-label="Approval and local paid-tool budget">
      {llmInfo && <>
        <div className="agent-llm-connection">
          <span><IconLock size={13} /> {llmInfo.connectionLabel}</span>
          <strong className={llmInfo.available ? 'ready' : 'unavailable'}>{llmInfo.available ? 'ready' : 'unavailable'}</strong>
        </div>
        <label className="agent-panel-label">Text model
          <select value={llmInfo.modelId ?? ''} disabled aria-describedby="agent-llm-model-help">
            {llmInfo.modelOptions.filter((model) => model.active || model.id === llmInfo.modelId).map((model) => <option key={model.id} value={model.id}>{model.name}{model.active ? '' : ' · unavailable'}</option>)}
            {!llmInfo.modelId && <option value="">Model is not pinned</option>}
          </select>
        </label>
        <p id="agent-llm-model-help" className="agent-input-help">Model: <strong>{llmInfo.modelLabel}</strong>. If the model list changed, approve the run again.</p>
        {!llmInfo.available && <InlineNotice tone="warning" system title="LLM is not available yet" detail={llmInfo.unavailableReason ?? 'The local host did not confirm the connection.'} />}
      </>}
      {generationInfo && (
        <div className="agent-generation-budget" aria-label="Result approval">
          <div className="agent-llm-connection">
            <span><IconLock size={13} /> {generationInfo.connectionLabel}</span>
            <strong className={generationInfo.available ? 'ready' : 'unavailable'}>{generationInfo.available ? 'ready' : 'unavailable'}</strong>
          </div>
          {generationKindOptions.length > 1 && generationInfo.kind && generationInfo.modelOptions.length > 0 && <div className="agent-launch-choice-row">
            <label className="agent-panel-label">Result type
              <select
                value={generationInfo.kind}
                disabled={!generationInfo.available || launchBusy}
                onChange={(event) => onGenerationKind(event.target.value as AgentGenerationKind)}
              >
                {generationKindOptions.map((value) => <option key={value} value={value}>{value === 'image' ? 'Image' : value === 'video' ? 'Video' : 'Audio'}</option>)}
              </select>
            </label>
            <label className="agent-panel-label">Result model
              <select
                value={generationInfo.modelId ?? ''}
                disabled={!generationInfo.available || launchBusy}
                onChange={(event) => onGenerationModel(event.target.value)}
              >
                {generationInfo.modelOptions.filter((model) => model.active || model.id === generationInfo.modelId).map((model) => <option key={model.id} value={model.id}>{model.name}{model.active ? '' : ' · unavailable'}</option>)}
              </select>
            </label>
          </div>}
          {generationInfo.available && <p className="agent-input-help">Model: <strong>{generationInfo.modelLabel}</strong>{generationCeiling && generationCeiling > 1 ? ` · up to ${generationCeiling} paid generations` : ' · one result'}. Estimate: {formatUsdMicros(generationInfo.estimatedCostMicros)}.</p>}
          {!generationInfo.available && <InlineNotice tone="warning" system title="Result unavailable" detail={generationInfo.unavailableReason ?? 'This computer has not approved the model connection.'} />}
          {generationInfo.available && <>
            <p className="agent-input-help">Selected files: {generationArtifactLabels.length ? generationArtifactLabels.join(' · ') : 'none'}. The order is preserved.</p>
            <label className="agent-trust-check">
              <input type="checkbox" checked={generationMediaConsentGranted} disabled={launchBusy} onChange={(event) => onGenerationConsent(event.target.checked)} />
              <span>I allow this computer to send the selected files to the selected model.</span>
            </label>
          </>}
        </div>
      )}
      <label className="agent-panel-label">Spending limit, $
        <input
          value={budgetDraft.input}
          onChange={(event) => onBudgetInput(event.target.value)}
          placeholder="for example, 0.50"
          inputMode="decimal"
          aria-describedby="agent-llm-budget-help"
        />
      </label>
      {budgetDraft.input && parsedBudget.error && <span className="agent-input-error" role="alert">{parsedBudget.error}</span>}
      {parsedBudget.amountMicros !== null && !parsedBudget.error && <span className="agent-input-help">Total limit: {formatUsdMicros(parsedBudget.amountMicros)}.</span>}
      {llmInfo && <label className="agent-trust-check">
        <input type="checkbox" checked={consentGranted} onChange={(event) => onLlmConsent(event.target.checked)} />
        <span>I allow this computer to send the instructions to the selected model.</span>
      </label>}
      <p id="agent-llm-budget-help" className="agent-input-help">The limit is checked first; after the response, spending and the balance are shown. The last call may slightly exceed the estimate.</p>
      {!compact && llmInfo && <details className="agent-llm-context">
        <summary>What will be sent (text only)</summary>
        <pre>{contextPreview}</pre>
        <span className="agent-input-help">refs=[]: selected images, videos, and other media are not sent to the LLM.</span>
      </details>}
    </div>
  )
}

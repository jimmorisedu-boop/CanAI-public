import type { AgentPackageSummary, AgentPackageTaskTypeSummary } from '../../../../../packages/agent-protocol/index'
import { AgentTaskForm } from './AgentTaskForm'
import type { AgentTaskInputErrors, AgentTaskInputValues } from './agentPackageModel'
import type { AgentPanelController } from './agentPanelController'
import { packageIsDemo } from './agentLaunchHelpers'
import { useT } from '../../../i18n/context.js'


export function AgentLaunchFields({
  controller,
  selectedPackage,
  readyPackages,
  selectedType,
  taskInput,
  inputErrors,
  compact,
  onPackageChange,
  onTaskTypeChange,
  onInputChange,
  onInstructionChange,
}: {
  controller: AgentPanelController
  selectedPackage: AgentPackageSummary
  readyPackages: readonly AgentPackageSummary[]
  selectedType: AgentPackageTaskTypeSummary | undefined
  taskInput: AgentTaskInputValues
  inputErrors: AgentTaskInputErrors
  compact: boolean
  onPackageChange(value: string): void
  onTaskTypeChange(value: string): void
  onInputChange(key: string, value: unknown): void
  onInstructionChange(value: string): void
}) {
  const t = useT()
  const hasTaskFields = Boolean(selectedType?.inputSchema?.fields.length)
  return <>
    <div className="agent-launch-choice-row">
      {readyPackages.length > 1 ? (
        <label className="agent-panel-label">

          {t('Agent')}
          <select value={selectedPackage.id} onChange={(event) => onPackageChange(event.target.value)}>
            {readyPackages.map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.name}{packageIsDemo(pkg.id, pkg.name) ? t(' · demo') : ''}</option>)}
          </select>
        </label>
      ) : (
        <div className="agent-panel-value" aria-label={t('Agent')}><span>{t('Agent')}</span><strong>{selectedPackage.name}{packageIsDemo(selectedPackage.id, selectedPackage.name) ? t(' · demo') : ''}</strong></div>
      )}
      {(selectedPackage.taskTypes ?? []).length > 1 ? (
        <label className="agent-panel-label">

          {t('Task type')}
          <select value={selectedType?.id ?? ''} onChange={(event) => onTaskTypeChange(event.target.value)}>
            {(selectedPackage.taskTypes ?? []).map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
          </select>
        </label>
      ) : (
        <div className="agent-panel-value" aria-label={t('Task type')}><span>{t('Task type')}</span><strong>{selectedType?.label ?? '—'}</strong></div>
      )}
    </div>
    <label className="agent-panel-label">

      {t('Instructions')}
      <textarea
        aria-label={t('Instructions for the agent')}
        value={controller.instruction}
        onChange={(event) => onInstructionChange(event.target.value)}
        placeholder={t('What should be done…')}
        rows={3}
      />
    </label>
    {hasTaskFields && (compact ? (
      <details className="agent-task-advanced" open={Object.keys(inputErrors).length > 0}>
        <summary>{t('Additional parameters')}{Object.keys(inputErrors).length > 0 ? t(' · required') : ''}</summary>
        <AgentTaskForm schema={selectedType?.inputSchema} values={taskInput} errors={inputErrors} onChange={onInputChange} />
      </details>
    ) : (
      <AgentTaskForm schema={selectedType?.inputSchema} values={taskInput} errors={inputErrors} onChange={onInputChange} />
    ))}
  </>
}

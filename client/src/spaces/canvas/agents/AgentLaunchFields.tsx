import type { AgentPackageSummary, AgentPackageTaskTypeSummary } from '../../../../../packages/agent-protocol/index'
import { AgentTaskForm } from './AgentTaskForm'
import type { AgentTaskInputErrors, AgentTaskInputValues } from './agentPackageModel'
import type { AgentPanelController } from './agentPanelController'
import { packageIsDemo } from './agentLaunchHelpers'

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
  const hasTaskFields = Boolean(selectedType?.inputSchema?.fields.length)
  return <>
    <div className="agent-launch-choice-row">
      {readyPackages.length > 1 ? (
        <label className="agent-panel-label">
          Agent
          <select value={selectedPackage.id} onChange={(event) => onPackageChange(event.target.value)}>
            {readyPackages.map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.name}{packageIsDemo(pkg.id, pkg.name) ? ' · demo' : ''}</option>)}
          </select>
        </label>
      ) : (
        <div className="agent-panel-value" aria-label="Agent"><span>Agent</span><strong>{selectedPackage.name}{packageIsDemo(selectedPackage.id, selectedPackage.name) ? ' · demo' : ''}</strong></div>
      )}
      {(selectedPackage.taskTypes ?? []).length > 1 ? (
        <label className="agent-panel-label">
          Task type
          <select value={selectedType?.id ?? ''} onChange={(event) => onTaskTypeChange(event.target.value)}>
            {(selectedPackage.taskTypes ?? []).map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
          </select>
        </label>
      ) : (
        <div className="agent-panel-value" aria-label="Task type"><span>Task type</span><strong>{selectedType?.label ?? '—'}</strong></div>
      )}
    </div>
    <label className="agent-panel-label">
      Instructions
      <textarea
        aria-label="Instructions for the agent"
        value={controller.instruction}
        onChange={(event) => onInstructionChange(event.target.value)}
        placeholder="What should be done…"
        rows={3}
      />
    </label>
    {hasTaskFields && (compact ? (
      <details className="agent-task-advanced" open={Object.keys(inputErrors).length > 0}>
        <summary>Additional parameters{Object.keys(inputErrors).length > 0 ? ' · required' : ''}</summary>
        <AgentTaskForm schema={selectedType?.inputSchema} values={taskInput} errors={inputErrors} onChange={onInputChange} />
      </details>
    ) : (
      <AgentTaskForm schema={selectedType?.inputSchema} values={taskInput} errors={inputErrors} onChange={onInputChange} />
    ))}
  </>
}

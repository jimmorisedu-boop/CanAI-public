import type { AgentInputSchemaView } from '../../../../../packages/agent-protocol/index'
import type { AgentTaskInputErrors, AgentTaskInputValues } from './agentPackageModel'

export function AgentTaskForm({
  schema,
  values,
  errors,
  onChange,
}: {
  schema: AgentInputSchemaView | undefined
  values: AgentTaskInputValues
  errors: AgentTaskInputErrors
  onChange(key: string, value: unknown): void
}) {
  if (!schema || schema.fields.length === 0) return null
  return (
    <div className="agent-task-inputs" aria-label="Task parameters">
      {schema.fields.map((field) => {
        const integer = (field as typeof field & { integer?: boolean }).integer === true
        const label = `${field.label ?? field.key}${field.required ? ' · required' : ''}`
        const error = errors[field.key]
        const descriptionId = field.description ? `agent-input-${field.key}-description` : undefined
        const errorId = error ? `agent-input-${field.key}-error` : undefined
        const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined
        if (field.kind === 'boolean') {
          return (
            <label className="agent-task-input-check" key={field.key}>
              <input
                type="checkbox"
                checked={values[field.key] === true}
                onChange={(event) => onChange(field.key, event.target.checked)}
                aria-describedby={describedBy}
              />
              <span>
                <strong>{label}</strong>
                {field.description && <small id={descriptionId}>{field.description}</small>}
              </span>
            </label>
          )
        }
        return (
          <label className="agent-panel-label" key={field.key}>
            {label}
            {field.kind === 'enum' ? (
              <select
                value={typeof values[field.key] === 'string' ? values[field.key] as string : ''}
                onChange={(event) => onChange(field.key, event.target.value || undefined)}
                aria-invalid={Boolean(error)}
                aria-describedby={describedBy}
              >
                <option value="">Choose…</option>
                {(field.enum ?? []).map((value) => <option value={value} key={value}>{value}</option>)}
              </select>
            ) : (
              <input
                type={field.kind === 'number' ? 'number' : 'text'}
                value={values[field.key] === undefined ? '' : String(values[field.key])}
                min={field.minimum}
                max={field.maximum}
                step={integer ? 1 : undefined}
                minLength={field.minLength}
                maxLength={field.maxLength}
                onChange={(event) => onChange(
                  field.key,
                  field.kind === 'number'
                    ? (event.target.value === '' ? undefined : Number(event.target.value))
                    : event.target.value,
                )}
                aria-invalid={Boolean(error)}
                aria-describedby={describedBy}
              />
            )}
            {field.description && <small id={descriptionId} className="agent-input-help">{field.description}</small>}
            {error && <small id={errorId} className="agent-input-error">{error}</small>}
          </label>
        )
      })}
    </div>
  )
}

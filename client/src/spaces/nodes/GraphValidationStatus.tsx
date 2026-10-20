import React from 'react'
import { pluralRu, type GraphDiagnosticSummary } from './graphDiagnostics'

interface Props {
  summary: GraphDiagnosticSummary
  diagnosticsOpen: boolean
  onToggle: () => void
}

function statusText(summary: GraphDiagnosticSummary): string {
  return summary.warnings > 0
    ? `${summary.label} · ${summary.warnings} ${pluralRu(summary.warnings, 'warning', 'warnings', 'warnings')}`
    : summary.label
}

export function GraphValidationStatus({
  summary,
  diagnosticsOpen,
  onToggle,
}: Props) {
  const className = `nodes-validation-status ${
    summary.errors > 0
      ? 'error'
      : summary.warnings > 0
        ? 'warning'
        : 'success'
  }`
  const label = statusText(summary)

  if (summary.errors === 0 && summary.warnings === 0) {
    return (
      <span className={className} role="status" title={label} aria-label={label} />
    )
  }
  return (
    <button
      type="button"
      className={className}
      onClick={onToggle}
      aria-expanded={diagnosticsOpen}
      aria-controls="graph-diagnostics-panel"
      title={label}
      aria-label={label}
    />
  )
}

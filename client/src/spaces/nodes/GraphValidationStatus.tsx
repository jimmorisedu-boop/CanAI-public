import React from 'react'
import type { GraphDiagnosticSummary } from './graphDiagnostics'
import { useT } from '../../i18n/context.js'

interface Props {
  summary: GraphDiagnosticSummary
  diagnosticsOpen: boolean
  onToggle: () => void
}

function statusText(summary: GraphDiagnosticSummary, t: (key: string, params?: Record<number, unknown>) => string): string {
  const base = summary.errors > 0
    ? t(summary.errors === 1 ? '{0} error' : '{0} errors', { 0: summary.errors })
    : t('Valid')
  return summary.warnings > 0
    ? `${base} · ${t(summary.warnings === 1 ? '{0} warning' : '{0} warnings', { 0: summary.warnings })}`
    : base
}

export function GraphValidationStatus({
  summary,
  diagnosticsOpen,
  onToggle,
}: Props) {
  const t = useT()
  const className = `nodes-validation-status ${
    summary.errors > 0
      ? 'error'
      : summary.warnings > 0
        ? 'warning'
        : 'success'
  }`
  const label = statusText(summary, t)

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

import React from 'react'
import type { GraphDiagnostic } from './graphDiagnostics'

interface Props {
  diagnostics: GraphDiagnostic[]
  onFocus: (diagnostic: GraphDiagnostic) => void
}

export function GraphDiagnosticsPanel({ diagnostics, onFocus }: Props) {
  if (diagnostics.length === 0) return null
  return (
    <aside
      id="graph-diagnostics-panel"
      className="graph-diagnostics-panel"
      aria-label="Graph issues"
    >
      <div className="graph-diagnostics-title">Graph issues</div>
      {diagnostics.map((diagnostic, index) => {
        const content = (
          <>
            <span>{diagnostic.severity === 'error' ? 'Error' : 'Warning'}</span>
            <b>{diagnostic.message}</b>
          </>
        )
        const key = `${diagnostic.code}:${diagnostic.nodeId ?? 'graph'}:${index}`
        return diagnostic.nodeId ? (
          <button
            key={key}
            type="button"
            className={`graph-diagnostic ${diagnostic.severity}`}
            onClick={() => onFocus(diagnostic)}
          >
            {content}
          </button>
        ) : (
          <div
            key={key}
            className={`graph-diagnostic ${diagnostic.severity}`}
            role="status"
          >
            {content}
          </div>
        )
      })}
    </aside>
  )
}

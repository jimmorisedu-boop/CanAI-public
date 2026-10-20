import React, { useRef, useState } from 'react'
import { api } from '../api'
import { clientBuild, formatBuild } from '../diag/buildInfo'
import { dumpLogText } from '../diag/log'
import { downloadTextFile } from '../diag/logFile'
import { InlineNotice } from '../ui/InlineNotice'
import { problemReportFileName, problemReportView, type ProblemReportOutcome } from './problemReportModel'

export function ProblemReport({ serverBuildLine }: { serverBuildLine: string }) {
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<ProblemReportOutcome | null>(null)
  const busy = useRef(false)

  async function saveFile(): Promise<void> {
    if (busy.current) return
    busy.current = true
    setSaving(true)
    setOutcome(null)
    try {
      const { report } = await api.problemReportBundle({
        description,
        clientLog: dumpLogText({ 'Server build': serverBuildLine }),
        clientBuild: formatBuild(clientBuild()),
        userAgent: navigator.userAgent,
      })
      const name = problemReportFileName()
      downloadTextFile(name, JSON.stringify(report, null, 2), 'application/json;charset=utf-8')
      setOutcome({ kind: 'saved', name })
    } catch (error) {
      setOutcome({ kind: 'failed', message: error instanceof Error ? error.message : 'Could not build report' })
    } finally {
      busy.current = false
      setSaving(false)
    }
  }
  const view = outcome ? problemReportView(outcome) : null

  return <section className="settings-section problem-report" aria-labelledby="problem-report-title">
    <div className="settings-section-heading"><div>
      <h3 id="problem-report-title">Report a problem</h3>
      <p>Describe what happened and roughly when. Save a report with app and server logs to share with support. Keys, passwords, and images are excluded.</p>
    </div></div>
    <textarea className="ui-field problem-report-text" aria-labelledby="problem-report-title" rows={3} maxLength={4000}
      placeholder="Example: around 14:20, a generated image disappeared from the “Untitled” board"
      value={description} onChange={event => setDescription(event.target.value)} />
    <div className="diag-actions"><button type="button" className="ui-btn" disabled={saving} onClick={() => { void saveFile() }}>
      {saving ? 'Saving…' : 'Save report as file'}
    </button></div>
    {view && <InlineNotice tone={view.tone} title={view.title} detail={view.detail} onDismiss={() => setOutcome(null)} />}
  </section>
}

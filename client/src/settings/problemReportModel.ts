import { systemErrorMessage } from '../ui/systemMessage'

export type ProblemReportOutcome =
  | { kind: 'saved'; name: string }
  | { kind: 'failed'; message: string }

export function problemReportView(outcome: ProblemReportOutcome): {
  tone: 'success' | 'error'; title: string; detail: string
} {
  return outcome.kind === 'saved'
    ? { tone: 'success', title: 'Report saved', detail: outcome.name }
    : { tone: 'error', title: 'Could not save report', detail: systemErrorMessage(outcome.message) }
}

export function problemReportFileName(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `canai-report-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}.json`
}

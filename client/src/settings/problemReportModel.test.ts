import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { problemReportFileName, problemReportView } from './problemReportModel.js'
import { SYSTEM_ERROR_FALLBACK } from '../ui/systemMessage.js'

test('local report names the saved file and preserves useful failure details', () => {
  const saved = problemReportView({ kind: 'saved', name: 'report.json' })
  assert.equal(saved.tone, 'success')
  assert.equal(saved.detail, 'report.json')
  assert.equal(problemReportView({ kind: 'failed', message: 'причина словами' }).detail, SYSTEM_ERROR_FALLBACK)
  assert.equal(problemReportView({ kind: 'failed', message: 'Service unavailable; try again later' }).detail, 'Service unavailable; try again later')
})

test('local report only downloads a bundle and does not send it to a service', () => {
  const component = readFileSync(new URL('./ProblemReport.tsx', import.meta.url), 'utf8')
  assert.match(component, /api\.problemReportBundle/u)
  assert.doesNotMatch(component, /sendProblemReport|Send to team/u)
})

test('имя файла отчёта — по дате и времени', () => {
  assert.equal(problemReportFileName(new Date(2026, 8, 27, 9, 5)), 'canai-report-2026-09-27-0905.json')
})

import { Router } from 'express'
import { buildDiagnosticReport, parseReportInput } from './diagnosticReport.js'

export function createDiagnosticRouter() {
  const router = Router()
  router.post('/report', (req, res) => {
    try {
      if (req.body?.mode !== 'bundle') {
        return res.status(400).json({ code: 'BUNDLE_REQUIRED', error: 'Save the report as a local file' })
      }
      const input = parseReportInput(req.body)
      const report = buildDiagnosticReport(input)
      return res.json({ report })
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Could not collect report' })
    }
  })
  return router
}

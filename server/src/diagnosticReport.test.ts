import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { buildDiagnosticReport, parseReportInput, serverLogTail } from './diagnosticReport.js'
import { createDiagnosticRouter } from './diagnosticRoutes.js'
import { redactReportText } from './reportRedact.js'

// Пункт 5.9: «Сообщить о проблеме» — жалоба уходит вместе с журналами.

const FAL_KEY = '12345678-1234-1234-1234-123456789abc:0123456789abcdef0123456789abcdef'

test('в отчёт не попадают ключи и картинки, журнал сервера — хвостом от старого к новому', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canai-report-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const old = path.join(dir, 'server.log.old')
  const current = path.join(dir, 'server.log')
  fs.writeFileSync(old, 'СТАРЫЙ\n')
  fs.writeFileSync(current, `НОВЫЙ ${FAL_KEY}\n`)
  assert.equal(serverLogTail([old, current]), `СТАРЫЙ\nНОВЫЙ ${FAL_KEY}\n`)
  assert.equal(serverLogTail([path.join(dir, 'нет'), current], 5), '…[beginning truncated]\ncdef\n')

  const report = buildDiagnosticReport(parseReportInput({
    description: `  пропала картинка, ключ ${FAL_KEY}  `,
    clientLog: `картинка data:image/png;base64,${'A'.repeat(500)} конец`,
    clientBuild: 'abc123',
    userAgent: 'Chrome',
  }), { serverLog: serverLogTail([old, current]) })
  const json = JSON.stringify(report)
  assert.ok(!json.includes(FAL_KEY), 'ключ fal не уезжает никуда')
  assert.ok(!json.includes('A'.repeat(100)), 'картинка не уезжает')
  assert.equal(report.description, 'пропала картинка, ключ [key hidden]')
  assert.match(report.server.log, /СТАРЫЙ\nНОВЫЙ \[key hidden\]/u)
  assert.match(report.server.build, /^CanAI /u)
  assert.equal(typeof report.server.info.falConfigured, 'boolean')
  assert.equal(report.source, 'desktop')
})

test('шаблоны чистки ловят и кириллические имена полей', () => {
  assert.equal(redactReportText('пароль: qwerty12345'), 'пароль: [hidden]')
  assert.equal(redactReportText('authorization: Bearer abcdefghijklmnop123'), 'authorization: [hidden]')
  assert.equal(
    redactReportText('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.xyzxyzxyzxyzxyz готово'),
    'token=[hidden] готово',
  )
})

async function serve(t: import('node:test').TestContext) {
  const app = express()
  app.use(express.json({ limit: '50mb' }))
  app.use('/api/diagnostics', createDiagnosticRouter())
  const server = http.createServer(app)
  t.after(() => server.close())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Нет тестового порта')
  return async (body: unknown) => {
    const response = await fetch('http://127.0.0.1:' + address.port + '/api/diagnostics/report', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
}

test('локальный отчёт сохраняется только как bundle', async (t) => {
  const call = await serve(t)
  const input = { description: 'не открылась доска', clientLog: 'журнал', clientBuild: 'b', userAgent: 'u' }
  const bundle = await call({ ...input, mode: 'bundle' })
  assert.equal(bundle.status, 200)
  assert.equal((bundle.body.report as { description: string }).description, 'не открылась доска')
  const send = await call({ ...input, mode: 'send' })
  assert.equal(send.status, 400)
})

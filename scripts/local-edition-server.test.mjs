import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  isLocalServerSourcePath,
  transformLocalServerSource,
} from './local-edition-server.mjs'

test('local routes and runner keep validation errors without excluded Cloud dependencies', () => {
  const routes = transformLocalServerSource('server/src/routes.ts', fs.readFileSync('server/src/routes.ts', 'utf8'))
  assert.equal(isLocalServerSourcePath('server/src/cloudFailureBody.ts'), false)
  assert.doesNotMatch(routes, /cloudFailureBody/)
  const runner = transformLocalServerSource('server/src/runner.ts', fs.readFileSync('server/src/runner.ts', 'utf8'))
  assert.doesNotMatch(runner, /\bCloudError\b|\bCloudAccountError\b/)
  assert.match(runner, /err instanceof JobRefsRefusedError\s*\? err\.message\s*: falErrorMessage\(err\)/)
  const guard = transformLocalServerSource('server/src/jobRefsGuard.ts', fs.readFileSync('server/src/jobRefsGuard.ts', 'utf8'))
  assert.doesNotMatch(guard, /cloudJobId|account-cloud|legacy-cloud|target\.source/)
  assert.match(guard, /job\.falRequestId \|\| job\.paidResult\?\.url/)
  assert.match(guard, /validateModelRefs\(job\.model, job\.kind, \[\.\.\.refs\]\)/)
})

test('local server boundary drops Cloud transport files but keeps local host/presence', () => {
  for (const path of [
    'server/src/cloudAccount.ts',
    'server/src/cloudBoardGateway.ts',
    'server/src/agents/cloud-api.ts',
    'server/src/boardCopyManifest.ts',
    'server/src/accountCloudRun.ts',
  ]) assert.equal(isLocalServerSourcePath(path), false, path)
  for (const path of [
    'server/src/index.ts',
    'server/src/boardPresence.ts',
    'server/src/canvasDelivery.ts',
    'server/src/continuityRoutes.ts',
    'server/src/agents/routes.ts',
    'server/src/diagnosticRoutes.ts',
  ]) assert.equal(isLocalServerSourcePath(path), true, path)
  assert.equal(isLocalServerSourcePath('../server/src/index.ts'), false)
  assert.equal(isLocalServerSourcePath('C:/repo/server/src/index.ts'), false)
})

test('local server transform preserves presence, agent startup, and local routes', () => {
  const index = transformLocalServerSource('server/src/index.ts', fs.readFileSync('server/src/index.ts', 'utf8'))
  assert.match(index, /startPresenceWarmup\(\)/u)
  assert.match(index, /startAgentRuntime\(\)/u)
  assert.match(index, /agentHost\.close\(\)/u)
  assert.doesNotMatch(index, /attachCloudBoardGateway|cloudAccountRuntime|startCloudWarmup/u)

  const delivery = transformLocalServerSource('server/src/canvasDelivery.ts', fs.readFileSync('server/src/canvasDelivery.ts', 'utf8'))
  assert.match(delivery, /presenceWarmingUp\(\)/u)
  assert.match(delivery, /boardBusy\(target\.projectId\)/u)
  assert.doesNotMatch(delivery, /source\?: 'local' \| 'cloud'/u)

  const routes = transformLocalServerSource('server/src/routes.ts', fs.readFileSync('server/src/routes.ts', 'utf8'))
  assert.match(routes, /createAgentRouter\(agentHost/u)
  assert.match(routes, /createDiagnosticRouter\(\)/u)
  assert.doesNotMatch(routes, /apiRouter\.use\(['"]\/cloud(?:-|['"])/u)
  assert.doesNotMatch(routes, /createCloud(?:Account|Agent|Assets|Mirror|Personal)/u)
})

test('diagnostics and API smoke retain local behavior while Cloud endpoints are 404', () => {
  const diagnostics = transformLocalServerSource('server/src/diagnosticRoutes.ts', fs.readFileSync('server/src/diagnosticRoutes.ts', 'utf8'))
  assert.match(diagnostics, /req\.body\?\.mode !== 'bundle'/u)
  assert.match(diagnostics, /buildDiagnosticReport\(input\)/u)
  assert.doesNotMatch(diagnostics, /CloudAccount|sendDiagnosticReport|teamConnected/u)

  const smoke = transformLocalServerSource('server/src/apiSmoke.test.ts', fs.readFileSync('server/src/apiSmoke.test.ts', 'utf8'))
  assert.match(smoke, /fetch\(`\$\{base\}\/api\/cloud-account`\)/u)
  assert.match(smoke, /cloudAccount\.status, 404/u)
  assert.match(smoke, /legacyCloudConnect\.status, 404/u)
  assert.match(smoke, /\/api\/edit-sessions/u)
})

test('legacy shared jobs are ignored or terminally rejected before local execution', () => {
  const jobs = transformLocalServerSource('server/src/jobs.ts', fs.readFileSync('server/src/jobs.ts', 'utf8'))
  assert.match(jobs, /function isLegacyCloudJob/u)
  assert.match(jobs, /document\.jobs\.filter\(\(value\) => !isLegacyCloudJob\(value\)\)/u)
  assert.match(jobs, /value\.source === undefined \|\| value\.source === 'local'/u)

  const runner = transformLocalServerSource('server/src/runner.ts', fs.readFileSync('server/src/runner.ts', 'utf8'))
  assert.match(runner, /legacyTargetSource === 'cloud'/u)
  assert.match(runner, /legacyRoute === 'account-cloud'/u)
  assert.match(runner, /cannot resume a shared Cloud generation/u)
  assert.doesNotMatch(runner, /runViaAccountCloud|cloudClient|cloudAccountRuntime/u)
})

test('local job views redact provider recovery internals for every job', () => {
  const wait = transformLocalServerSource('server/src/jobWait.ts', fs.readFileSync('server/src/jobWait.ts', 'utf8'))
  assert.match(wait, /delete publicJob\.falEndpoint/u)
  assert.match(wait, /delete publicJob\.falRequestId/u)
  assert.match(wait, /delete publicJob\.paidResult/u)
})

test('local server package scripts remove excluded Cloud tests but keep local smoke/presence tests', () => {
  const source = JSON.stringify({ scripts: {
    pretest: 'tsx --test src/diagnosticReport.test.ts src/boardPresence.test.ts src/cloudRoute.test.ts',
    test: 'tsx --test src/apiSmoke.test.ts src/agents/host.test.ts src/cloudAccount.test.ts',
  } })
  const output = JSON.parse(transformLocalServerSource('server/package.json', source))
  assert.match(output.scripts.pretest, /diagnosticReport\.test\.ts/u)
  assert.match(output.scripts.pretest, /boardPresence\.test\.ts/u)
  assert.doesNotMatch(output.scripts.pretest, /cloudRoute/u)
  assert.match(output.scripts.test, /apiSmoke\.test\.ts/u)
  assert.match(output.scripts.test, /agents\/host\.test/u)
  assert.doesNotMatch(output.scripts.test, /cloudAccount/u)
})

test('local transformations are idempotent for already-local source', () => {
  for (const path of [
    'server/src/index.ts',
    'server/src/routes.ts',
    'server/src/jobs.ts',
    'server/src/diagnosticRoutes.ts',
    'server/src/apiSmoke.test.ts',
  ]) {
    const source = fs.readFileSync(path, 'utf8')
    const once = transformLocalServerSource(path, source)
    const twice = transformLocalServerSource(path, once)
    assert.equal(twice, once, path)
  }
})

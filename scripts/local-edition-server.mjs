import path from 'node:path'

/**
 * Server files which are part of the account/Cloud transport.  The public
 * local edition never ships these modules: leaving them in the tree makes a
 * future import (or a dynamic import from an old snapshot) enough to bring a
 * team connection back.  LAN tablet files deliberately stay outside this
 * list; they talk to the host-owned local HTTP server only.
 */
const CLOUD_SERVER_FILE_NAMES = new Set([
  'accountCloudRun.ts',
  'accountCloudRun.test.ts',
  'continuityPresence.ts',
  'continuityPresence.test.ts',
  'diagnosticRoutes.test.ts',
  'localBoardTransfer.ts',
  'personalDraftAssets.ts',
  'personalDraftAssets.test.ts',
  'personalDraftRuntime.ts',
  'personalDraftSync.ts',
  'personalDraftSync.test.ts',
  'jobWait.test.ts',
  'host-cloud.ts',
  'boardCopyManifest.ts',
  'creator.integration.test.ts',
  'catalogTransport.test.ts',
])

const CLOUD_SERVER_PATHS = new Set([
  'server/src/agents/cloud-api.ts',
  'server/src/agents/cloud-api.test.ts',
  'server/src/agents/cloud-network.test.ts',
])

/** Files that retain Cloud branches but are rewritten by the transformer. */
const MIXED_SERVER_FILES = new Set([
  'server/src/canvasActionPreparation.ts',
  'server/src/canvasActionRouteDeps.ts',
  'server/src/canvasActionRouteViews.ts',
  'server/src/canvasActionRoutes.ts',
  'server/src/canvasActionRouteErrors.ts',
  'server/src/canvasActionPreparationService.ts',
  'server/src/generationGate.ts',
  'server/src/index.ts',
  'server/src/jobWait.ts',
  'server/src/jobs.ts',
  'server/src/projectRoutes.ts',
  'server/src/refs.ts',
  'server/src/routes.ts',
  'server/src/runner.ts',
  'server/src/jobRefsGuard.ts',
  'server/src/jobRefsGuard.test.ts',
  'server/src/config.ts',
  'server/src/diagnosticRoutes.ts',
  'server/src/apiSmoke.test.ts',
  'server/src/canvasDelivery.ts',
  'server/src/canvasActionPreparation.test.ts',
  'server/src/canvasActionRoutes.test.ts',
  'server/src/canvasDelivery.test.ts',
  'server/src/idempotency.test.ts',
  'server/src/diagnosticReport.test.ts',
  'server/src/loginBrowser.ts',
  'server/src/idempotency.ts',
  'server/src/agents/runtime.ts',
  'server/src/agents/tool-results.ts',
  'server/src/agents/tools.ts',
  'server/src/agents/tool-shared.ts',
  'server/src/agents/host-shared.ts',
  'server/src/agents/host-create.ts',
  'server/src/agents/host.ts',
  'server/src/agents/routes.ts',
  'server/src/agents/llm-broker.ts',
  'server/src/agents/generation-broker.ts',
  'server/src/agents/tools.test.ts',
  'server/src/agents/host.test.ts',
  'server/src/agents/llm-broker.test.ts',
])

function normalizeRepoPath(value) {
  if (typeof value !== 'string') return null
  const raw = value.replaceAll('\\', '/')
  if (raw.startsWith('/') || /^[A-Za-z]:\//u.test(raw)) return null
  const normalized = path.posix.normalize(raw)
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return null
  return normalized.replace(/^\.\//u, '')
}

function serverFileName(relativePath) {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1)
}

function isCloudServerPath(relativePath) {
  if (!relativePath.startsWith('server/')) return false
  if (CLOUD_SERVER_PATHS.has(relativePath)) return true
  if (!relativePath.startsWith('server/src/')) return false
  const relative = relativePath.slice('server/src/'.length)
  const basename = serverFileName(relative)
  if (/^cloud[^/]*\.(?:ts|tsx|mjs|cjs)$/iu.test(basename)) return true
  if (/^cloud(?:-|_)/iu.test(relative)) return true
  return CLOUD_SERVER_FILE_NAMES.has(basename)
}

/**
 * Return whether a tracked repository path belongs in a local server export.
 * Paths outside `server/` are accepted because the common exporter asks this
 * predicate for every tree entry.  Invalid absolute/traversal paths are
 * rejected conservatively.
 */
export function isLocalServerSourcePath(value) {
  const normalized = normalizeRepoPath(value)
  if (!normalized) return false
  return !isCloudServerPath(normalized)
}

function removeImport(text, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const modulePath = specifier.startsWith('.') ? specifier : `./${specifier}`
  const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`^[ \\t]*import(?:(?!^[ \\t]*import\\b)[\\s\\S])*?from[ \\t]*["']${escapedPath}\\.js["'];?[ \\t]*\\r?\\n`, 'gmu')
  return text.replace(pattern, '')
}

function removeNamedImport(text, matcher) {
  return text.replace(new RegExp(`^[ \\t]*import[^{;\\n]*\\{[^\\n]*${matcher}[^\\n]*\\}[^\\n]*\\r?\\n`, 'gmu'), '')
}

function removeBalancedBlock(text, startPattern) {
  const start = text.search(startPattern)
  if (start < 0) return text
  const open = text.indexOf('{', start)
  if (open < 0) return text
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (char === '`') {
      quote = '`'
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        let end = index + 1
        while (text[end] === ';' || text[end] === '\r' || text[end] === '\n') end += 1
        return `${text.slice(0, start)}${text.slice(end)}`
      }
    }
  }
  return text
}

function removeCallStatement(text, startPattern) {
  const start = text.search(startPattern)
  if (start < 0) return text
  const open = text.indexOf('(', start)
  if (open < 0) return text
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '`' || char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')' && --depth === 0) {
      let end = index + 1
      if (text[end] === ';') end += 1
      while (text[end] === '\r' || text[end] === '\n') end += 1
      return `${text.slice(0, start)}${text.slice(end)}`
    }
  }
  return text
}

function removeIfBlock(text, condition) {
  const escaped = condition.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return removeBalancedBlock(text, new RegExp(`if[ \\t]*\\(${escaped}[^)]*\\)[ \\t]*\\{`, 'u'))
}

function removeElseIfBlock(text, condition) {
  const escaped = condition.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return removeBalancedBlock(text, new RegExp(`else[ \\t]+if[ \\t]*\\(${escaped}[^)]*\\)[ \\t]*\\{`, 'u'))
}

function transformIndex(text) {
  let output = text
  for (const specifier of [
    'cloudRoute',
    'cloudWarmup',
    'cloudBoardGateway',
    'cloudAccountRuntime',
    'cloudBoardCache',
    'personalDraftRuntime',
  ]) output = removeImport(output, specifier)
  output = output.replace(/^[ \t]*import \{ startRemoteServer, stopRemoteServer \} from '\.\/remoteRuntime\.js'\r?\n/mu, "import { startRemoteServer, stopRemoteServer } from './remoteRuntime.js'\n")
  output = output.replace(/^[ \t]*await initGenerationTransport\(\)\r?\n/mu, '')
  output = output.replace(/^[ \t]*await personalDraftRuntime\.start\(\)\r?\n/mu, '')
  output = output.replace(/  \/\/ Запомненная[\s\S]*?  await ensureMediaDir\(\)\r?\n/u, '  await ensureMediaDir()\n')
  output = output.replace(/  \/\/ Туннель до сервера команды:[\s\S]*?  await ensureMediaDir\(\)\r?\n/u, '  await ensureMediaDir()\n')
  output = output.replace(/  \/\/ Дорога пересматривается:[\s\S]*?  await ensureMediaDir\(\)\r?\n/u, '  await ensureMediaDir()\n')
  output = output.replace(/  const cloudBoardGateway = attachCloudBoardGateway\([\s\S]*?\r?\n  \}\)\r?\n  const shutdown/u, '  const shutdown')
  output = output.replace(/^[ \t]*cloudMirror\.stop\(\)\r?\n/mu, '')
  output = output.replace(/^[ \t]*await cloudBoardGateway\.close\(\)\r?\n/mu, '')
  output = output.replace(/^[ \t]*logError\('shutdown-cloud-board', error\)\r?\n/mu, '')
  output = output.replace(/^[ \t]*await cloudTabletPairing\.stop\(\)\r?\n/mu, '')
  output = output.replace(/^[ \t]*logError\('shutdown-cloud-tablet-pairing', error\)\r?\n/mu, '')
  output = output.replace(/^[ \t]*await personalDraftRuntime\.stop\(\)\r?\n/mu, '')
  output = output.replace(/^[ \t]*logError\('shutdown-personal-drafts', error\)\r?\n/mu, '')
  output = output.replace(/^[ \t]*cloudMirror\.start\(\)\r?\n/mu, '')
  return output
}

function transformRefs(text) {
  let output = removeImport(text, 'cloudRefAssets')
  output = output.replace(/^[ \t]*import \{ isCloudAssetSrc \} from '\.\/cloudRefAssets\.js'\r?\n/mu, '')
  output = output.replace(/isCloudAssetSrc\(item\.src\)/gu, "false")
  output = output.replace(/      \/\/ ⚠️ На КОМАНДНОЙ доске файл живёт у сервера команды, и на холсте от него\r?\n      \/\/ только ссылка `\/api\/cloud-assets\/assets\/ast_…`\. Без неё генерация по\r?\n      \/\/ референсу на сетевой доске не запускалась вовсе\.\r?\n/u, '')
  return output
}

function transformProjectRoutes(text) {
  let output = removeImport(text, 'personalDraftRuntime')
  output = output.replace(/    void \(async \(\) => \{[\s\S]*?\r?\n    \}\)\(\)\.catch\(\(\) => undefined\)\r?\n/u, '')
  return output
}

function transformGenerationGate(text) {
  let output = text
  output = output.replace(/export type GenerationRoute = 'mock' \| 'local' \| 'legacy-cloud' \| 'account-cloud'/u, "export type GenerationRoute = 'mock' | 'local'")
  const start = output.indexOf('export function selectGenerationRoute(')
  if (start >= 0) {
    const open = output.indexOf('{', output.indexOf('): GenerationRoute', start))
    let depth = 0
    for (let index = open; index < output.length; index += 1) {
      if (output[index] === '{') depth += 1
      else if (output[index] === '}' && --depth === 0) {
        const replacement = `export function selectGenerationRoute(input: {\n  projectSource: 'local'\n  localConfigured: boolean\n  mockMode: boolean\n}): GenerationRoute {\n  if (input.mockMode) return 'mock'\n  if (!input.localConfigured) throw new GenerationRouteError('Add key fal.ai in settings', 'local-provider-required')\n  return 'local'\n}`
        output = `${output.slice(0, start)}${replacement}${output.slice(index + 1)}`
        break
      }
    }
  }
  return output
}

function transformJobs(text) {
  let output = removeImport(text, 'cloudAccount')
  output = output.replace(/import type \{ AccountCloudQuote \} from '\.\/cloudAccount\.js'\r?\n/u, '')
  output = output.replace(/export interface AccountCloudQuoteBinding \{[\s\S]*?\n\}\r?\n\r?\n/u, '')
  output = output.replace(/source\?: 'local' \| 'cloud'/gu, "source?: 'local'")
  output = output.replace(/source: 'local' \| 'cloud'/gu, "source: 'local'")
  output = output.replace(/\(value\.source === 'local' \|\| value\.source === 'cloud'\)/gu, "value.source === 'local'")
  output = output.replace(/\(value\.source === undefined \|\| value\.source === 'local' \|\| value\.source === 'cloud'\)/gu, "(value.source === undefined || value.source === 'local')")
  output = output.replace(/\r?\n[ \t]*cloudJobId\?: string/gu, '')
  output = output.replace(/\r?\n[ \t]*cloudJobTerminal\?: boolean/gu, '')
  output = output.replace(/\r?\n[ \t]*accountCloudQuote\?: AccountCloudQuoteBinding/gu, '')
  output = output.replace(/\r?\n[ \t]*if \(value\.accountCloudQuote !== undefined && !isAccountCloudQuoteBinding\(value\.accountCloudQuote\)\) return null/gu, '')
  output = output.replace(/\r?\n[ \t]*if \(value\.cloudJobTerminal !== undefined && typeof value\.cloudJobTerminal !== 'boolean'\) return null/gu, '')
  output = output.replace(/\r?\n[ \t]*function isAccountCloudQuoteBinding\([\s\S]*?\n\}\r?\n/gu, '\n')
  output = output.replace(/!\['mock', 'local', 'legacy-cloud', 'account-cloud'\]\.includes\(String\(value\.generationRoute\)\)/u, "!['mock', 'local'].includes(String(value.generationRoute))")
  output = output.replace(/job\.cloudJobId \|\| /gu, '')
  output = output.replace(/interface JobsDocument \{\r?\n  version: 1\r?\n  jobs: Job\[\]\r?\n\}/u, `interface JobsDocument {\n  version: 1\n  jobs: Job[]\n  /** True when a local-edition restore dropped development Cloud jobs. */\n  legacyCloudJobsDiscarded?: boolean\n}`)
  if (!output.includes('function isLegacyCloudJob(')) output = output.replace(/function parseJobsDocument\(raw: string\): JobsDocument \{[\s\S]*?\n\}/u, `function isLegacyCloudJob(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.generationRoute === 'account-cloud' || value.generationRoute === 'legacy-cloud') return true
  if (typeof value.cloudJobId === 'string' || value.accountCloudQuote !== undefined || value.cloudJobTerminal !== undefined) return true
  const target = value.target
  return isRecord(target) && target.source === 'cloud'
}

function parseJobsDocument(raw: string): JobsDocument {
  const document = JSON.parse(raw) as Partial<JobsDocument>
  if (document.version !== 1 || !Array.isArray(document.jobs)) {
    throw new Error('jobs.json corrupted: invalid format')
  }
  // Cloud jobs from a development jobs.json are deliberately ignored. They
  // cannot be paid or resumed by the local runner, and must never fall through
  // to a local fal submit after an edition migration.
  const retained = document.jobs.filter((value) => !isLegacyCloudJob(value))
  const parsed = retained.map(parseJob)
  if (parsed.some((job) => job === null)) throw new Error('jobs.json corrupted: invalid job')
  return {
    version: 1,
    jobs: parsed as Job[],
    legacyCloudJobsDiscarded: retained.length !== document.jobs.length,
  }
}`)
  output = output.replace(/if \(removedExpired \|\| quarantined \|\| loaded\.recoveredFromBackup\) await this\.persistNow\(\)/u, 'if (removedExpired || quarantined || loaded.recoveredFromBackup || loaded.value.legacyCloudJobsDiscarded === true) await this.persistNow(loaded.value.legacyCloudJobsDiscarded === true)')
  output = output.replace(/async persistNow\(\): Promise<void>/u, 'async persistNow(sanitizeBackup = false): Promise<void>')
  output = output.replace(/      try \{\r?\n        await fs\.copyFile\(this\.file, `\$\{this\.file\}\.bak`\)\r?\n      \} catch \(err\) \{\r?\n        if \(\(err as NodeJS\.ErrnoException\)\.code !== 'ENOENT'\) throw err\r?\n      \}/u, "      if (sanitizeBackup) {\n        // During a local-edition migration both files must lose filtered Cloud\n        // records. The in-memory snapshot still contains every durable local\n        // paid/request binding, so no local recovery state is discarded.\n        await fs.writeFile(`${this.file}.bak`, contents, 'utf8')\n      } else {\n        try {\n          await fs.copyFile(this.file, `${this.file}.bak`)\n        } catch (err) {\n          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err\n        }\n      }")
  return output
}

function transformLoginBrowser(text) {
  return removeImport(text, 'cloudRoute').replace(/cloudRouteView\(\)\.proxy \?\? process\.env\.HTTPS_PROXY\?\.trim\(\) \?\? null/u, 'process.env.HTTPS_PROXY?.trim() ?? null')
}

function transformRunner(text) {
  let output = text
  for (const specifier of ['cloudClient', 'cloudAccount', 'cloudAccountRuntime', 'accountCloudRun']) {
    output = removeImport(output, specifier)
  }
  output = removeBalancedBlock(output, /[ \t]*if \(\s*job\.cloudJobId/u)
  output = output.replace(/function effectiveGenerationRoute\(job: Job\): GenerationRoute \{[\s\S]*?\n\}/u, `function effectiveGenerationRoute(job: Job): GenerationRoute {\n  return job.generationRoute ?? (config.mockMode ? 'mock' : 'local')\n}`)
  if (!output.includes('const legacyTargetSource ='))   output = output.replace(/  const executionLease = generationGate\.tryEnter\(\)/u, `  const legacyTargetSource = (job.target as unknown as { source?: unknown } | undefined)?.source
  const legacyRoute = (job as unknown as { generationRoute?: unknown }).generationRoute
  if (legacyTargetSource === 'cloud' || legacyRoute === 'account-cloud' || legacyRoute === 'legacy-cloud') {
    job.status = 'error'
    job.error = 'This local edition cannot resume a shared Cloud generation'
    job.progressText = undefined
    job.finishedAt = Date.now()
    await jobs.persistNow()
    jobs.expireLater(job.id)
    return
  }
  const executionLease = generationGate.tryEnter()`)
  output = output.replace(/    const cloudCanvasJob = [\s\S]*?\r?\n    if \(cloudCanvasJob\) \{[\s\S]*?\r?\n    \} else \{/u, '    {')
  output = removeElseIfBlock(output, "route === 'account-cloud'")
  output = output.replace(/err instanceof CloudError \|\| err instanceof CloudAccountError \|\| /u, '')
  output = output.replace(/err instanceof CloudError \|\| err instanceof CloudAccountError\r?\n        \? err\.message\r?\n        : falErrorMessage\(err\)/u, 'falErrorMessage(err)')
  output = output.replace(/      if \(job\.target\.source !== 'cloud'\) \{\r?\n[\s\S]*?        await deliverCanvasJob\(job, job\.target\)\r?\n      \}/u, '      await deliverCanvasJob(job, job.target)')
  output = output.replace(/\r?\n        && \(job\.paidResult \|\| job\.falRequestId \|\| \(job\.cloudJobId && !job\.cloudJobTerminal\)\)/u, '\n        && (job.paidResult || job.falRequestId)')
  output = output.replace(/    const cloudRecovery = route === 'account-cloud'\r?\n      && Boolean\(job\.cloudJobId\)\r?\n      && job\.cloudJobTerminal !== true\r?\n    if \(!job\.paidResult && !\(job\.falEndpoint && job\.falRequestId\) && !cloudRecovery\) continue/u, '    if (!job.paidResult && !(job.falEndpoint && job.falRequestId)) continue')
  return output
}

function transformJobRefsGuard(text) {
  return text
    .replace(/job\.falRequestId \|\| job\.cloudJobId \|\| /u, 'job.falRequestId || ')
    .replace(/^  if \(job\.generationRoute === 'account-cloud' \|\| job\.generationRoute === 'legacy-cloud'\) return null\r?\n/mu, '')
    .replace(/^  const target = job\.target\r?\n  if \([^\n]*target\.source === 'cloud'\) return null\r?\n/mu, '')
}

function transformJobRefsGuardTest(text) {
  return text
    .replace(/    const cloud = jobs\.create\([\s\S]*?    jobs\.remove\(cloud\.id\)\r?\n/u, '')
    .replace('сетевую доску и закреплённую агентом модель проверяют другие', 'закреплённую агентом модель проверяют другие')
}

function transformCanvasActionPreparation(text) {
  let output = removeImport(text, 'cloudAccount')
  output = output.replace(/import type \{ CloudAccount \} from '\.\/cloudAccount\.js'\r?\n/u, '')
  output = output.replace(/import \{ MAX_INSTRUCTIONS_CHARS \} from '\.\/assistantLimits\.js'\r?\n/u, '')
  output = output.replace(/export interface CloudCanvasActionProfile \{[\s\S]*?\n\}\r?\n\r?\n/u, '')
  output = output.replace(/export function buildCloudCanvasActionPrompt\([\s\S]*?\n\}\r?\n\r?\n/u, '')
  output = output.replace(/function cloudProfileRows\([\s\S]*?(?=\/\*\* Resolve the Cloud profile\/version)/u, '')
  output = output.replace(/\/\*\* Resolve the Cloud profile\/version[\s\S]*?(?=\/\*\* Keep the assistant type)/u, '')
  return output
}

function transformCanvasActionRouteViews(text) {
  let output = text.replace(/import type \{ AccountCloudQuote \} from '\.\/cloudAccount\.js'\r?\n/u, '')
  output = output.replace(/\r?\n[ \t]*quote: AccountCloudQuote \| null/gu, '')
  output = output.replace(/export function quoteView\([\s\S]*?\n\}\r?\n/gu, '')
  output = output.replace(/\r?\n[ \t]*quote: quoteView\(job\),/gu, '')
  return output
}

function transformCanvasActionRouteDeps(text) {
  let output = text
  output = removeImport(output, 'canvasActionPreparation')
  output = removeImport(output, 'canvasActionPreparationService')
  output = removeImport(output, 'catalogLibrary')
  for (const specifier of ['cloudAccountRuntime', 'cloudAccount', 'accountCloudRun']) output = removeImport(output, specifier)
  output = `import { resolveLocalCanvasActionProfile } from './canvasActionPreparation.js'\n${output}`
  output = output.replace(/\r?\n[ \t]*account\?: CloudAccount/gu, '')
  output = output.replace(/\r?\n[ \t]*resolveCloudProfile\?: typeof resolveCloudCanvasActionProfile/gu, '')
  output = output.replace(/\r?\n[ \t]*quoteCloud\?: \(account: CloudAccount, input: CanvasActionQuoteInput\) => Promise<AccountCloudQuoteBinding>/gu, '')
  output = output.replace(/\r?\n[ \t]*isCloudConfigured\?: \(\) => Promise<boolean>/gu, '')
  output = output.replace(/\r?\n[ \t]*defaultCloudTextModel\?: \(\) => string/gu, '')
  output = output.replace(/\r?\n[ \t]*account: cloudAccount,/gu, '')
  output = output.replace(/\r?\n[ \t]*resolveCloudProfile: resolveCloudCanvasActionProfile,/gu, '')
  output = output.replace(/\r?\n[ \t]*quoteCloud: \(account, input\) => quoteViaAccountCloud\(account, input\),/gu, '')
  output = output.replace(/\r?\n[ \t]*isCloudConfigured: \(\) => cloudAccount\.configured\(\),/gu, '')
  output = output.replace(/\r?\n[ \t]*defaultCloudTextModel: \(\) => catalogLibrary\.defaultModelId\('assistant'\) \?\? 'gemini',/gu, '')
  output = output.replace(/\r?\n[ \t]*type AccountCloudQuoteBinding,/gu, '')
  output = output.replace(/\r?\n[ \t]*quoteCloud: NonNullable<CanvasActionRouteDeps\['quoteCloud'\]>/gu, '')
  output = output.replace(/\r?\n[ \t]*resolveCloudProfile: typeof resolveCloudCanvasActionProfile,/gu, '')
  output = output.replace(/\r?\n[ \t]*isCloudConfigured: \(\) => cloudAccount\.configured\(\),/gu, '')
  return output
}

function transformCanvasActionRouteErrors(text) {
  let output = text
  output = output.replace(/import \{ JobLimitError, type AccountCloudQuoteBinding \} from '\.\/jobs\.js'/u, "import { JobLimitError } from './jobs.js'")
  output = removeBalancedBlock(output, /export function quoteMismatch\(/u)
  output = removeBalancedBlock(output, /export function quoteRequiredResponse\(/u)
  output = removeBalancedBlock(output, /export function cloudFailure\(/u)
  return output
}

function transformCanvasActionPreparationService(text) {
  let output = text
  output = output.replace(/projectRef: \{ source: 'local' \| 'cloud'; id: string \}/u, "projectRef: { source: 'local'; id: string }")
  output = output.replace(/\r?\n[ \t]*quoteId\?: string/gu, '')
  output = output.replace(/\r?\n[ \t]*quoteHash\?: string/gu, '')
  output = output.replace(/\r?\n[ \t]*quoteConfirmed\?: boolean/gu, '')
  output = output.replace(/const MAX_QUOTE_HASH = 300\r?\n/u, '')
  output = output.replace(/\r?\n[ \t]*'assistantVersionId', 'idempotencyKey', 'quoteId', 'quoteHash', 'quoteConfirmed'/u, "\n    'assistantVersionId', 'idempotencyKey'")
  output = output.replace(/\(rawProject\.source !== 'local' && rawProject\.source !== 'cloud'\)/u, "rawProject.source !== 'local'")
  output = output.replace(/\r?\n[ \t]*const quoteId = optionalStringField\([\s\S]*?\r?\n[ \t]*const quoteHash = optionalStringField\([\s\S]*?\r?\n[ \t]*if \(body\.quoteConfirmed !== undefined && typeof body\.quoteConfirmed !== 'boolean'\) \{[\s\S]*?\r?\n[ \t]*\}/u, '')
  output = output.replace(/\r?\n[ \t]*\(quoteId \? \{ quoteId \} : \{\}\),/gu, '')
  output = output.replace(/\r?\n[ \t]*\(quoteHash \? \{ quoteHash \} : \{\}\),/gu, '')
  output = output.replace(/\r?\n[ \t]*\(body\.quoteConfirmed === true \? \{ quoteConfirmed: true \} : \{\}\),/gu, '')
  output = output.replace(/, 'quoteId', 'quoteHash', 'quoteConfirmed'/gu, '')
  output = output.replace(/\r?\n[ \t]*\.\.\.\(quoteId \? \{ quoteId \} : \{\}\),/gu, '')
  output = output.replace(/\r?\n[ \t]*\.\.\.\(quoteHash \? \{ quoteHash \} : \{\}\),/gu, '')
  output = output.replace(/\r?\n[ \t]*\.\.\.\(body\.quoteConfirmed === true \? \{ quoteConfirmed: true \} : \{\}\),/gu, '')
  return output
}

function transformJobWait() {
  return `import type { Job } from './jobs.js'\n\nexport const MAX_JOB_WAIT_MS = 20_000\nexport const MAX_WAITED_JOBS = 100\n\nexport function publicLocalJob(job: Job): Record<string, unknown> {\n  const { refs: _refs, internal: _internal, canvasActionPrompt: _canvasActionPrompt, ...rest } = job\n  const publicJob = rest as Record<string, unknown>\n  delete publicJob.falEndpoint\n  delete publicJob.falRequestId\n  delete publicJob.paidResult\n  const target = job.target\n  if (target?.kind === 'canvas-action') {\n    delete publicJob.target\n    delete publicJob.params\n    delete publicJob.model\n    delete publicJob.accountCloudQuote\n    delete publicJob.falEndpoint\n    delete publicJob.falRequestId\n    delete publicJob.paidResult\n    delete publicJob.cloudJobId\n  }\n  return publicJob\n}\n\nexport function jobVersion(job: Record<string, unknown>): string {\n  const result = job.result && typeof job.result === 'object' ? job.result as Record<string, unknown> : null\n  return JSON.stringify([job.status ?? null, job.progressText ?? job.progress ?? null, job.error ?? null, result ? [result.url ?? null, result.text ?? null, result.assetId ?? null] : null])\n}\n\nexport interface JobWaitEntry {\n  id: string\n  version: string\n  job?: Record<string, unknown>\n  missing?: true\n}\n\nexport interface JobWaitDeps {\n  local(id: string): Job | undefined\n  allLocal(): Job[]\n  now(): number\n  sleep(ms: number): Promise<void>\n}\n\nexport async function waitForJobs(ids: readonly string[], seen: Readonly<Record<string, string>>, waitMs: number, deps: JobWaitDeps, signal?: { readonly aborted: boolean }): Promise<JobWaitEntry[]> {\n  const deadline = deps.now() + Math.min(Math.max(0, waitMs), MAX_JOB_WAIT_MS)\n  for (;;) {\n    const entries = ids.map((id) => {\n      const job = deps.local(id)\n      return job && !job.internal\n        ? { id, version: jobVersion(publicLocalJob(job)), job: publicLocalJob(job) }\n        : { id, version: 'missing', missing: true as const }\n    })\n    if (entries.some((entry) => entry.version !== seen[entry.id]) || deps.now() >= deadline || signal?.aborted) return entries\n    await deps.sleep(100)\n  }\n}\n`
}

function transformConfig(text) {
  return text
}

function transformDiagnosticRoutes(text) {
  return `import { Router } from 'express'\nimport { buildDiagnosticReport, parseReportInput } from './diagnosticReport.js'\n\nexport function createDiagnosticRouter() {\n  const router = Router()\n  router.post('/report', (req, res) => {\n    try {\n      if (req.body?.mode !== 'bundle') {\n        return res.status(400).json({ code: 'BUNDLE_REQUIRED', error: 'Save the report as a local file' })\n      }\n      const input = parseReportInput(req.body)\n      const report = buildDiagnosticReport(input)\n      return res.json({ report })\n    } catch (error) {\n      return res.status(500).json({ error: error instanceof Error ? error.message : 'Could not collect report' })\n    }\n  })\n  return router\n}\n`
}

function transformApiSmokeTest(text) {
  let output = text
  output = output.replace(/  const cloudAccount = await json<\{ connected: boolean; reachable: boolean \}>\(\s*\n    await fetch\(`\$\{base\}\/api\/cloud-account`\),\s*\n  \)\s*\n  assert\.deepEqual\(cloudAccount, \{ connected: false, reachable: false \}\)\s*\n  assert\.equal\(\/token\|credential\/u\.test\(JSON\.stringify\(cloudAccount\)\), false\)\s*\n/u, "  const cloudAccount = await fetch(`${base}/api/cloud-account`)\n  assert.equal(cloudAccount.status, 404)\n")
  output = output.replace(/\n  \/\/ Полный каталог динамической модели:[\s\S]*?\n  const gen =/u, '\n  const gen =')
  return output
}

function transformCanvasActionPreparationTest(text) {
  let output = text
  output = output.replace(/^[ \t]*buildCloudCanvasActionPrompt,\r?\n/mu, '')
  output = output.replace(/^[ \t]*resolveCloudCanvasActionProfile,\r?\n/mu, '')
  output = output.replace(/\r?\ntest\('selected local guidance and Cloud profile instructions influence the frozen text contract',[\s\S]*?(?=\r?\ntest\('Cloud assistant resolver)/u, `
test('selected local guidance is included in the frozen text contract', () => {
  const local = buildLocalCanvasActionSystemPrompt('DOC: лица в естественном свете')
  assert.match(local, /DOC: лица в естественном свете/u)
  assert.match(local, /style guidance only/u)
})
`)
  output = output.replace(/\r?\ntest\('Cloud assistant resolver uses the real v3 profile\/version contract and freezes version',[\s\S]*$/u, '\n')
  return output
}

function transformCanvasActionRoutesTest(text) {
  let output = text
  output = output.replace(/^[ \t]*import type \{ CloudAccount \} from '\.\/cloudAccount\.js'\r?\n/mu, '')
  output = output.replace(/^[ \t]*isCloudConfigured: async \(\) => false,\r?\n/mgu, '')
  output = output.replace(/\r?\ntest\('Cloud preparation quotes the LLM and never falls back to local generation',[\s\S]*?(?=\r?\ntest\('local action preparation accepts 0 image refs)/u, '\n')
  return output
}

function transformCanvasDeliveryTest(text) {
  return text
}

function transformIdempotencyTest(text) {
  let output = text
  output = output.replace(/\r?\n  \/\/ legacy-cloud — тоже покрывается\.[\s\S]*?(?=\r?\n\}\)\r?\n\r?\ntest\()/u, '\n')
  output = output.replace(/test\('повтор-ловля применима только к локальному и legacy-маршрутам',[\s\S]*?\r?\n\}\)\r?\n/u, `test('повтор-ловля применима только к локальному маршруту', () => {
  assert.equal(idempotencyAppliesTo('local'), true)
  assert.equal(idempotencyAppliesTo('mock'), false)
})
`)
  return output
}

function transformDiagnosticReportTest(text) {
  const start = text.search(/\r?\nasync function serve\(/u)
  if (start < 0) return text
  return `${text.slice(0, start)}
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
`
}

function transformAgentToolsTest(text) {
  let output = text
  output = output.replace(/\r?\n  const cloudOperations: string\[\] = \[\][\s\S]*?\r?\n\}\)\r?\n\s*(?=test\('paid generation results)/u, '\n})\n')
  output = output.replace(/\r?\n    \.\.\.\(projectRef\.source === 'cloud' \? \{ cloudBinding: \{ serverUrl: 'https:\/\/cloud\.test', journalScope: 'journal-owner' \} \} : \{\}\),/u, '')
  return output
}

function transformAgentHostTest(text) {
  return text.replace(/test\('cloud delivery is explicit unsupported, never a local snapshot write',[\s\S]*?\n\}\)\n/u, `test('legacy shared delivery is rejected before local execution', async (t) => {
  const fixture = await createFixture()
  t.after(async () => { await fixture.host.close(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })
  await assert.rejects(fixture.host.create(request({ requestId: 'cloud-no-local', projectRef: { source: 'cloud' as never, id: 'cloud-board' } })), (error: unknown) => error instanceof AgentHostError && error.code === 'CLOUD_AGENT_DELIVERY_UNSUPPORTED' && error.status === 409)
  assert.deepEqual(await fixture.journal.list(), [])
})
`)
}

function transformAgentLlmBrokerTest(text) {
  return text
}

function transformCanvasDelivery(text) {
  return text.replace(/source\?: 'local' \| 'cloud'/gu, "source?: 'local'")
}

function transformContinuityRoutes(text) {
  let output = removeImport(text, 'boardPresence')
  output = removeCallStatement(output, /continuityRouter\.get\('\/board-presence'/u)
  output = removeCallStatement(output, /continuityRouter\.post\('\/board-presence'/u)
  return output
}

function transformIdempotency(text) {
  return text
    .replace(/route === 'local' \|\| route === 'legacy-cloud'/u, "route === 'local'")
    .replace(/\(and legacy-cloud\)/gu, '')
}

function transformMacroRuns(text) {
  return text
}

function transformAgentRuntime(text) {
  return removeImport(text, '../cloudAccountRuntime').replace(/,\r?\n[ \t]*cloudAccount,/u, '')
}

function transformAgentToolResults(text) {
  let output = text
  output = output.replace(/type CloudTaskBinding,\r?\n/gu, '')
  output = output.replace(/type CanvasResultItem\r?\n/gu, 'type CanvasResultItem,\n')
  output = output.replace(/async function createLocalResults\([\s\S]*?(?=\nfunction transportMayHaveCommitted)/u, `async function createLocalResults(task: AgentTaskRecord, prepared: PreparedCanvasResult, operationId: string): Promise<ToolResult> {\n  const project = projectId(task)\n  if (presenceWarmingUp() || boardBusy(project)) {\n    return {\n      pending: { waitId: 'canvas-save:' + task.taskId + ':' + safeSegment(operationId) },\n      result: { workspaceId: prepared.workspaceId, items: prepared.items },\n    }\n  }\n  let deferredByPresence = false\n  const outcome = await mutateProjectSnapshot(project, (raw) => {\n    if (presenceWarmingUp() || boardBusy(project)) {\n      deferredByPresence = true\n      return null\n    }\n    return localCanvasSnapshot(prepared, task, raw)\n  })\n  if (deferredByPresence) {\n    return {\n      pending: { waitId: 'canvas-save:' + task.taskId + ':' + safeSegment(operationId) },\n      result: { workspaceId: prepared.workspaceId, items: prepared.items },\n    }\n  }\n  if (outcome === 'not-found') throw new AgentToolError('BOARD_NOT_FOUND', 'Local board is unavailable')\n  return { result: { workspaceId: prepared.workspaceId, items: prepared.items } }\n}\n`)
  output = output.replace(/\nfunction transportMayHaveCommitted[\s\S]*?\nexport function createResults\(/u, '\nexport function createResults(')
  output = output.replace(/export function createResults\([\s\S]*?\n\}\r?\n/gu, `export function createResults(\n  task: AgentTaskRecord,\n  args: Record<string, unknown>,\n  operationId: string,\n  _options: ToolBrokerOptions,\n): Promise<ToolResult> {\n  const prepared = prepareCanvasResults(task, args)\n  return createLocalResults(task, prepared, operationId)\n}\n`)
  return output
}

function transformAgentToolShared(text) {
  let output = text
  output = output.replace(/  \/\*\* Authenticated Cloud transport\.[\s\S]*?\n  \}\r?\n/gu, '')
  output = output.replace(/export interface CloudTaskBinding \{[\s\S]*?\n\}\r?\n\r?\n/u, '')
  return output
}

function transformAgentTools(text) {
  let output = text
  output = output.replace(/type CloudTaskBinding,\r?\n/gu, '')
  output = output.replace(/AgentToolError\r?\n[ \t]*type ToolBrokerOptions/gu, 'AgentToolError,\n  type ToolBrokerOptions')
  output = output.replace(/  supportsCloudDelivery\(\): boolean \{[\s\S]*?(?=  async execute\()/u, '')
  output = output.replace(/    if \(task\.projectRef\.source === 'cloud' && task\.cloudBinding\) await this\.assertCloudBinding\(task\.cloudBinding\)\r?\n/u, '')
  output = output.replace(/      if \(task\.projectRef\.source !== 'local'\) throw new AgentToolError\('UNSUPPORTED_TOOL', 'Reading the Cloud board requires a separate shared Host'\)\r?\n/u, '')
  return output.replace(/projectSource: 'local' \| 'cloud'/gu, "projectSource: 'local'")
}

function transformAgentHostShared(text) {
  // Keep the legacy discriminator in the compatibility type so persisted
  // Cloud tasks can still be identified and rejected before any local work.
  return text
}

function transformAgentHostCreate(text) {
  let output = removeImport(text, 'host-cloud')
  if (!output.includes("if (input.projectRef.source !== 'local') throw new AgentHostError"))   output = output.replace(/if \(!input\.projectRef \|\| \(input\.projectRef\.source !== 'local' && input\.projectRef\.source !== 'cloud'\)\) throw new AgentHostError\('INPUT_INVALID', 'Invalid projectRef\.source'\)/u, "if (!input.projectRef || (input.projectRef.source !== 'local' && input.projectRef.source !== 'cloud')) throw new AgentHostError('INPUT_INVALID', 'Invalid projectRef.source')\n  if (input.projectRef.source !== 'local') throw new AgentHostError('CLOUD_AGENT_DELIVERY_UNSUPPORTED', 'The local Host cannot execute a shared Cloud task', 409)")
  output = output.replace(/\r?\n[ \t]*if \(input\.projectRef\.source === 'cloud' && input\.capturedArtifacts\?\.length\) \{[\s\S]*?\r?\n[ \t]*\}/u, '')
  output = output.replace(/\r?\n[ \t]*if \(input\.projectRef\.source === 'cloud' && !supportsCloudDelivery\([\s\S]*?\r?\n[ \t]*const cloudBinding = [^\n]*\r?\n/u, '')
  output = output.replace(/,\s*\.\.\.\(cloudBinding \? \{ cloudBinding \} : \{\}\)/u, '')
  output = output.replace(/,\s*\.\.\.\(cloudBinding \? \{ cloudBinding \} : \{\}\)/u, '')
  output = output.replace(/context\.broker\.prepareLlmTask\(taskId, input\.projectRef\.source,/u, "context.broker.prepareLlmTask(taskId, input.projectRef.source as 'local',")
  output = output.replace(/(taskId,\r?\n[ \t]*)input\.projectRef\.source,/u, "$1input.projectRef.source as 'local',")
  return output
}

function transformAgentHost(text) {
  let output = removeImport(text, 'host-cloud')
  output = output.replace(/^[ \t]*if \(task\.projectRef\.source === 'cloud' && !supportsCloudDelivery\(this\.options\.broker\)\) throw new AgentHostError\([^\n]*\)\r?\n/mu, "    if (task.projectRef.source !== 'local') throw new AgentHostError('CLOUD_AGENT_DELIVERY_UNSUPPORTED', 'The local Host cannot execute a shared Cloud task', 409)\n")
  if (!output.includes("entry.error = { code: 'CLOUD_AGENT_DELIVERY_UNSUPPORTED'"))   output = output.replace(/(if \(TERMINAL\.has\(task\.state\) \|\| task\.state === 'paused'\) continue\r?\n)/u, "$1      if (task.projectRef.source !== 'local') {\n        await this.options.journal.mutate(task.taskId, (entry) => {\n          entry.state = 'failed'\n          entry.error = { code: 'CLOUD_AGENT_DELIVERY_UNSUPPORTED', message: 'The local Host cannot resume a shared Cloud task', retryable: false }\n        }, { type: 'task.failed', payload: { code: 'CLOUD_AGENT_DELIVERY_UNSUPPORTED' } })\n        continue\n      }\n")
  output = removeBalancedBlock(output, /if \(task\.projectRef\.source === 'cloud' && !supportsCloudDelivery\(/u)
  output = removeBalancedBlock(output, /if \(task\.projectRef\.source === 'cloud'\) \{/u)
  return output
}

function transformAgentRoutes(text) {
  let output = text
  output = output.replace(/function rejectRemoteCloudCreate\([\s\S]*?\n\}\r?\n\r?\n/u, `function rejectRemoteCloudCreate(response: Response, body: Record<string, unknown>): void {
  if (!remoteTablet(response)) return
  const project = body.projectRef
  if (project && typeof project === 'object' && !Array.isArray(project)
    && (project as Record<string, unknown>).source !== 'local') {
    throw new AgentHostError(
      'REMOTE_CLOUD_TASK_DENIED',
      'The tablet controls only local Desktop Host tasks',
      403,
    )
  }
}

`)
  output = output.replace(/function hiddenRemoteCloudTask\([\s\S]*?\n\}\r?\n\r?\n/u, `function hiddenRemoteCloudTask(response: Response, task: Awaited<ReturnType<AgentHost['get']>>): boolean {
  const source = task && typeof task === 'object' && task.projectRef && typeof task.projectRef === 'object'
    ? (task.projectRef as { source?: unknown }).source
    : undefined
  if (!remoteTablet(response) || !task || source === 'local') return false
  response.status(404).json({ error: 'Agent task not found', code: 'TASK_NOT_FOUND' })
  return true
}

`)
  output = output.replace(/source: project\.source as 'local' \| 'cloud'/gu, "source: 'local'")
  output = output.replace(/body\.projectRef as \{ source: 'local' \| 'cloud'; id: string \}/gu, "body.projectRef as { source: 'local'; id: string }")
  return output
}

function transformAgentLlmBroker(text) {
  return text
}

function transformAgentGenerationBroker(text) {
  return text
}

function transformCanvasActionRoutes(text) {
  let output = text
  output = removeImport(output, 'canvasActionPreparation')
  output = removeImport(output, 'jobs')
  output = removeImport(output, 'canvasActionRouteErrors')
  output = `import { buildLocalCanvasActionSystemPrompt, resolveLocalCanvasActionProfile, type LocalCanvasActionProfile } from './canvasActionPreparation.js'\nimport { JobLimitError, MAX_LIVE_JOBS, type Job } from './jobs.js'\nimport { profileError, routeError } from './canvasActionRouteErrors.js'\n${output}`
  output = output.replace(/\r?\n[ \t]*if \(input\.projectRef\.source === 'local' && input\.profileVersionId != null\) \{[\s\S]*?\r?\n[ \t]*\}/u, '')
  output = output.replace(/let profile: LocalCanvasActionProfile \| CloudCanvasActionProfile \| null = null/u, 'let profile: LocalCanvasActionProfile | null = null')
  output = output.replace(/        if \(input\.projectRef\.source === 'cloud'\) \{[\s\S]*?        \} else \{/u, '        {')
  output = output.replace(/projectSource: input\.projectRef\.source,\r?\n            localConfigured: deps\.isLocalConfigured\(\),\r?\n            accountCloudConfigured: await deps\.isCloudConfigured\(\),\r?\n            mockMode: deps\.mockMode\(\),/u, "projectSource: 'local',\n            localConfigured: deps.isLocalConfigured(),\n            mockMode: deps.mockMode(),")
  output = output.replace(/error\.code === 'local-provider-required' \|\| error\.code === 'legacy-cloud-required'/u, "error.code === 'local-provider-required'")
  output = output.replace(/        let cloudBinding: AccountCloudQuoteBinding \| undefined[\s\S]*?\r?\n        \}\r?\n\r?\n        const target/u, '        const target')
  output = output.replace(/source: input\.projectRef\.source,/u, "source: 'local' as const,")
  output = output.replace(/assistantVersionId: profile && 'versionId' in profile \? profile\.versionId : null,/u, 'assistantVersionId: null,')
  output = output.replace(/\r?\n[ \t]*if \(cloudBinding\) job\.accountCloudQuote = cloudBinding/gu, '')
  return output
}

function transformPackageJson(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return text }
  if (!parsed || typeof parsed !== 'object' || !parsed.scripts || typeof parsed.scripts !== 'object') return text
  const scripts = { ...parsed.scripts }
  const removedScriptNames = new Set()
  for (const key of Object.keys(scripts)) {
    const value = scripts[key]
    if (typeof value !== 'string') continue
    if (key === 'test:cloud-agents' || /cloud/i.test(key) && /test/i.test(key)) {
      delete scripts[key]
      removedScriptNames.add(key)
      continue
    }
  }
  const removedScriptPattern = removedScriptNames.size > 0
    ? new RegExp(`\\bnpm\\s+run\\s+(?:${[...removedScriptNames].map((name) => name.replace(/[^A-Za-z0-9:_-]/gu, '\\\\$&')).join('|')})\\b`, 'gu')
    : null
  for (const key of Object.keys(scripts)) {
    const value = scripts[key]
    if (typeof value !== 'string') continue
    const withoutRemovedScripts = removedScriptPattern ? value.replace(removedScriptPattern, '') : value
    let filtered = withoutRemovedScripts
      .split(/(\s+)/u)
      .filter((token) => {
        const normalized = token.replaceAll('\\', '/')
        if (!/(?:^|\/)src\/.*\.test\.(?:ts|tsx|mjs)$/iu.test(normalized)) return true
        const srcIndex = normalized.indexOf('src/')
        if (srcIndex < 0) return true
        return !isCloudServerPath(`server/${normalized.slice(srcIndex)}`)
      })
      .join('')
    while (/\s*&&\s*&&\s*/u.test(filtered)) filtered = filtered.replace(/\s*&&\s*&&\s*/gu, ' && ')
    scripts[key] = filtered.replace(/^\s*&&\s*|\s*&&\s*$/gu, '').replace(/\s{2,}/gu, ' ').trim()
  }
  parsed.scripts = scripts
  return `${JSON.stringify(parsed, null, 2)}\n`
}

/**
 * Rewrite a mixed source file for the local edition.  The transformation is
 * intentionally pure and idempotent: applying it to an already-local file
 * returns byte-identical output whenever no Cloud construct remains.
 */
export function transformLocalServerSource(value, text) {
  const relativePath = normalizeRepoPath(value)
  if (!relativePath || typeof text !== 'string') return text
  if (relativePath === 'server/package.json') return transformPackageJson(text)
  if (!MIXED_SERVER_FILES.has(relativePath)) return text
  if (relativePath === 'server/src/index.ts') return transformIndex(text)
  if (relativePath === 'server/src/routes.ts') return transformRoutes(text)
  if (relativePath === 'server/src/refs.ts') return transformRefs(text)
  if (relativePath === 'server/src/projectRoutes.ts') return transformProjectRoutes(text)
  if (relativePath === 'server/src/generationGate.ts') return transformGenerationGate(text)
  if (relativePath === 'server/src/jobs.ts') return transformJobs(text)
  if (relativePath === 'server/src/loginBrowser.ts') return transformLoginBrowser(text)
  if (relativePath === 'server/src/runner.ts') return transformRunner(text)
  if (relativePath === 'server/src/jobRefsGuard.ts') return transformJobRefsGuard(text)
  if (relativePath === 'server/src/jobRefsGuard.test.ts') return transformJobRefsGuardTest(text)
  if (relativePath === 'server/src/canvasActionPreparation.ts') return transformCanvasActionPreparation(text)
  if (relativePath === 'server/src/canvasActionPreparationService.ts') return transformCanvasActionPreparationService(text)
  if (relativePath === 'server/src/canvasActionRouteErrors.ts') return transformCanvasActionRouteErrors(text)
  if (relativePath === 'server/src/canvasActionRouteViews.ts') return transformCanvasActionRouteViews(text)
  if (relativePath === 'server/src/canvasActionRouteDeps.ts') return transformCanvasActionRouteDeps(text)
  if (relativePath === 'server/src/canvasActionRoutes.ts') return transformCanvasActionRoutes(text)
  if (relativePath === 'server/src/jobWait.ts') return transformJobWait(text)
  if (relativePath === 'server/src/config.ts') return transformConfig(text)
  if (relativePath === 'server/src/diagnosticRoutes.ts') return transformDiagnosticRoutes(text)
  if (relativePath === 'server/src/apiSmoke.test.ts') return transformApiSmokeTest(text)
  if (relativePath === 'server/src/canvasActionPreparation.test.ts') return transformCanvasActionPreparationTest(text)
  if (relativePath === 'server/src/canvasActionRoutes.test.ts') return transformCanvasActionRoutesTest(text)
  if (relativePath === 'server/src/canvasDelivery.ts') return transformCanvasDelivery(text)
  if (relativePath === 'server/src/canvasDelivery.test.ts') return transformCanvasDeliveryTest(text)
  if (relativePath === 'server/src/idempotency.test.ts') return transformIdempotencyTest(text)
  if (relativePath === 'server/src/diagnosticReport.test.ts') return transformDiagnosticReportTest(text)
  if (relativePath === 'server/src/continuityRoutes.ts') return transformContinuityRoutes(text)
  if (relativePath === 'server/src/idempotency.ts') return transformIdempotency(text)
  if (relativePath === 'server/src/macroRuns.ts') return transformMacroRuns(text)
  if (relativePath === 'server/src/agents/runtime.ts') return transformAgentRuntime(text)
  if (relativePath === 'server/src/agents/tool-results.ts') return transformAgentToolResults(text)
  if (relativePath === 'server/src/agents/tools.ts') return transformAgentTools(text)
  if (relativePath === 'server/src/agents/tool-shared.ts') return transformAgentToolShared(text)
  if (relativePath === 'server/src/agents/host-shared.ts') return transformAgentHostShared(text)
  if (relativePath === 'server/src/agents/host-create.ts') return transformAgentHostCreate(text)
  if (relativePath === 'server/src/agents/host.ts') return transformAgentHost(text)
  if (relativePath === 'server/src/agents/routes.ts') return transformAgentRoutes(text)
  if (relativePath === 'server/src/agents/llm-broker.ts') return transformAgentLlmBroker(text)
  if (relativePath === 'server/src/agents/generation-broker.ts') return transformAgentGenerationBroker(text)
  if (relativePath === 'server/src/agents/tools.test.ts') return transformAgentToolsTest(text)
  if (relativePath === 'server/src/agents/host.test.ts') return transformAgentHostTest(text)
  if (relativePath === 'server/src/agents/llm-broker.test.ts') return transformAgentLlmBrokerTest(text)
  return text
}

function transformRoutes(text) {
  // The route file is intentionally handled with anchored removals rather
  // than a broad "cloud" regex: local generation, fal billing, workflows,
  // macros, editor and LAN tablet routes must remain intact.
  let output = text
  for (const specifier of [
    'accountCloudRun',
    'cloudRefUploads',
    'cloudAccountRoutes',
    'cloudAccountRuntime',
    'cloudMirrorRoutes',
    'cloudTabletPairing',
    'cloudAccount',
    'cloudAssets',
    'cloudPromptChats',
    'cloudMacros',
    'cloudJobStatus',
    'cloudFailureBody',
    'personalDraftRuntime',
    'agents/cloud-api',
  ]) output = removeImport(output, specifier)
  output = output.replace(/, type AccountCloudQuoteBinding/gu, '')
  output = output.replace(/^[ \t]*import \{ cloudRefsError, quoteViaAccountCloud \} from '\.\/accountCloudRun\.js'\r?\n/mu, '')
  output = output.replace(/^[ \t]*import \{ cloudRefCapabilitiesFor \} from '\.\/cloudRefUploads\.js'\r?\n/mu, '')
  output = output.replace(/^[ \t]*import \{ createCloudAccountRouter, createCloudPersonalBoardsRouter \} from '\.\/cloudAccountRoutes\.js'\r?\n/mu, '')
  output = removeImport(output, 'cloudAccountRuntime')
  // Local job waiting stays available; the transformed jobWait module only
  // looks at this process' durable queue.
  output = output.replace(/^[ \t]*import \{ personalDraftRuntime, prepareLocalBoardCopyTransfer, resetLocalBoardAssets \} from '\.\/personalDraftRuntime\.js'\r?\n/mu, '')
  output = output.replace(/^[ \t]*import \{ CloudAccountError \} from '\.\/cloudAccount\.js'\r?\n/mu, '')
  output = output.replace(/^[ \t]*import \{ createCloudAgentApiRouter \} from '\.\/agents\/cloud-api\.js'\r?\n/mu, '')
  output = output.replace(/^[ \t]*import \{ diagnosticRouter \} from '\.\/diagnosticRoutes\.js'\r?\n/mu, '')
  output = output.replace(/^[ \t]*import \{ cloudJobFailureStatus \} from '\.\/cloudJobStatus\.js'\r?\n/mu, '')
  output = output.replace(/^[ \t]*import \{ cancelCloudAssistantJob, cloudAssistantJob, parseCloudAssistantJobId \} from '\.\/cloudPromptChats\.js'\r?\n/mu, '')
  output = output.replace(/^[ \t]*import \{ cancelCloudMacroJob, cloudMacroJob, parseCloudMacroJobId \} from '\.\/cloudMacros\.js'\r?\n/mu, '')
  output = output.replace(/\/\/ Desktop Cloud-agent bridge\.[\s\S]*?\/\/ own authenticated Cloud API\.\r?\n/u, '')
  output = output.replace(/\/\*\*\r?\n \* ⚠️ Ловился только `CloudAccountError`[\s\S]*? \*\/\r?\n/u, '')
  output = output.replace(/apiRouter\.use\('\/diagnostics',\s*createDiagnosticRouter\(cloudAccount\)\)/u, "apiRouter.use('/diagnostics', createDiagnosticRouter())")
  for (const route of ['/cloud-account', '/cloud-mirror', '/cloud', '/cloud-assets']) {
    const routePattern = new RegExp(`apiRouter\\.use\\(['"]${route}['"]`, 'u')
    while (routePattern.test(output)) output = removeCallStatement(output, routePattern)
  }
  output = output.replace(/^[ \t]*accountCloudConfigured: await cloudAccount\.configured\(\),\r?\n/mu, '')
  output = output.replace(/, quoteId: rawQuoteId, quoteHash: rawQuoteHash,\r?\n[ \t]*quoteConfirmed: rawQuoteConfirmed/gu, '')
  output = output.replace(/\r?\n[ \t]*quoteId\?: unknown\r?\n[ \t]*quoteHash\?: unknown\r?\n[ \t]*quoteConfirmed\?: unknown/gu, '')
  output = output.replace(/^[ \t]*let cloudBinding: AccountCloudQuoteBinding \| undefined\r?\n/mu, '')
  output = output.replace(/^[ \t]*accountCloudConfigured: await cloudAccount\.configured\(\),\r?\n/mu, '')
  output = output.replace(/function parseCanvasTarget\(value: unknown\): CanvasJobTarget \| undefined \{[\s\S]*?\n\}\r?\n/u, `function parseCanvasTarget(value: unknown): CanvasJobTarget & { source: 'local' } | undefined {\n  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined\n  const raw = value as Record<string, unknown>\n  if (raw.kind !== 'canvas') return undefined\n  const nested = raw.projectRef && typeof raw.projectRef === 'object' && !Array.isArray(raw.projectRef) ? raw.projectRef as Record<string, unknown> : null\n  const projectId = nested?.id ?? raw.projectId\n  if (typeof projectId !== 'string' || !SHORT_ID_RE.test(projectId)) return undefined\n  if (nested?.source !== undefined && nested.source !== 'local') return undefined\n  if (typeof raw.placeholderId !== 'string' || !SHORT_ID_RE.test(raw.placeholderId)) return undefined\n  return { kind: 'canvas', projectId, placeholderId: raw.placeholderId, source: 'local' }\n}\n\n`)
  output = removeBalancedBlock(output, /interface ParsedCloudGeneration/u)
  output = output.replace(/function parseParams\(raw: unknown, cloudModel = false\)/u, 'function parseParams(raw: unknown)')
  output = output.replace(/parseParams\(rawParams, cloudModel\)/gu, 'parseParams(rawParams)')
  output = output.replace(/entries\.length > \(cloudModel \? 54 : 30\)/u, 'entries.length > 30')
  output = output.replace(/const field = cloudModel && k\.startsWith\('custom__'\) \? k\.slice\('custom__'\.length\) : k/u, 'const field = k')
  output = output.replace(/function parseCloudGenerationBody\([\s\S]*?(?=\/\*\*\r?\n \* Отказ сервера команды)/u, '')
  output = removeBalancedBlock(output, /function quoteResponse\(/u)
  output = removeBalancedBlock(output, /function quoteMismatch\(/u)
  output = removeBalancedBlock(output, /function quoteRequiredResponse\(/u)
  output = removeBalancedBlock(output, /async function cloudQuoteFor\(/u)
  output = removeBalancedBlock(output, /function cloudFailure\(/u)
  output = removeCallStatement(output, /apiRouter\.post\('\/generation-quotes'/u)
  output = output.replace(/const cloudModel = target\?\.source === 'cloud'\r?\n/gu, 'const localModel = false\n')
  output = output.replace(/target\?\.source === 'cloud'/gu, 'false')
  output = output.replace(/\bcloudModel\b/gu, 'localModel')
  output = output.replace(/\r?\n[ \t]*\|\| error\.code === 'legacy-cloud-required'/gu, '')
  output = output.replace(/\r?\n[ \t]*const capabilities = await cloudRefCapabilitiesFor\([\s\S]*?\r?\n[ \t]*refLimitError = capabilities \? cloudRefsError\(refs, capabilities\) : null/gu, '')
  output = output.replace(/let refLimitError: string \| null[\s\S]*?\n  \}\r?\n  if \(refLimitError\)/u, "const refLimitError = validateModelRefs(resolvedModel, kind, refs)\n  if (refLimitError)")
  output = removeBalancedBlock(output, /if \(generationRoute === 'account-cloud'/u)
  output = output.replace(/\r?\n[ \t]*if \(cloudBinding\) job\.accountCloudQuote = cloudBinding/gu, '')
  output = output.replace(/  if \(parseCloudMacroJobId\(req\.params\.id\)\) \{[\s\S]*?\n  \}\r?\n  if \(parseCloudAssistantJobId\(req\.params\.id\)\) \{[\s\S]*?\n  \}\r?\n/u, '')
  output = output.replace(/const jobWaitDeps: JobWaitDeps = \{[\s\S]*?\r?\n\}\r?\n/u, `const jobWaitDeps: JobWaitDeps = {\n  local: (id) => jobs.get(id),\n  allLocal: () => jobs.all(),\n  now: () => Date.now(),\n  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),\n}\n`)
  output = output.replace(/  try \{\r?\n    if \(await cancelCloudMacroJob\([\s\S]*?\r?\n  \}\r?\n  try \{/u, '  try {\n')
  output = output.replace(/boardSource !== undefined && boardSource !== 'cloud' && boardSource !== 'local'/u, "boardSource !== undefined && boardSource !== 'local'")
  output = output.replace(/\r?\n[ \t]*\(boardSource === 'cloud' \? \{ boardSource: 'cloud' as const \} : \{\}\),/u, '')
  output = output.replace(/^[ \t]*\.\.\.\(boardSource === 'cloud' \? \{ boardSource: 'cloud' as const \} : \{\}\),\r?\n/mu, '')
  output = output.replace(/\/\*\* Отказ по задаче сервера команды[\s\S]*?\n\}\r?\n\r?\n(?=apiRouter\.get\('\/jobs\/:id')/u, '')
  output = output.replace(/\/\/ ⚠️ Серверная идемпотентность \(пункт плана аудита 4\): ЛОКАЛЬНЫЕ и legacy-cloud[\s\S]*?\n  \/\/ account-cloud повтор-ловля уже стоит выше\. Находим созданную задачу и\r?\n/gu, '')
  return output
}

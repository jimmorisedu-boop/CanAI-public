import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CONFIG = path.join(SCRIPT_ROOT, '.gitleaks.toml')
const SKIP_DIRS = new Set(['.git', 'node_modules', 'runtime', 'data', 'dist', 'artifacts', 'outputs', 'dist-package'])
const FAL_ASSIGNMENT_RE = /(?<![\w.])\b(?:FAL_KEY|FAL_API_KEY)\b\s*(?:=|:)\s*(["'`]?)([A-Za-z0-9_-]{16,}(?::[A-Za-z0-9_-]{16,})?)\1/giu
const GITHUB_TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu

// These values are test inputs, never credentials. Each allowance is tied to
// the exact tracked fixture path and exact literal, rather than a test/docs
// directory or a broad UUID pattern.
const SAFE_FIXTURES = new Map([
  ['scripts/make-dist.test.mjs', new Set(['synthetic-test-key', 'synthetic-backup-key'])],
  ['scripts/migrate-data.test.mjs', new Set(['synthetic-old-key', 'synthetic-new-key'])],
  ['scripts/smoke-distribution.test.mjs', new Set(['must-not-be-read'])],
  ['scripts/update-secret-backup.test.mjs', new Set(['test-key-from-installation-a'])],
  ['server/src/agents/host-wire.test.ts', new Set(['tlv_00000000-0000-0000-0000-000000000000'])],
  ['server/src/diagnosticReport.test.ts', new Set(['12345678-1234-1234-1234-123456789abc:0123456789abcdef0123456789abcdef'])],
])

function posix(value) {
  return String(value).replaceAll('\\', '/')
}

function allowedFixture(relativePath, value) {
  return SAFE_FIXTURES.get(posix(relativePath))?.has(value) === true
}

function redacted(value) {
  return String(value)
    .replace(/[A-Za-z0-9_-]{16,}(?::[A-Za-z0-9_-]{16,})?/gu, '[redacted]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{10,}/gu, '[redacted]')
    .replace(/github_pat_[A-Za-z0-9_]{10,}/gu, '[redacted]')
}

async function walkFiles(root, current = root, output = []) {
  const entries = await fs.readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walkFiles(root, absolute, output)
      continue
    }
    if (entry.isSymbolicLink()) {
      output.push({ path: posix(path.relative(root, absolute)), symlink: true })
      continue
    }
    if (entry.isFile()) output.push({ path: posix(path.relative(root, absolute)), absolute })
  }
  return output
}

export async function scanDirectory(root, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const findings = []
  const files = await walkFiles(root)
  for (const file of files) {
    if (file.symlink) {
      findings.push({ rule: 'symlink', path: file.path })
      continue
    }
    const stat = await fs.stat(file.absolute)
    if (stat.size > maxBytes) continue
    const data = await fs.readFile(file.absolute)
    if (data.includes(0)) continue
    const text = data.toString('utf8')
    for (const match of text.matchAll(FAL_ASSIGNMENT_RE)) {
      const value = match[2]
      if (!allowedFixture(file.path, value)) findings.push({ rule: 'canai-fal-key', path: file.path })
    }
    if (GITHUB_TOKEN_RE.test(text)) findings.push({ rule: 'github-token', path: file.path })
    GITHUB_TOKEN_RE.lastIndex = 0
  }
  return { findings, filesScanned: files.length }
}

function runGitleaks({ source, mode, binary, config }) {
  if (!binary) return { available: false, findings: [] }
  // Relative finding paths keep the same exact fixture policy for Git and directory scans.
  const args = mode === 'git'
    ? ['git', '--log-opts=--all', '--redact', '--no-banner', '--config', config]
    : ['dir', '.', '--redact', '--no-banner', '--config', config]
  const result = spawnSync(binary, args, { cwd: source, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error?.code === 'ENOENT') return { available: false, findings: [] }
  if (result.error) throw result.error
  if (result.status === 0) return { available: true, findings: [] }
  return {
    available: true,
    findings: [{ rule: 'gitleaks', path: mode === 'git' ? '<git-history>' : '.', detail: redacted(result.stderr || result.stdout) }],
  }
}

export async function scanSecrets({ source, mode = 'dir', gitleaks, config = DEFAULT_CONFIG, requireGitleaks = false }) {
  if (!source) throw new Error('An explicit --source directory is required')
  const root = path.resolve(source)
  const local = mode === 'dir' ? await scanDirectory(root) : { findings: [], filesScanned: 0 }
  const binary = gitleaks || process.env.GITLEAKS_BIN
  const history = runGitleaks({ source: root, mode, binary, config })
  // An explicitly selected binary is an operator assertion that the full
  // Gitleaks policy must run. Never silently downgrade a failed path to the
  // lightweight assignment scan.
  if ((requireGitleaks || mode === 'git' || Boolean(binary)) && !history.available) {
    throw new Error('Gitleaks binary is required but was not found')
  }
  return { source: root, mode, filesScanned: local.filesScanned, findings: [...local.findings, ...history.findings] }
}

function parseArgs(argv) {
  const options = { source: null, mode: 'dir', gitleaks: undefined, config: DEFAULT_CONFIG, requireGitleaks: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--source') options.source = argv[++index]
    else if (arg === '--mode') options.mode = argv[++index]
    else if (arg === '--gitleaks') options.gitleaks = argv[++index]
    else if (arg === '--config') options.config = argv[++index]
    else if (arg === '--require-gitleaks') options.requireGitleaks = true
    else if (arg === '--help' || arg === '-h') return null
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!['dir', 'git'].includes(options.mode)) throw new Error('--mode must be dir or git')
  return options
}

function usage() {
  return 'Usage: node scripts/scan-secrets.mjs --source <dir> --mode dir|git [--gitleaks <binary>] [--config <path>]'
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (!options) console.log(usage())
    else {
      const result = await scanSecrets(options)
      if (result.findings.length) {
        for (const finding of result.findings) console.error(`[secret-scan] ${finding.rule} at ${finding.path}`)
        process.exitCode = 1
      } else {
        console.log(`[secret-scan] clean (${result.filesScanned} files)`)
      }
    }
  } catch (error) {
    console.error(`[secret-scan] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

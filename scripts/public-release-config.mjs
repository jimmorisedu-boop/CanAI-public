import path from 'node:path'
import { isLocalEditionSourcePath } from './local-edition.mjs'

export const PUBLIC_SOURCE_FORMAT = 'canai-public-source'
export const PUBLIC_SOURCE_VERSION = 1
export const PUBLIC_MANIFEST_NAME = 'PUBLIC-SOURCE-MANIFEST.json'
export const PUBLIC_REVISION_NAME = 'SOURCE-REVISION.txt'

export const PUBLIC_ROOTS = Object.freeze([
  'client',
  'licenses',
  'server',
  'packages',
  'scripts',
])

const ROOT_FILES = new Set([
  '.gitattributes',
  '.gitleaks.toml',
  '.gitignore',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICES.md',
  'README.md',
  'SECURITY.md',
  'TABLET-GUIDE.md',
  'THIRD-PARTY-LICENSES.txt',
  'THIRD-PARTY-NOTICES.md',
  'USER-GUIDE.md',
  'package-lock.json',
  'package.json',
  'Migrate data.bat',
  'Migrate data.command',
  'Start CanAI.bat',
  'Start CanAI.command',
  'Stop CanAI.bat',
  'Stop CanAI.command',
  'make-dist.ps1',
  'make-dist.sh',
  'migrate-data.command',
  'migrate-data.ps1',
  'start.command',
  'start.ps1',
  'stop.command',
  'stop.ps1',
])

const SAFE_WORKFLOWS = new Set([
  '.github/workflows/checks.yml',
  '.github/workflows/production-client.yml',
])

const SAFE_AUXILIARY_FILES = new Set([
  'docs/images/assistant.png',
  'docs/images/assistant.jpg',
  'docs/images/assets.jpg',
  'docs/images/canvas.jpg',
  'docs/images/help.jpg',
  'docs/images/tablet.jpg',
  'docs/images/workflows.jpg',
  'docs/help-maintenance.md',
])

/** Public screenshots that may accompany the offline Help and getting-started guide. */
export const PUBLIC_HELP_SCREENSHOT_NAMES = Object.freeze([
  'assistant',
  'assets',
  'canvas',
  'help',
  'tablet',
  'workflows',
  'gallery',
  'assistant-expanded',
  'references',
  'compare',
  'timeline',
  'trash',
  'versions',
])
const PUBLIC_HELP_SCREENSHOT_PATHS = new Set(PUBLIC_HELP_SCREENSHOT_NAMES.map(name => `docs/images/${name}.jpg`))

const EXCLUDED_SEGMENTS = new Set([
  '.git',
  'artifacts',
  'data',
  'dist',
  'dist-package',
  'dist-tablet-cloud',
  'node_modules',
  'output',
  'outputs',
  'relay',
  'releases-archive',
  'runtime',
])

export const REQUIRED_SOURCE_FILES = Object.freeze([
  '.gitleaks.toml',
  'client/package-lock.json',
  'client/package.json',
  'docs/agents/canai.agent.schema.json',
  'docs/agents/protocol.schema.json',
  'LICENSE',
  'server/package-lock.json',
  'server/package.json',
  'package-lock.json',
  'package.json',
])

export const REQUIRED_SOURCE_GROUPS = Object.freeze([
  ['docs/public/AGENTS.md', 'AGENTS.md'],
  ['docs/public/DESIGN.md', 'DESIGN.md'],
  ['docs/public/RELEASING.md', 'docs/RELEASING.md'],
  ['docs/public/AGENT-PROTOCOL.md', 'docs/agents/README.md'],
])

export function posixPath(value) {
  return String(value).replaceAll('\\', '/')
}

export function mapPublicPath(sourcePath) {
  const normalized = posixPath(sourcePath)
  if (normalized === 'docs/public/AGENTS.md') return 'AGENTS.md'
  if (normalized === 'docs/public/DESIGN.md') return 'DESIGN.md'
  if (normalized === 'docs/public/RELEASING.md') return 'docs/RELEASING.md'
  if (normalized === 'docs/public/AGENT-PROTOCOL.md') return 'docs/agents/README.md'
  return normalized
}

// Previous verified snapshots used this broader source boundary. It remains
// available only to validate their manifest before replacing them with a local
// edition. Fresh exports and candidates must use isPublicSourcePath.
export function isLegacyPublicSourcePath(sourcePath) {
  const normalized = posixPath(sourcePath)
  const segments = normalized.split('/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) return false
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false
  const basename = segments.at(-1) ?? ''
  if (/^\.env(?:\..*)?$/u.test(basename) && basename !== '.env.example') return false
  if (/\.env(?:\..*)?$/u.test(basename) && basename !== '.env.example') return false
  if (/^(?:id_(?:rsa|ed25519)|private(?:[_-]?key)?|.*privatekey.*)$/iu.test(basename)) return false
  if (/\.(?:pem|p12|pfx|privatekey)$/iu.test(basename)) return false
  if (PUBLIC_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))) return true
  if (ROOT_FILES.has(normalized)) return true
  if (SAFE_WORKFLOWS.has(normalized)) return true
  if (SAFE_AUXILIARY_FILES.has(normalized)) return true
  if (normalized === 'docs/GETTING-STARTED.md') return true
  if (normalized === 'docs/help/index.md') return false
  if (/^docs\/help\/(?:README|[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u.test(normalized)) return true
  if (PUBLIC_HELP_SCREENSHOT_PATHS.has(normalized)) return true
  if (normalized === '.github/pull_request_template.md' || normalized.startsWith('.github/ISSUE_TEMPLATE/')) return true
  if (normalized === 'AGENTS.md' || normalized === 'DESIGN.md' || normalized === 'docs/RELEASING.md' || normalized === 'docs/agents/README.md') return true
  if (/^docs\/agents\/(?:[^/]+\.(?:schema|example)\.json|examples\/.*)$/u.test(normalized)) return true
  if (/^docs\/public\/(?:AGENTS|DESIGN|RELEASING|AGENT-PROTOCOL)\.md$/u.test(normalized)) return true
  return false
}

export function isPublicSourcePath(sourcePath) {
  return isLegacyPublicSourcePath(sourcePath) && isLocalEditionSourcePath(posixPath(sourcePath))
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function publicRootFiles() {
  return [...ROOT_FILES]
}

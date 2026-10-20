import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { exportPublicSource } from './export-public-source.mjs'
import { runPublicRelease } from './public-release.mjs'
import { isPublicSourcePath, PUBLIC_HELP_SCREENSHOT_NAMES } from './public-release-config.mjs'

const SCREENSHOT_NAMES = [...PUBLIC_HELP_SCREENSHOT_NAMES]
const JPEG_SIGNATURE = Buffer.from([255, 216, 255, 224])

async function writeFiles(root, files) {
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(root, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, value)
  }
}

async function removeOwnedTemp(directory, prefix) {
  const absolute = path.resolve(directory)
  const tempRoot = path.resolve(os.tmpdir())
  const lexicalRelative = path.relative(tempRoot, absolute)
  assert.ok(lexicalRelative && !lexicalRelative.startsWith('..') && !path.isAbsolute(lexicalRelative))
  assert.ok(path.basename(absolute).startsWith(prefix))
  const stat = await fs.lstat(absolute)
  assert.equal(stat.isSymbolicLink(), false)
  assert.equal(stat.isDirectory(), true)
  const realRoot = await fs.realpath(tempRoot)
  const realTarget = await fs.realpath(absolute)
  const realRelative = path.relative(realRoot, realTarget)
  assert.ok(realRelative && !realRelative.startsWith('..') && !path.isAbsolute(realRelative))
  await fs.rm(absolute, { recursive: true, force: true })
}

async function gitFixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-public-source-'))
  const root = path.join(parent, 'repo')
  await fs.mkdir(root)
  t.after(() => removeOwnedTemp(parent, 'canai-public-source-'))
  await writeFiles(root, {
    '.gitignore': 'artifacts/\n',
    'LICENSE': 'CanAI Community License 1.0\n',
    '.gitleaks.toml': 'title = "fixture"\n',
    'README.md': '# CanAI\n',
    ...Object.fromEntries(SCREENSHOT_NAMES.map((name) => [`docs/images/${name}.jpg`, JPEG_SIGNATURE])),
    'DESIGN.md': 'Design notes\n',
    'docs/public/AGENTS.md': '# Public contributor guide\n',
    'docs/public/DESIGN.md': '# Public design guide\n',
    'docs/public/AGENT-PROTOCOL.md': '# Public agent protocol\n',
    'docs/public/RELEASING.md': '# Releasing\n',
    'docs/help-maintenance.md': '# Help maintenance\n',
    'docs/GETTING-STARTED.md': '# Getting started\n',
    'docs/help/README.md': '# Help\n',
    'docs/help/quick-start.md': '# Start a local board\n',
    'docs/agents/README.md': '# Agent protocol\n',
    'docs/agents/canai.agent.schema.json': '{"type":"object"}\n',
    'docs/agents/protocol.schema.json': '{"type":"object"}\n',
    'docs/agents/examples/happy-path.jsonl': '{"ok":true}\n',
    '.github/workflows/checks.yml': 'name: checks\n',
    '.github/pull_request_template.md': 'PR checklist\n',
    '.github/ISSUE_TEMPLATE/bug.yml': 'name: Bug\n',
    'client/src/app.ts': 'export const app = true\n',
    'server/src/index.ts': 'export const server = true\n',
    'server/package.json': '{"name":"server"}\n',
    'server/package-lock.json': '{"lockfileVersion":3}\n',
    'packages/shared/index.ts': 'export const shared = true\n',
    'client/package.json': '{"name":"client"}\n',
    'client/package-lock.json': '{"lockfileVersion":3}\n',
    'package.json': '{"name":"fixture"}\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'scripts/tool.mjs': 'export {}\n',
    'Update CanAI.bat': '@echo off\n',
    'update.ps1': '$RepoUrl = \'https://private.example.invalid/repo.git\'\n',
    'start.ps1': 'Write-Output start\n',
    'server/.env.example': 'FAL_KEY=\n',
    'AGENTS.md': 'private instructions\n',
    'relay/private.ts': 'private\n',
    'docs/agents/CLOUD.md': 'private cloud\n',
    'docs/agents/IMPLEMENTATION.md': 'private implementation\n',
    'client/dist/bundle.js': 'generated\n',
    'server/data/projects.json': '{}\n',
    'server/node_modules/pkg.js': 'dependency\n',
    'server/.env': 'FAL_KEY=secret\n',
  })
  execFileSync('git', ['-C', root, 'init', '--quiet'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'release-test@example.invalid'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Release Test'])
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture'])
  await fs.rm(path.join(root, 'server', '.env'), { force: true })
  return root
}

test('default source export belongs to its project and leaves the parent directory unchanged', async (t) => {
  const root = await gitFixture(t)
  const before = (await fs.readdir(path.dirname(root))).sort()
  const result = await exportPublicSource({ root })
  assert.equal(result.output, path.join(root, 'artifacts', 'public-source', result.sourceRevision.slice(0, 12)))
  assert.deepEqual((await fs.readdir(path.dirname(root))).sort(), before)
  assert.equal(result.files.some((entry) => entry.path.startsWith('artifacts/')), false)
  await assert.rejects(exportPublicSource({ root }), /new or empty/u)
  await assert.rejects(exportPublicSource({ root, output: path.join(root, 'client', 'export') }), /outside/u)
  await assert.rejects(exportPublicSource({ root, output: path.join(root, 'artifacts') }), /outside/u)
  await writeFiles(root, { '.gitignore': '' })
  await assert.rejects(exportPublicSource({ root, output: path.join(root, 'artifacts', 'unignored') }), /Git-ignored/u)
})

test('source check cleans its project-local workspace when the required scanner is unavailable', async (t) => {
  const root = await gitFixture(t)
  const before = (await fs.readdir(path.dirname(root))).sort()
  await assert.rejects(runPublicRelease(['check', '--root', root, '--gitleaks', path.join(root, 'missing-gitleaks')]), /gitleaks/iu)
  assert.deepEqual(await fs.readdir(path.join(root, 'artifacts', '.tmp')), [])
  assert.deepEqual((await fs.readdir(path.dirname(root))).sort(), before)
})

test('an export cannot use a source repository through a junction or symlink ancestor', async (t) => {
  const root = await gitFixture(t)
  const parent = path.dirname(root)
  const alias = path.join(parent, 'alias-parent')
  const output = path.join(parent, 'alias-export')
  await fs.symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await assert.rejects(exportPublicSource({ root: path.join(alias, path.basename(root)), output }), /symlink|resolve to itself/u)
    assert.equal(await fs.stat(output).then(() => true, () => false), false)
  } finally {
    await fs.unlink(alias)
  }
})

test('public export uses committed blobs, excludes private paths, maps public docs, and hashes modes', async (t) => {
  const root = await gitFixture(t)
  const untrackedKeyName = ['FAL', 'KEY'].join('_')
  const untrackedKeyValue = ['untracked', 'secret', 'value'].join('-')
  await fs.writeFile(path.join(root, 'server', '.env.untracked'), `${untrackedKeyName}=${untrackedKeyValue}\n`)
  const output = path.join(path.dirname(root), 'out')
  const result = await exportPublicSource({ root, output })
  assert.match(result.sourceRevision, /^[0-9a-f]{40}$/u)
  assert.equal(await fs.readFile(path.join(output, 'client/src/app.ts'), 'utf8'), 'export const app = true\n')
  assert.equal(await fs.readFile(path.join(output, 'AGENTS.md'), 'utf8'), '# Public contributor guide\n')
  assert.equal(await fs.readFile(path.join(output, 'DESIGN.md'), 'utf8'), '# Public design guide\n')
  assert.equal(await fs.readFile(path.join(output, 'docs/RELEASING.md'), 'utf8'), '# Releasing\n')
  assert.equal(await fs.readFile(path.join(output, 'docs/help-maintenance.md'), 'utf8'), '# Help maintenance\n')
  assert.equal(await fs.readFile(path.join(output, 'docs/GETTING-STARTED.md'), 'utf8'), '# Getting started\n')
  assert.equal(await fs.readFile(path.join(output, 'docs/help/README.md'), 'utf8'), '# Help\n')
  assert.equal(await fs.readFile(path.join(output, 'docs/help/quick-start.md'), 'utf8'), '# Start a local board\n')
  assert.equal(await fs.readFile(path.join(output, 'docs/agents/README.md'), 'utf8'), '# Public agent protocol\n')
  assert.equal(await fs.readFile(path.join(output, '.github/pull_request_template.md'), 'utf8'), 'PR checklist\n')
  assert.equal(await fs.readFile(path.join(output, '.github/ISSUE_TEMPLATE/bug.yml'), 'utf8'), 'name: Bug\n')
  for (const name of SCREENSHOT_NAMES) {
    assert.deepEqual(await fs.readFile(path.join(output, `docs/images/${name}.jpg`)), JPEG_SIGNATURE)
  }
  for (const excluded of [
    'relay/private.ts', 'docs/agents/CLOUD.md', 'docs/agents/IMPLEMENTATION.md',
    'Update CanAI.bat', 'update.ps1',
    'client/dist/bundle.js', 'server/data/projects.json', 'server/node_modules/pkg.js', 'server/.env',
    'server/.env.untracked',
  ]) {
    assert.equal(await fs.stat(path.join(output, excluded)).then(() => true, () => false), false, excluded)
  }
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'PUBLIC-SOURCE-MANIFEST.json'), 'utf8'))
  assert.equal(manifest.sourceRevision, result.sourceRevision)
  assert.equal(manifest.edition, 'local')
  const appEntry = manifest.files.find((file) => file.path === 'client/src/app.ts')
  const appBytes = await fs.readFile(path.join(output, 'client/src/app.ts'))
  const { createHash } = await import('node:crypto')
  assert.deepEqual(appEntry, {
    path: 'client/src/app.ts',
    mode: '100644',
    bytes: appBytes.byteLength,
    sha256: createHash('sha256').update(appBytes).digest('hex'),
  })
  assert.equal(await fs.readFile(path.join(output, 'SOURCE-REVISION.txt'), 'utf8'), `${result.sourceRevision}\n`)
})

test('public export refuses missing license, nonempty output, and symlink output', async (t) => {
  const root = await gitFixture(t)
  const noLicense = path.join(path.dirname(root), 'no-license')
  await fs.cp(root, noLicense, { recursive: true })
  execFileSync('git', ['-C', noLicense, 'rm', '--quiet', 'LICENSE'])
  execFileSync('git', ['-C', noLicense, 'commit', '--quiet', '-m', 'remove license'])
  await assert.rejects(exportPublicSource({ root: noLicense, output: path.join(path.dirname(root), 'missing-license-out') }), /LICENSE/u)

  const nonempty = path.join(path.dirname(root), 'nonempty')
  await fs.mkdir(nonempty)
  await fs.writeFile(path.join(nonempty, 'existing.txt'), 'keep')
  await assert.rejects(exportPublicSource({ root, output: nonempty }), /new or empty/u)

  if (process.platform !== 'win32') {
    const symlink = path.join(path.dirname(root), 'symlink-out')
    await fs.symlink(path.join(path.dirname(root), 'other'), symlink, 'dir')
    await assert.rejects(exportPublicSource({ root, output: symlink }), /symlink/u)
  }
})

test('public path policy keeps required runtime roots but excludes generated/private paths', () => {
  assert.equal(isPublicSourcePath('server/src/index.ts'), true)
  for (const excluded of ['client/src/spaces/canvas/collaboration/controller.ts', 'server/src/cloudBoardGateway.ts', 'scripts/network-follow-e2e.mjs', 'scripts/package-cloud-tablet.mjs', 'packages/model-catalog/cloudRefs.ts']) {
    assert.equal(isPublicSourcePath(excluded), false, excluded)
  }
  assert.equal(isPublicSourcePath('server/.env.example'), true)
  assert.equal(isPublicSourcePath('server/.env'), false)
  assert.equal(isPublicSourcePath('client/dist/index.html'), false)
  assert.equal(isPublicSourcePath('server/runtime/private.pem'), false)
  assert.equal(isPublicSourcePath('server/src/id_ed25519'), false)
  assert.equal(isPublicSourcePath('relay/index.ts'), false)
  assert.equal(isPublicSourcePath('docs/agents/canai.agent.schema.json'), true)
  // This alias is accepted when re-exporting a clean public checkout; the
  // exporter still prefers docs/public/AGENT-PROTOCOL.md in the authoring tree.
  assert.equal(isPublicSourcePath('docs/agents/README.md'), true)
  assert.equal(isPublicSourcePath('DESIGN.md'), true)
  assert.equal(isPublicSourcePath('docs/public/DESIGN.md'), true)
  assert.equal(isPublicSourcePath('docs/public/AGENT-PROTOCOL.md'), true)
  for (const name of SCREENSHOT_NAMES) assert.equal(isPublicSourcePath(`docs/images/${name}.jpg`), true)
  assert.equal(isPublicSourcePath('docs/images/assistant.png'), true)
  assert.equal(isPublicSourcePath('docs/help-maintenance.md'), true)
  assert.equal(isPublicSourcePath('docs/GETTING-STARTED.md'), true)
  assert.equal(isPublicSourcePath('docs/help/README.md'), true)
  assert.equal(isPublicSourcePath('docs/help/index.md'), false)
  assert.equal(isPublicSourcePath('docs/help/quick-start.md'), true)
  assert.equal(isPublicSourcePath('docs/help/nested/private.md'), false)
  assert.equal(isPublicSourcePath('docs/images/private.png'), false)
  assert.equal(isPublicSourcePath('docs/images/private.jpg'), false)
  assert.equal(isPublicSourcePath('docs/agents/CLOUD.md'), false)
  assert.equal(isPublicSourcePath('server/../outside.txt'), false)
  assert.equal(isPublicSourcePath('/server/src/index.ts'), false)
  assert.equal(isPublicSourcePath('C:/server/src/index.ts'), false)
})

test('local export uses committed overrides, excludes Cloud sources, and hashes final bytes', async (t) => {
  const root = await gitFixture(t)
  await writeFiles(root, {
    'client/src/cloud/secretClient.ts': 'export const networkBoard = true\n',
    'server/src/cloudBoardGateway.ts': 'export const gateway = true\n',
    'scripts/network-follow-e2e.mjs': 'export {}\n',
    'local-edition/overrides/client/src/app.ts': 'export const localOnly = true\n',
  })
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'local policy fixture'])
  await fs.writeFile(path.join(root, 'local-edition/overrides/client/src/app.ts'), 'dirty override must not ship\n')
  const output = path.join(path.dirname(root), 'local-out')
  const result = await exportPublicSource({ root, output })
  assert.equal(await fs.readFile(path.join(output, 'client/src/app.ts'), 'utf8'), 'export const localOnly = true\n')
  assert.equal(result.files.filter(file => file.path === 'client/src/app.ts').length, 1)
  assert.equal(result.files.some(file => /cloudBoardGateway|secretClient|network-follow|local-edition\/overrides/u.test(file.path)), false)
  const { createHash } = await import('node:crypto')
  assert.equal(result.files.find(file => file.path === 'client/src/app.ts').sha256, createHash('sha256').update('export const localOnly = true\n').digest('hex'))
})

test('local export regenerates and hashes Help from the filtered guide', async (t) => {
  const root = await gitFixture(t)
  const step = { title: 'Create', body: 'Create a local board.', image: '/help/quick-start-1.svg', alt: 'Create board' }
  const guide = {
    categories: [{ id: 'basics', title: 'Basics' }],
    topics: [
      { id: 'quick-start', category: 'basics', title: 'Local start', summary: 'Work on a local board.', steps: [step, step], related: ['cloud-boundary'] },
      { id: 'cloud-boundary', category: 'basics', title: 'Cloud connections', summary: 'Optional Cloud.', steps: [step, step] },
    ],
  }
  await writeFiles(root, { 'client/src/help/content/guide.json': JSON.stringify(guide), 'docs/help/cloud-boundary.md': '# Old Cloud guide\n' })
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'help fixture'])
  const output = path.join(path.dirname(root), 'help-out')
  const { files } = await exportPublicSource({ root, output })
  assert.equal(files.some(file => file.path === 'docs/help/cloud-boundary.md'), false)
  const finalGuide = JSON.parse(await fs.readFile(path.join(output, 'client/src/help/content/guide.json'), 'utf8'))
  const { renderHelpDocs } = await import('./generate-help-docs.mjs')
  const expected = renderHelpDocs(finalGuide)['quick-start.md']
  assert.equal(await fs.readFile(path.join(output, 'docs/help/quick-start.md'), 'utf8'), expected)
  const { createHash } = await import('node:crypto')
  assert.equal(files.find(file => file.path === 'docs/help/quick-start.md').sha256, createHash('sha256').update(expected).digest('hex'))
})

test('an exported snapshot can be exported again from its clean Git checkout', async (t) => {
  const root = await gitFixture(t)
  const first = path.join(path.dirname(root), 'first')
  const second = path.join(path.dirname(root), 'second')
  await exportPublicSource({ root, output: first })
  execFileSync('git', ['-C', first, 'init', '--quiet'])
  execFileSync('git', ['-C', first, 'config', 'user.email', 'release-test@example.invalid'])
  execFileSync('git', ['-C', first, 'config', 'user.name', 'Release Test'])
  execFileSync('git', ['-C', first, 'add', '-A'])
  execFileSync('git', ['-C', first, 'commit', '--quiet', '-m', 'public snapshot'])
  const result = await exportPublicSource({ root: first, output: second })
  assert.equal(result.files.some((file) => file.path === 'AGENTS.md'), true)
  assert.equal(result.files.some((file) => file.path === 'DESIGN.md'), true)
  assert.equal(result.files.some((file) => file.path === 'docs/agents/README.md'), true)
  assert.equal(result.files.some((file) => file.path === 'docs/RELEASING.md'), true)
})

test('public export rejects private aliases without a valid generated manifest', async (t) => {
  const root = await gitFixture(t)
  const aliasesOnly = path.join(path.dirname(root), 'aliases-only')
  await fs.cp(root, aliasesOnly, { recursive: true })
  execFileSync('git', ['-C', aliasesOnly, 'rm', '--quiet', '-r', 'docs/public'])
  execFileSync('git', ['-C', aliasesOnly, 'commit', '--quiet', '-m', 'remove public authoring docs'])
  await assert.rejects(
    exportPublicSource({ root: aliasesOnly, output: path.join(path.dirname(root), 'aliases-only-out') }),
    /Required public source file is missing/u,
  )

  const malformed = path.join(path.dirname(root), 'malformed-manifest')
  await fs.cp(aliasesOnly, malformed, { recursive: true })
  await fs.writeFile(path.join(malformed, 'PUBLIC-SOURCE-MANIFEST.json'), '{"format":"private","version":1}\n')
  execFileSync('git', ['-C', malformed, 'add', 'PUBLIC-SOURCE-MANIFEST.json'])
  execFileSync('git', ['-C', malformed, 'commit', '--quiet', '-m', 'add malformed manifest'])
  await assert.rejects(
    exportPublicSource({ root: malformed, output: path.join(path.dirname(root), 'malformed-out') }),
    /Invalid PUBLIC-SOURCE-MANIFEST\.json/u,
  )
})

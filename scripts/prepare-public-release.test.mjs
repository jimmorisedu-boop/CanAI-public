import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { parseArgs, preparePublicRelease } from './prepare-public-release.mjs'
import { assertNoSharedHistory, createCandidate, publishCandidate, syncCandidate, verifyCandidateManifest } from './prepare-public-release-git.mjs'
import { copyArtifacts } from './prepare-public-release-artifacts.mjs'
import { removeProjectTemp } from './project-workspace.mjs'
import { assertAuthoringCheckout, assertDisjointPaths, assertPublicCheckout, readVersion } from './prepare-public-release-guards.mjs'
import { npmInvocation, runNpmGates, runNpmInstall, runSecretScan } from './prepare-public-release-steps.mjs'
import { initRepo, git, manifestFor, tempRoot, write } from './prepare-public-release-test-helpers.mjs'
import { PUBLIC_MANIFEST_NAME, PUBLIC_REVISION_NAME } from './public-release-config.mjs'

test('release CLI defaults to sibling public checkout and supports source-only', () => {
  const options = parseArgs(['--source-only'], 'F:/Exp/CanAI')
  assert.equal(options.sourceOnly, true)
  assert.equal(options.publicRoot, path.resolve('F:/Exp/CanAI/../CanAI-public'))
  assert.throws(() => parseArgs(['--platform', 'linux'], 'F:/Exp/CanAI'), /Unsupported release platform/u)
})

test('release CLI derives output defaults from the selected authoring project', () => {
  const root = path.resolve('other-project')
  const options = parseArgs(['--source-only', '--root', root], 'F:/Exp/CanAI')
  assert.equal(options.artifactRoot, path.join(root, 'artifacts', 'public-release'))
  assert.equal(options.publicRoot, path.resolve(root, '..', 'CanAI-public'))
  const explicit = parseArgs(['--source-only', '--artifact-root', 'chosen-output', '--root', root])
  assert.equal(explicit.artifactRoot, path.resolve('chosen-output'))
})

test('release guards reject path-shaped versions', async (t) => {
  const root = await tempRoot(t)
  await write(root, 'package.json', JSON.stringify({ version: '1.2.3/escape' }))
  await assert.rejects(readVersion(root), /valid release version/u)
})

test('artifact overrides cannot write into authoring files or Git metadata', async (t) => {
  const parent = await tempRoot(t)
  const sourceRoot = path.join(parent, 'source')
  const publicRoot = path.join(parent, 'public')
  await initRepo(sourceRoot, { '.gitignore': 'artifacts/\n', 'package.json': '{"version":"1.2.3"}\n' })
  for (const artifactRoot of [sourceRoot, path.join(sourceRoot, '.git'), path.join(sourceRoot, 'foo')]) {
    await assert.rejects(assertDisjointPaths({ sourceRoot, publicRoot, artifactRoot }), /ignored artifacts/u)
  }
  await assertDisjointPaths({ sourceRoot, publicRoot, artifactRoot: path.join(sourceRoot, 'artifacts', 'release') })
  await assertDisjointPaths({ sourceRoot, publicRoot, artifactRoot: path.join(sourceRoot, 'artifacts') })
  await write(sourceRoot, '.gitignore', '')
  await assert.rejects(assertDisjointPaths({ sourceRoot, publicRoot, artifactRoot: path.join(sourceRoot, 'artifacts', 'unignored') }), /Git-ignored/u)
})

test('authoring guards refuse dirty or eligible-untracked trees, public snapshots, and overlapping paths', async (t) => {
  const parent = await tempRoot(t)
  const root = path.join(parent, 'authoring')
  await initRepo(root, { 'package.json': '{"version":"1.2.3"}\n' })
  await write(root, 'package.json', '{"version":"1.2.4"}\n')
  await assert.rejects(assertAuthoringCheckout(root), /Working tree is not clean/u)
  git(root, ['checkout', '--', 'package.json'])
  await write(root, 'client/new-public-source.ts', 'export const untracked = true\n')
  await assert.rejects(assertAuthoringCheckout(root), /Working tree is not clean/u)
  await fs.rm(path.join(root, 'client'), { recursive: true, force: true })
  await write(root, 'PUBLIC-SOURCE-MANIFEST.json', '{}\n')
  await write(root, 'SOURCE-REVISION.txt', `${'a'.repeat(40)}\n`)
  await assert.rejects(assertAuthoringCheckout(root), /public-source snapshot/u)
  await assert.rejects(assertDisjointPaths({ sourceRoot: root, publicRoot: root, artifactRoot: path.join(parent, 'artifacts') }), /overlap/u)
})

test('npm gates use the pinned Node npm CLI and scanner points at exported scripts', async (t) => {
  const root = await tempRoot(t)
  await fs.mkdir(path.join(root, 'server'))
  await fs.mkdir(path.join(root, 'client'))
  await fs.mkdir(path.join(root, 'scripts'))
  const calls = []
  const runner = async (request) => {
    calls.push(request)
    return { code: 0, output: '' }
  }
  const logs = path.join(root, 'logs')
  await runNpmGates({ workspace: root, nodePath: process.execPath, runner, logs })
  assert.equal(calls.length, 8)
  assert.equal(calls.every((call) => call.args.includes('--prefix')), true)
  assert.equal(calls.some((call) => call.args.includes('audit')), true)
  assert.equal(npmInvocation(process.execPath).file.length > 0, true)
  await runNpmInstall({ workspace: root, nodePath: process.execPath, runner, logs, label: 'candidate npm ci' })
  assert.equal(calls.slice(-3).every((call) => typeof call.file === 'string' && call.args.includes('ci')), true)
  await runSecretScan({ workspace: root, gitleaks: path.join(root, 'gitleaks'), runner, logs })
  assert.match(calls.at(-1).args[0], /scripts[\\/]scan-secrets\.mjs$/u)
  assert.equal(calls.at(-1).args.includes('--require-gitleaks'), true)
})

test('candidate publish preserves public tags/remotes and rejects shared authoring history', async (t) => {
  const parent = await tempRoot(t)
  const publicRoot = path.join(parent, 'public')
  const sourceRoot = path.join(parent, 'source')
  const candidateRoot = path.join(parent, '.canai-public-candidate-test')
  const license = 'CanAI Community License 1.0\n'
  const publicFiles = { LICENSE: license }
  const publicManifest = `${JSON.stringify(manifestFor(publicFiles), null, 2)}\n`
  await initRepo(publicRoot, {
    LICENSE: license,
    'PUBLIC-SOURCE-MANIFEST.json': publicManifest,
    'SOURCE-REVISION.txt': `${'b'.repeat(40)}\n`,
  })
  git(publicRoot, ['tag', 'keep-tag'])
  git(publicRoot, ['remote', 'add', 'origin', 'https://example.invalid/canai.git'])
  git(publicRoot, ['config', 'core.autocrlf', 'true'])
  await initRepo(sourceRoot, { 'private.txt': 'authoring\n' })
  assert.doesNotThrow(() => assertNoSharedHistory(sourceRoot, publicRoot))
  const exportRoot = path.join(parent, 'export')
  await fs.mkdir(exportRoot)
  await write(exportRoot, 'LICENSE', 'CanAI Community License 1.0 updated\n')
  const exportFiles = { LICENSE: 'CanAI Community License 1.0 updated\n' }
  await write(exportRoot, 'PUBLIC-SOURCE-MANIFEST.json', `${JSON.stringify(manifestFor(exportFiles), null, 2)}\n`)
  await write(exportRoot, 'SOURCE-REVISION.txt', `${'c'.repeat(40)}\n`)
  const info = await assertPublicCheckout(publicRoot)
  await createCandidate({ publicRoot, candidateRoot, publicInfo: info })
  assert.equal((await fs.readFile(path.join(candidateRoot, 'LICENSE'))).includes(0x0d), false)
  const candidate = await syncCandidate({ exportRoot, candidateRoot })
  assert.notEqual(candidate.commit, info.head)
  const published = await publishCandidate({ candidateRoot, publicRoot, publicInfo: info, commit: candidate.commit })
  assert.equal(published.commit, candidate.commit)
  assert.equal(git(publicRoot, ['show', 'HEAD:LICENSE']), exportFiles.LICENSE.trim())
  assert.equal(git(publicRoot, ['tag', '--list', 'keep-tag']), 'keep-tag')
  assert.equal(git(publicRoot, ['remote', 'get-url', 'origin']), 'https://example.invalid/canai.git')
  const clonedSource = path.join(parent, 'cloned-source')
  execFileSync('git', ['clone', '--quiet', publicRoot, clonedSource])
  assert.throws(() => assertNoSharedHistory(clonedSource, publicRoot), /shares authoring Git history/u)
})

test('legacy updater and Cloud entries are accepted only for migration and removed by the next export', async (t) => {
  const parent = await tempRoot(t)
  const publicRoot = path.join(parent, 'public')
  const candidateRoot = path.join(parent, '.canai-public-candidate-legacy-updater')
  const exportRoot = path.join(parent, 'export')
  const oldFiles = {
    LICENSE: 'CanAI Community License 1.0\n',
    'Update CanAI.bat': '@echo legacy updater\n',
    'update.ps1': 'Write-Output legacy\n',
    'server/src/cloudBoardGateway.ts': 'export const legacyCloud = true\n',
    'client/src/spaces/canvas/collaboration/controller.ts': 'export const legacyPeer = true\n',
  }
  const oldManifest = manifestFor(oldFiles)
  delete oldManifest.edition
  await initRepo(publicRoot, {
    ...oldFiles,
    [PUBLIC_MANIFEST_NAME]: `${JSON.stringify(oldManifest, null, 2)}\n`,
    [PUBLIC_REVISION_NAME]: `${oldManifest.sourceRevision}\n`,
  })
  const publicInfo = await assertPublicCheckout(publicRoot)
  assert.equal(publicInfo.exists, true)

  const nextFiles = { LICENSE: 'CanAI Community License 1.0 updated\n' }
  const nextManifest = manifestFor(nextFiles)
  nextManifest.sourceRevision = 'c'.repeat(40)
  await write(exportRoot, 'LICENSE', nextFiles.LICENSE)
  await write(exportRoot, PUBLIC_MANIFEST_NAME, `${JSON.stringify(nextManifest, null, 2)}\n`)
  await write(exportRoot, PUBLIC_REVISION_NAME, `${nextManifest.sourceRevision}\n`)

  await createCandidate({ publicRoot, candidateRoot, publicInfo })
  const candidate = await syncCandidate({ exportRoot, candidateRoot })
  assert.equal(git(candidateRoot, ['ls-files', '--', 'Update CanAI.bat']), '')
  assert.equal(git(candidateRoot, ['ls-files', '--', 'update.ps1']), '')
  assert.equal(git(candidateRoot, ['ls-files', '--', 'server/src/cloudBoardGateway.ts']), '')
  assert.equal(git(candidateRoot, ['ls-files', '--', 'client/src/spaces/canvas/collaboration/controller.ts']), '')
  assert.equal(git(candidateRoot, ['show', `HEAD:${PUBLIC_REVISION_NAME}`]), nextManifest.sourceRevision)
  await publishCandidate({ candidateRoot, publicRoot, publicInfo, commit: candidate.commit })
  assert.equal(git(publicRoot, ['ls-files', '--', 'Update CanAI.bat']), '')
  assert.equal(git(publicRoot, ['ls-files', '--', 'update.ps1']), '')
  assert.equal(git(publicRoot, ['show', `HEAD:${PUBLIC_REVISION_NAME}`]), nextManifest.sourceRevision)
  await assertPublicCheckout(publicRoot)

  const mislabeledRoot = path.join(parent, 'mislabeled-local')
  await initRepo(mislabeledRoot, {
    ...oldFiles,
    [PUBLIC_MANIFEST_NAME]: `${JSON.stringify({ ...oldManifest, edition: 'local' }, null, 2)}\n`,
    [PUBLIC_REVISION_NAME]: `${oldManifest.sourceRevision}\n`,
  })
  await assert.rejects(assertPublicCheckout(mislabeledRoot), /invalid path/u)

  const privateRoot = path.join(parent, 'private-manifest')
  const privateFiles = { LICENSE: oldFiles.LICENSE, 'server/.env': 'FAL_KEY=private\n' }
  const privateManifest = manifestFor(privateFiles)
  await initRepo(privateRoot, {
    ...privateFiles,
    [PUBLIC_MANIFEST_NAME]: `${JSON.stringify(privateManifest, null, 2)}\n`,
    [PUBLIC_REVISION_NAME]: `${privateManifest.sourceRevision}\n`,
  })
  await assert.rejects(assertPublicCheckout(privateRoot), /invalid path: server\/\.env/u)
})

test('source-only preparation runs injected gates and publishes an immutable artifact pointer', async (t) => {
  const parent = await tempRoot(t)
  const sourceRoot = path.join(parent, 'authoring')
  const publicRoot = path.join(parent, 'public')
  const artifactRoot = path.join(parent, 'artifacts')
  await initRepo(sourceRoot, {
    '.gitignore': 'artifacts/\n',
    'package.json': '{"name":"fixture","version":"1.2.3"}\n',
    'package-lock.json': '{"name":"fixture","lockfileVersion":3}\n',
    '.gitleaks.toml': 'title = "fixture"\n',
    LICENSE: 'CanAI Community License 1.0\n',
    'client/package.json': '{"name":"client"}\n',
    'client/package-lock.json': '{"name":"client","lockfileVersion":3}\n',
    'server/package.json': '{"name":"server"}\n',
    'server/package-lock.json': '{"name":"server","lockfileVersion":3}\n',
    'server/.env.example': 'FAL_KEY=\n',
    'docs/agents/canai.agent.schema.json': '{"type":"object"}\n',
    'docs/agents/protocol.schema.json': '{"type":"object"}\n',
    'docs/public/AGENTS.md': '# Agents\n',
    'docs/public/DESIGN.md': '# Design\n',
    'docs/public/RELEASING.md': '# Releasing\n',
    'docs/public/AGENT-PROTOCOL.md': '# Protocol\n',
    'scripts/scan-secrets.mjs': 'export {}\n',
  })
  const fakeGitleaks = path.join(parent, 'gitleaks')
  await fs.writeFile(fakeGitleaks, 'fixture\n')
  const calls = []
  const projectSiblingsBefore = (await fs.readdir(parent)).sort()
  const runner = async (request) => {
    calls.push(request)
    return { code: 0, output: '' }
  }
  const result = await preparePublicRelease({ root: sourceRoot, publicRoot, artifactRoot, sourceOnly: true, platform: null, gitleaks: fakeGitleaks }, {
    nodePath: process.execPath,
    verifyGitleaks: async () => {},
    runner,
    progress: () => {},
  })
  assert.equal(result.version, '1.2.3')
  assert.equal(await fs.stat(path.join(result.artifactDirectory, 'CanAI-1.2.3-source.zip')).then(() => true), true)
  assert.equal(await fs.stat(path.join(result.artifactDirectory, 'logs')).then(() => true), true)
  assert.equal(await fs.readFile(path.join(artifactRoot, 'latest-source.json'), 'utf8').then((text) => JSON.parse(text).publicCommit), result.candidateCommit)
  assert.equal(calls.filter((call) => call.args.includes('--require-gitleaks')).length, 2)
  assert.equal(await fs.stat(publicRoot).then(() => true), true)
  assert.deepEqual((await fs.readdir(path.join(sourceRoot, 'artifacts', '.tmp'))), [])
  assert.deepEqual((await fs.readdir(parent)).sort(), [...projectSiblingsBefore, 'public', 'artifacts'].sort())
})

test('failed source gate retains diagnostics without creating public checkout or latest pointer', async (t) => {
  const parent = await tempRoot(t)
  const sourceRoot = path.join(parent, 'authoring')
  const publicRoot = path.join(parent, 'public')
  const artifactRoot = path.join(parent, 'artifacts')
  await initRepo(sourceRoot, {
    '.gitignore': 'artifacts/\n',
    'package.json': '{"name":"fixture","version":"1.2.3"}\n',
    'package-lock.json': '{"name":"fixture","lockfileVersion":3}\n',
    '.gitleaks.toml': 'title = "fixture"\n',
    LICENSE: 'CanAI Community License 1.0\n',
    'client/package.json': '{}\n',
    'client/package-lock.json': '{"lockfileVersion":3}\n',
    'server/package.json': '{}\n',
    'server/package-lock.json': '{"lockfileVersion":3}\n',
    'server/.env.example': 'FAL_KEY=\n',
    'docs/agents/canai.agent.schema.json': '{}\n',
    'docs/agents/protocol.schema.json': '{}\n',
    'docs/public/AGENTS.md': '# Agents\n',
    'docs/public/DESIGN.md': '# Design\n',
    'docs/public/RELEASING.md': '# Releasing\n',
    'docs/public/AGENT-PROTOCOL.md': '# Protocol\n',
  })
  const gitleaks = path.join(parent, 'gitleaks')
  await fs.writeFile(gitleaks, 'fixture\n')
  const error = await preparePublicRelease({ root: sourceRoot, publicRoot, artifactRoot, sourceOnly: true, platform: null, gitleaks }, {
    nodePath: process.execPath,
    verifyGitleaks: async () => {},
    runner: async () => ({ code: 2, output: 'synthetic failure' }),
    progress: () => {},
  }).then(() => null, (failure) => failure)
  assert.ok(error)
  assert.match(error.message, /secret scan/u)
  assert.match(error.releaseStage, /canai-release-prepare-/u)
  assert.equal(path.dirname(error.releaseStage), path.join(sourceRoot, 'artifacts', '.tmp'))
  assert.equal(await fs.stat(publicRoot).then(() => true, () => false), false)
  assert.equal(await fs.stat(path.join(artifactRoot, 'latest-source.json')).then(() => true, () => false), false)
  await removeProjectTemp(sourceRoot, error.releaseStage, 'canai-release-prepare-')
})

test('public checkout guard rejects a clean committed blob whose manifest hash is stale', async (t) => {
  const parent = await tempRoot(t)
  const root = path.join(parent, 'public')
  const content = 'CanAI Community License 1.0\n'
  const manifest = manifestFor({ LICENSE: content })
  await initRepo(root, {
    LICENSE: content,
    'PUBLIC-SOURCE-MANIFEST.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'SOURCE-REVISION.txt': `${manifest.sourceRevision}\n`,
  })
  await write(root, 'LICENSE', 'manually changed but still committed\n')
  git(root, ['add', 'LICENSE'])
  git(root, ['commit', '--quiet', '-m', 'manual change'])
  await assert.rejects(assertPublicCheckout(root), /does not match manifest/u)
})

test('candidate sync can remove an executable bit when filemode detection is disabled', async (t) => {
  const parent = await tempRoot(t)
  const candidateRoot = path.join(parent, 'candidate')
  const exportRoot = path.join(parent, 'export')
  await createCandidate({ publicRoot: path.join(parent, 'public'), candidateRoot, publicInfo: { exists: false } })
  git(candidateRoot, ['config', 'core.filemode', 'false'])
  const files = { 'scripts/tool.sh': '#!/bin/sh\nexit 0\n' }
  const manifest = manifestFor(files)
  for (const [name, content] of Object.entries(files)) await write(exportRoot, name, content)
  await write(exportRoot, 'SOURCE-REVISION.txt', `${manifest.sourceRevision}\n`)
  for (const mode of ['100755', '100644']) {
    manifest.files[0].mode = mode
    await write(exportRoot, 'PUBLIC-SOURCE-MANIFEST.json', `${JSON.stringify(manifest)}\n`)
    await syncCandidate({ exportRoot, candidateRoot })
    assert.equal(verifyCandidateManifest({ candidateRoot, manifest }), true)
    assert.match(git(candidateRoot, ['ls-tree', 'HEAD', '--', 'scripts/tool.sh']), new RegExp(`^${mode}`))
  }
})

test('artifact copy retains nested logs and refuses to replace an existing release', async (t) => {
  const parent = await tempRoot(t)
  const stage = path.join(parent, 'stage')
  const destination = path.join(parent, 'release')
  await write(stage, 'source.zip', 'original archive')
  await write(stage, 'logs/check.log', 'checks passed')
  await copyArtifacts({ stage, destination })
  await write(stage, 'source.zip', 'replacement archive')
  await assert.rejects(copyArtifacts({ stage, destination }), /already exists/u)
  assert.equal(await fs.readFile(path.join(destination, 'source.zip'), 'utf8'), 'original archive')
  assert.equal(await fs.readFile(path.join(destination, 'logs/check.log'), 'utf8'), 'checks passed')
})

// Keep finalization recovery tests in a separate module while preserving the
// existing root test command's single entry point.
await import('./prepare-public-release-finalization.test.mjs')

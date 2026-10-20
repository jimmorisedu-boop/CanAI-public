import { removeProjectTemp } from './project-workspace.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { preparePublicRelease } from './prepare-public-release.mjs'
import { writeLatestPointer } from './prepare-public-release-artifacts.mjs'
import { git, sourceOnlyFixture, write } from './prepare-public-release-test-helpers.mjs'

test('publication failure is retryable without leaving an artifact destination', async (t) => {
  const fixture = await sourceOnlyFixture(t)
  const failure = await preparePublicRelease(fixture.options, {
    ...fixture.hooks,
    publishCandidate: async () => { throw new Error('synthetic publication failure') },
  }).then(() => null, (error) => error)
  assert.ok(failure)
  assert.match(failure.message, /synthetic publication failure/u)
  assert.equal(path.dirname(failure.releaseStage), path.join(fixture.sourceRoot, 'artifacts', '.tmp'))
  assert.equal(path.dirname(failure.candidateRoot), failure.releaseStage)
  assert.equal((await fs.readdir(fixture.parent)).some((name) => name.startsWith('.canai-public-candidate-')), false)
  assert.equal(await fs.stat(fixture.publicRoot).then(() => true, () => false), false)
  assert.equal((await fs.readdir(fixture.artifactRoot).catch(() => [])).length, 0)
  await removeProjectTemp(fixture.sourceRoot, failure.releaseStage, 'canai-release-prepare-')

  const result = await preparePublicRelease(fixture.options, fixture.hooks)
  assert.equal(await fs.readFile(path.join(fixture.artifactRoot, 'latest-source.json'), 'utf8').then((text) => JSON.parse(text).publicCommit), result.candidateCommit)
})

test('artifact copy failure after publication is retryable with the same revision', async (t) => {
  const fixture = await sourceOnlyFixture(t)
  const failure = await preparePublicRelease(fixture.options, {
    ...fixture.hooks,
    copyArtifacts: async () => { throw new Error('synthetic artifact copy failure') },
  }).then(() => null, (error) => error)
  assert.ok(failure)
  assert.match(failure.message, /synthetic artifact copy failure/u)
  assert.equal(await fs.stat(fixture.publicRoot).then(() => true, () => false), true)
  assert.equal(await fs.stat(path.join(fixture.artifactRoot, 'latest-source.json')).then(() => true, () => false), false)
  await removeProjectTemp(fixture.sourceRoot, failure.releaseStage, 'canai-release-prepare-')

  const result = await preparePublicRelease(fixture.options, fixture.hooks)
  assert.equal(await fs.readFile(path.join(fixture.artifactRoot, 'latest-source.json'), 'utf8').then((text) => JSON.parse(text).publicCommit), result.candidateCommit)
})

test('pointer failure reuses the sealed artifact on retry', async (t) => {
  const fixture = await sourceOnlyFixture(t)
  let failPointer = true
  const failure = await preparePublicRelease(fixture.options, {
    ...fixture.hooks,
    writeLatestPointer: async (args) => {
      if (failPointer) {
        failPointer = false
        throw new Error('synthetic pointer failure')
      }
      return writeLatestPointer(args)
    },
  }).then(() => null, (error) => error)
  assert.ok(failure)
  assert.match(failure.message, /synthetic pointer failure/u)
  assert.equal(await fs.stat(fixture.publicRoot).then(() => true, () => false), true)
  const artifactDirectory = path.join(fixture.artifactRoot, '1.2.3-' + git(fixture.sourceRoot, ['rev-parse', '--short=12', 'HEAD']) + '-source-only')
  const before = await fs.readFile(path.join(artifactDirectory, 'provenance.json'), 'utf8')
  await removeProjectTemp(fixture.sourceRoot, failure.releaseStage, 'canai-release-prepare-')

  const result = await preparePublicRelease(fixture.options, fixture.hooks)
  assert.equal(result.artifactDirectory, artifactDirectory)
  assert.equal(await fs.readFile(path.join(artifactDirectory, 'provenance.json'), 'utf8'), before)
  assert.equal(await fs.readFile(path.join(fixture.artifactRoot, 'latest-source.json'), 'utf8').then((text) => JSON.parse(text).publicCommit), result.candidateCommit)
})

test('mismatching existing artifact is rejected before public publication', async (t) => {
  const fixture = await sourceOnlyFixture(t)
  const revision = git(fixture.sourceRoot, ['rev-parse', '--short=12', 'HEAD'])
  const artifactDirectory = path.join(fixture.artifactRoot, `1.2.3-${revision}-source-only`)
  await write(artifactDirectory, 'provenance.json', `${JSON.stringify({
    format: 'canai-public-release',
    version: '1.2.3',
    sourceRevision: 'a'.repeat(40),
    publicCommit: 'b'.repeat(40),
    platform: null,
    sourceOnly: true,
  })}\n`)
  let published = false
  const failure = await preparePublicRelease(fixture.options, {
    ...fixture.hooks,
    publishCandidate: async () => { published = true; throw new Error('publication should not run') },
  }).then(() => null, (error) => error)
  assert.ok(failure)
  assert.match(failure.message, /different release/u)
  assert.equal(published, false)
  assert.equal(await fs.stat(fixture.publicRoot).then(() => true, () => false), false)
  await removeProjectTemp(fixture.sourceRoot, failure.releaseStage, 'canai-release-prepare-')
})

test('malformed existing artifact is rejected before public publication', async (t) => {
  const fixture = await sourceOnlyFixture(t)
  const revision = git(fixture.sourceRoot, ['rev-parse', '--short=12', 'HEAD'])
  const artifactDirectory = path.join(fixture.artifactRoot, `1.2.3-${revision}-source-only`)
  await write(artifactDirectory, 'provenance.json', '{not-json\n')
  let published = false
  const failure = await preparePublicRelease(fixture.options, {
    ...fixture.hooks,
    publishCandidate: async () => { published = true; throw new Error('publication should not run') },
  }).then(() => null, (error) => error)
  assert.ok(failure)
  assert.match(failure.message, /provenance is invalid/u)
  assert.equal(published, false)
  assert.equal(await fs.stat(fixture.publicRoot).then(() => true, () => false), false)
  await removeProjectTemp(fixture.sourceRoot, failure.releaseStage, 'canai-release-prepare-')
})

test('non-regular latest pointer is rejected before release work', async (t) => {
  const fixture = await sourceOnlyFixture(t)
  const pointer = path.join(fixture.artifactRoot, 'latest-source.json')
  await fs.mkdir(pointer, { recursive: true })
  let published = false
  const failure = await preparePublicRelease(fixture.options, {
    ...fixture.hooks,
    publishCandidate: async () => { published = true; throw new Error('publication should not run') },
  }).then(() => null, (error) => error)
  assert.ok(failure)
  assert.match(failure.message, /Latest pointer is not a regular file/u)
  assert.equal(published, false)
  assert.equal(await fs.stat(fixture.publicRoot).then(() => true, () => false), false)
})

test('symlink latest pointer is rejected before release work', async (t) => {
  const fixture = await sourceOnlyFixture(t)
  await fs.mkdir(fixture.artifactRoot, { recursive: true })
  const pointer = path.join(fixture.artifactRoot, 'latest-source.json')
  try {
    await fs.symlink(path.join(fixture.parent, 'pointer-target'), pointer, 'file')
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'UNKNOWN') {
      t.skip('symlinks unavailable on this test host')
      return
    }
    throw error
  }
  let published = false
  const failure = await preparePublicRelease(fixture.options, {
    ...fixture.hooks,
    publishCandidate: async () => { published = true; throw new Error('publication should not run') },
  }).then(() => null, (error) => error)
  assert.ok(failure)
  assert.match(failure.message, /Refusing symlink latest pointer/u)
  assert.equal(published, false)
  assert.equal(await fs.stat(fixture.publicRoot).then(() => true, () => false), false)
})

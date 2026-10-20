import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { makeProjectTemp, projectTempRoot, removeProjectTemp } from './project-workspace.mjs'
import { tempRoot, write } from './prepare-public-release-test-helpers.mjs'

test('temporary release workspaces stay inside their project and can be cleaned independently', async (t) => {
  const parent = await tempRoot(t)
  const project = path.join(parent, 'project')
  await fs.mkdir(project)
  const first = await makeProjectTemp(project, 'canai-release-prepare-')
  const second = await makeProjectTemp(project, 'canai-release-prepare-')
  assert.equal(path.dirname(first), projectTempRoot(project))
  assert.notEqual(first, second)
  await write(first, 'candidate/.git/keep', 'owned workspace')
  await removeProjectTemp(project, first, 'canai-release-prepare-')
  assert.equal(await fs.stat(first).then(() => true, () => false), false)
  assert.equal((await fs.stat(second)).isDirectory(), true)
})

test('cleanup refuses siblings, ancestors, other projects and wrong prefixes', async (t) => {
  const parent = await tempRoot(t)
  const project = path.join(parent, 'project')
  await fs.mkdir(project)
  const owned = await makeProjectTemp(project, 'canai-release-prepare-')
  const sibling = path.join(parent, 'canai-release-prepare-unrelated')
  await write(sibling, 'keep.txt', 'keep')
  for (const target of [parent, projectTempRoot(project), sibling]) {
    await assert.rejects(removeProjectTemp(project, target, 'canai-release-prepare-'), /unexpected/u)
  }
  await assert.rejects(removeProjectTemp(path.join(parent, 'other'), owned, 'canai-release-prepare-'), /unexpected/u)
  await assert.rejects(removeProjectTemp(project, owned, 'canai-public-release-'), /unexpected/u)
  await assert.rejects(makeProjectTemp(project, '../escape-'), /prefix/u)
  assert.equal(await fs.readFile(path.join(sibling, 'keep.txt'), 'utf8'), 'keep')
})

test('a mistyped project path does not create a new sibling project', async (t) => {
  const parent = await tempRoot(t)
  const missing = path.join(parent, 'misspelled-project')
  await assert.rejects(makeProjectTemp(missing, 'canai-release-prepare-'), /existing real directory/u)
  assert.equal(await fs.stat(missing).then(() => true, () => false), false)
})

test('temporary workspace creation and cleanup refuse symlink or junction redirection', async (t) => {
  const parent = await tempRoot(t)
  const project = path.join(parent, 'project')
  const external = path.join(parent, 'external')
  await fs.mkdir(project)
  await write(external, 'keep.txt', 'keep')
  await fs.symlink(external, path.join(project, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(makeProjectTemp(project, 'canai-release-prepare-'), /symlink/u)
  await assert.rejects(removeProjectTemp(project, path.join(project, 'artifacts', '.tmp', 'canai-release-prepare-fake'), 'canai-release-prepare-'), /symlink/u)
  assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'keep')
})

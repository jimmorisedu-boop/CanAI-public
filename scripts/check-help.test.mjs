import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkHelp, HelpCheckError } from './check-help.mjs'
import { buildHelpDocs } from './generate-help-docs.mjs'

const repoRoot = new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, match => match.slice(1))
const copyFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'canai-help-check-'))
  await cp(join(repoRoot, 'client', 'src', 'help'), join(root, 'client', 'src', 'help'), { recursive: true })
  await cp(join(repoRoot, 'client', 'public', 'help'), join(root, 'client', 'public', 'help'), { recursive: true })
  await cp(join(repoRoot, 'README.md'), join(root, 'README.md'))
  await cp(join(repoRoot, 'docs', 'GETTING-STARTED.md'), join(root, 'docs', 'GETTING-STARTED.md'))
  await cp(join(repoRoot, 'docs', 'help-maintenance.md'), join(root, 'docs', 'help-maintenance.md'), { recursive: true })
  await cp(join(repoRoot, 'docs', 'help'), join(root, 'docs', 'help'), { recursive: true })
  return root
}

test('Help content passes structural and SVG safety checks', () => {
  const result = checkHelp({ root: repoRoot })
  assert.ok(result.topics >= 30)
  assert.ok(result.images >= result.topics)
})

test('Help check reports a missing required topic and image', async () => {
  const root = await copyFixture()
  try {
    const guidePath = join(root, 'client', 'src', 'help', 'content', 'guide.json')
    const guide = JSON.parse(await readFile(guidePath, 'utf8'))
    guide.topics = guide.topics.filter(topic => topic.id !== 'quick-start')
    await writeFile(guidePath, JSON.stringify(guide))
    assert.throws(() => checkHelp({ root }), error => error instanceof HelpCheckError && /Missing required Help topic: quick-start/.test(error.message))
    await cp(join(repoRoot, 'client', 'src', 'help', 'content', 'guide.json'), guidePath)
    await rm(join(root, 'client', 'public', 'help', 'import-1.svg'))
    assert.throws(() => checkHelp({ root }), error => error instanceof HelpCheckError && /Missing help image/.test(error.message))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Help check rejects unsafe SVG content', async () => {
  const root = await copyFixture()
  try {
    const path = join(root, 'client', 'public', 'help', 'quick-start-1.svg')
    const original = await readFile(path, 'utf8')
    await writeFile(path, `${original}<script>alert(1)</script>`)
    assert.throws(() => checkHelp({ root }), error => error instanceof HelpCheckError && /Unsafe element/.test(error.message))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Help drift maps a changed source to its topic instead of any guide edit', async () => {
  const root = await copyFixture()
  try {
    const sourcePath = join(root, 'client', 'src', 'spaces', 'canvas', 'AssetBar.tsx')
    await writeFile(sourcePath, 'export const assetShelf = true\n', { flag: 'w' }).catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, 'client', 'src', 'spaces', 'canvas'), { recursive: true })
      await writeFile(sourcePath, 'export const assetShelf = true\n')
    })
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'help-test@example.invalid'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Help Test'], { cwd: root })
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root })
    await writeFile(sourcePath, 'export const assetShelf = true\nexport const changed = true\n')
    const guidePath = join(root, 'client', 'src', 'help', 'content', 'guide.json')
    const guide = JSON.parse(await readFile(guidePath, 'utf8'))
    guide.topics.find(topic => topic.id === 'timeline').summary = 'Changed timeline wording only.'
    await writeFile(guidePath, JSON.stringify(guide, null, 2))
    assert.throws(() => checkHelp({ root, base: 'HEAD' }), error => error instanceof HelpCheckError && /AssetBar\.tsx/.test(error.message))
    guide.topics.find(topic => topic.id === 'assets').summary = 'Changed Assets wording too.'
    await writeFile(guidePath, JSON.stringify(guide, null, 2))
    buildHelpDocs({ root })
    assert.doesNotThrow(() => checkHelp({ root, base: 'HEAD' }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

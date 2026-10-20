import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { scanDirectory, scanSecrets } from './scan-secrets.mjs'

async function removeOwnedTemp(directory, prefix) {
  const absolute = path.resolve(directory)
  const tempRoot = path.resolve(os.tmpdir())
  const lexicalRelative = path.relative(tempRoot, absolute)
  if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative) || !path.basename(absolute).startsWith(prefix)) {
    throw new Error(`Refusing to remove unexpected test temp path: ${directory}`)
  }
  const stat = await fs.lstat(absolute)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to remove unsafe test temp path: ${directory}`)
  const realRoot = await fs.realpath(tempRoot)
  const realTarget = await fs.realpath(absolute)
  const realRelative = path.relative(realRoot, realTarget)
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`Refusing to remove test temp outside system temp: ${directory}`)
  }
  await fs.rm(absolute, { recursive: true, force: true })
}

async function tempDirectory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-secret-scan-'))
  t.after(() => removeOwnedTemp(root, 'canai-secret-scan-'))
  return root
}

test('secret scanner catches runtime-assembled FAL and GitHub-shaped tokens without printing values', async (t) => {
  const root = await tempDirectory(t)
  const fal = `${'a'.repeat(20)}:${'b'.repeat(20)}`
  const github = `ghp_${'c'.repeat(32)}`
  // Assemble both the assignment name and value at runtime so this test file
  // never contains a credential-shaped literal of its own.
  const falKeyName = ['FAL', 'KEY'].join('_')
  await fs.writeFile(path.join(root, 'test.ts'), `const ${falKeyName} = ${JSON.stringify(fal)}\nconst token = ${JSON.stringify(github)}\n`)
  const result = await scanDirectory(root)
  assert.deepEqual(result.findings.map(({ rule, path: file }) => ({ rule, path: file })), [
    { rule: 'canai-fal-key', path: 'test.ts' },
    { rule: 'github-token', path: 'test.ts' },
  ])
  assert.equal(JSON.stringify(result).includes(fal), false)
  assert.equal(JSON.stringify(result).includes(github), false)
})

test('exact anchored synthetic fixtures pass while an unrelated long assignment fails', async (t) => {
  const root = await tempDirectory(t)
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true })
  const fixtureKeyName = ['FAL', 'KEY'].join('_')
  const fixtureValue = ['synthetic', 'test', 'key'].join('-')
  const rogueValue = 'r'.repeat(20)
  await fs.writeFile(path.join(root, 'scripts', 'make-dist.test.mjs'), `const key = '${fixtureKeyName}=${fixtureValue}'\nconst ${fixtureKeyName} = '${rogueValue}'\n`)
  await fs.writeFile(path.join(root, 'server.ts'), `const ${fixtureKeyName} = '${fixtureValue}'\n`)
  const result = await scanDirectory(root)
  assert.deepEqual(result.findings, [
    { rule: 'canai-fal-key', path: 'scripts/make-dist.test.mjs' },
    { rule: 'canai-fal-key', path: 'server.ts' },
  ])
})

test('scanner rejects symlink entries instead of following them', async (t) => {
  if (process.platform === 'win32') return
  const root = await tempDirectory(t)
  const target = path.join(root, 'outside.txt')
  const link = path.join(root, 'link.txt')
  await fs.writeFile(target, 'safe\n')
  await fs.symlink(target, link)
  const result = await scanDirectory(root)
  assert.deepEqual(result.findings, [{ rule: 'symlink', path: 'link.txt' }])
})

test('an explicitly configured missing Gitleaks binary fails closed', async (t) => {
  const root = await tempDirectory(t)
  await assert.rejects(
    scanSecrets({ source: root, mode: 'dir', gitleaks: path.join(root, 'missing-gitleaks') }),
    /Gitleaks binary is required/u,
  )
})

test('full Gitleaks scan keeps exact fixture allowances relative to the source root', async (t) => {
  const binary = process.env.GITLEAKS_BIN
  if (!binary) return t.skip('requires the pinned Gitleaks binary')
  const root = await tempDirectory(t)
  const directory = path.join(root, 'scripts')
  await fs.mkdir(directory)
  const fixture = path.join(directory, 'migrate-data.test.mjs')
  const keyName = ['FAL', 'KEY'].join('_')
  const safeValue = ['synthetic', 'old', 'key'].join('-')
  await fs.writeFile(fixture, `${keyName}=${safeValue}\n`)
  const clean = await scanSecrets({ source: root, gitleaks: binary, requireGitleaks: true })
  assert.deepEqual(clean.findings, [])
  const rogueValue = `${'r'.repeat(20)}:${'z'.repeat(20)}`
  await fs.appendFile(fixture, `${keyName}=${rogueValue}\n`)
  const rejected = await scanSecrets({ source: root, gitleaks: binary, requireGitleaks: true })
  assert.ok(rejected.findings.some(({ rule }) => rule === 'gitleaks'))
  assert.equal(JSON.stringify(rejected).includes(rogueValue), false)
})

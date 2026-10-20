import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PUBLIC_SOURCE_FORMAT, PUBLIC_SOURCE_VERSION } from './public-release-config.mjs'

export async function removeOwnedTemp(root, prefix) {
  const absolute = path.resolve(root)
  const tempRoot = path.resolve(os.tmpdir())
  const relative = path.relative(tempRoot, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unexpected test temporary path: ${root}`)
  if (!path.basename(absolute).startsWith(prefix)) throw new Error(`Unexpected test temporary prefix: ${root}`)
  const stat = await fs.lstat(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe test temporary path: ${root}`)
  const realRoot = await fs.realpath(tempRoot)
  const realTarget = await fs.realpath(absolute)
  const realRelative = path.relative(realRoot, realTarget)
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error(`Test temporary path escaped temp: ${root}`)
  await fs.rm(absolute, { recursive: true, force: true })
}

export async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-release-prepare-test-'))
  t.after(() => removeOwnedTemp(root, 'canai-release-prepare-test-'))
  return root
}

export async function write(root, name, content) {
  const target = path.join(root, name)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

export function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

export async function initRepo(root, files) {
  await fs.mkdir(root, { recursive: true })
  for (const [name, value] of Object.entries(files)) await write(root, name, value)
  execFileSync('git', ['-C', root, 'init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.name', 'Release Test'])
  git(root, ['config', 'user.email', 'release-test@example.invalid'])
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', 'fixture'])
}

export function manifestFor(files, format = PUBLIC_SOURCE_FORMAT, version = PUBLIC_SOURCE_VERSION) {
  return {
    format,
    version,
    edition: 'local',
    sourceRevision: 'b'.repeat(40),
    files: Object.entries(files).map(([name, value]) => ({
      path: name,
      mode: '100644',
      bytes: Buffer.byteLength(value),
      sha256: createHash('sha256').update(value).digest('hex'),
    })),
  }
}

export async function sourceOnlyFixture(t) {
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
  const gitleaks = path.join(parent, 'gitleaks')
  await fs.writeFile(gitleaks, 'fixture\n')
  const options = { root: sourceRoot, publicRoot, artifactRoot, sourceOnly: true, platform: null, gitleaks }
  const hooks = {
    nodePath: process.execPath,
    verifyGitleaks: async () => {},
    runner: async () => ({ code: 0, output: '' }),
    progress: () => {},
  }
  return { parent, sourceRoot, publicRoot, artifactRoot, options, hooks }
}

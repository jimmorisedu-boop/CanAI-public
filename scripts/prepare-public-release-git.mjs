import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  PUBLIC_MANIFEST_NAME,
  PUBLIC_REVISION_NAME,
  PUBLIC_SOURCE_FORMAT,
  PUBLIC_SOURCE_VERSION,
  isPathInside,
  isPublicSourcePath,
  posixPath,
} from './public-release-config.mjs'
import { LOCAL_EDITION, assertLocalEditionRuntime } from './local-edition.mjs'
import { assertNoSymlinkPath, assertPublicCheckout, lstatOrNull } from './prepare-public-release-guards.mjs'

export function git(root, args, { encoding = 'utf8' } = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  })
}

function gitFiles(root) {
  return String(git(root, ['ls-files', '-z'])).split('\0').filter(Boolean).map(posixPath)
}

function headTree(root) {
  const raw = git(root, ['ls-tree', '-r', '-z', 'HEAD'], { encoding: null }).toString('utf8')
  const entries = new Map()
  for (const record of raw.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, object] = record.slice(0, tab).split(' ')
    entries.set(posixPath(record.slice(tab + 1)), { mode, type, object })
  }
  return entries
}

function headBlobs(root, paths) {
  if (!paths.length) return new Map()
  const input = `${paths.map((entry) => `HEAD:${entry}`).join('\n')}\n`
  const raw = execFileSync('git', ['-C', root, 'cat-file', '--batch'], { input, encoding: null, maxBuffer: 256 * 1024 * 1024 })
  const result = new Map()
  let offset = 0
  for (const entry of paths) {
    const headerEnd = raw.indexOf(0x0a, offset)
    if (headerEnd < 0) throw new Error(`Unable to read committed blob: ${entry}`)
    const header = raw.subarray(offset, headerEnd).toString('utf8').split(' ')
    const size = Number.parseInt(header[2] ?? '', 10)
    if (header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0 || headerEnd + 1 + size > raw.length) throw new Error(`Committed path is not a regular blob: ${entry}`)
    const start = headerEnd + 1
    const content = raw.subarray(start, start + size)
    if (raw[start + size] !== 0x0a) throw new Error(`Malformed committed blob response: ${entry}`)
    result.set(entry, content)
    offset = start + size + 1
  }
  return result
}

function manifestPaths(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('Export is missing a valid public manifest')
  if (manifest.edition !== LOCAL_EDITION) throw new Error('Export must be the local edition')
  const paths = new Set([PUBLIC_MANIFEST_NAME, PUBLIC_REVISION_NAME])
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !isPublicSourcePath(entry.path) || paths.has(entry.path)) {
      throw new Error(`Export manifest contains an invalid or duplicate path: ${entry?.path ?? '<unknown>'}`)
    }
    if (!/^100(?:644|755)$/u.test(String(entry.mode)) || !/^[a-f0-9]{64}$/u.test(String(entry.sha256))) {
      throw new Error(`Export manifest contains invalid metadata for ${entry.path}`)
    }
    paths.add(entry.path)
  }
  return paths
}

async function readExport(exportRoot) {
  const manifestPath = path.join(exportRoot, PUBLIC_MANIFEST_NAME)
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (manifest?.format !== PUBLIC_SOURCE_FORMAT || manifest?.version !== PUBLIC_SOURCE_VERSION) throw new Error('Export has an invalid public manifest format')
  if (manifest.edition !== LOCAL_EDITION) throw new Error('Export must be the local edition')
  const paths = manifestPaths(manifest)
  const revision = (await fs.readFile(path.join(exportRoot, PUBLIC_REVISION_NAME), 'utf8')).trim()
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error(`Export has an invalid ${PUBLIC_REVISION_NAME}`)
  return { manifest, paths, revision }
}

async function assertRegularFile(root, relative) {
  const target = path.resolve(root, ...relative.split('/'))
  if (!isPathInside(root, target)) throw new Error(`Refusing export path outside workspace: ${relative}`)
  const stat = await lstatOrNull(target)
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Export path is not a regular file: ${relative}`)
  await assertNoSymlinkPath(path.dirname(target))
  return target
}

function configureFreshRepo(root) {
  git(root, ['config', 'user.name', 'CanAI Release'])
  git(root, ['config', 'user.email', 'release@localhost'])
  git(root, ['config', 'core.autocrlf', 'false'])
  git(root, ['config', 'core.longpaths', 'true'])
}

export async function createCandidate({ publicRoot, candidateRoot, publicInfo }) {
  const target = path.resolve(candidateRoot)
  if (await lstatOrNull(target)) throw new Error(`Candidate checkout already exists: ${target}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  if (publicInfo?.exists) {
    execFileSync('git', ['clone', '--config', 'core.autocrlf=false', '--config', 'core.longpaths=true', '--local', '--no-hardlinks', publicRoot, target], { stdio: 'pipe' })
    configureFreshRepo(target)
    return target
  }
  await fs.mkdir(target, { recursive: true })
  execFileSync('git', ['-C', target, 'init', '--initial-branch=main'], { stdio: 'pipe' })
  configureFreshRepo(target)
  return target
}

export async function syncCandidate({ exportRoot, candidateRoot }) {
  const source = path.resolve(exportRoot)
  const target = path.resolve(candidateRoot)
  const { manifest, paths, revision } = await readExport(source)
  const expected = [...paths].sort()
  const tracked = gitFiles(target)
  const stale = tracked.filter((name) => !paths.has(name))
  for (let offset = 0; offset < stale.length; offset += 200) {
    const chunk = stale.slice(offset, offset + 200)
    if (chunk.length) git(target, ['rm', '-f', '--', ...chunk])
  }

  for (const entry of manifest.files) {
    const sourceFile = await assertRegularFile(source, entry.path)
    const content = await fs.readFile(sourceFile)
    assertLocalEditionRuntime(entry.path, content)
    const digest = createHash('sha256').update(content).digest('hex')
    if (content.byteLength !== entry.bytes || digest !== entry.sha256) throw new Error(`Export manifest hash mismatch: ${entry.path}`)
    const destination = await assertRegularFileTarget(target, entry.path)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(sourceFile, destination)
    await fs.chmod(destination, Number.parseInt(entry.mode, 8) & 0o777)
  }
  for (const marker of [PUBLIC_MANIFEST_NAME, PUBLIC_REVISION_NAME]) {
    const sourceFile = await assertRegularFile(source, marker)
    const destination = await assertRegularFileTarget(target, marker)
    await fs.copyFile(sourceFile, destination)
  }
  // Stage the whole strictly validated candidate. This avoids Windows command
  // line limits for the ~1900-file public snapshot while leaving no way for
  // an untrusted path to enter the candidate: the exact tracked-set check
  // below is the gate before commit.
  git(target, ['add', '--all', '--', '.'])
  // CopyFile can preserve a tracked file's size and timestamps on Windows.
  // Force Git to read its bytes even when the cached stat still matches.
  git(target, ['add', '--renormalize', '--', '.'])
  if (paths.has('server/.env.example')) git(target, ['add', '-f', '--', 'server/.env.example'])
  const stagedModes = new Map(String(git(target, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t')
    return [posixPath(record.slice(tab + 1)), record.slice(0, 6)]
  }))
  for (const entry of manifest.files) {
    if (stagedModes.get(entry.path) !== entry.mode) {
      git(target, ['update-index', entry.mode === '100755' ? '--chmod=+x' : '--chmod=-x', '--', entry.path])
    }
  }
  const actual = gitFiles(target).sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error('Candidate tracked paths do not match the public export manifest')
  }
  const staged = git(target, ['diff', '--cached', '--name-only']).trim()
  if (staged) git(target, ['commit', '-m', `Update public source from ${revision}`])
  if (git(target, ['status', '--porcelain']).trim()) throw new Error('Candidate checkout is dirty after export sync')
  return { candidateRoot: target, commit: git(target, ['rev-parse', 'HEAD']).trim(), revision, manifest }
}

export function verifyCandidateManifest({ candidateRoot, manifest }) {
  const expected = manifestPaths(manifest)
  const tracked = gitFiles(candidateRoot).sort()
  const expectedList = [...expected].sort()
  if (tracked.length !== expectedList.length || tracked.some((name, index) => name !== expectedList[index])) {
    throw new Error('Candidate tracked paths do not match the public manifest before archive')
  }
  const tree = headTree(candidateRoot)
  const blobs = headBlobs(candidateRoot, manifest.files.map((entry) => entry.path))
  for (const entry of manifest.files) {
    const metadata = tree.get(entry.path)
    const match = metadata && /^(100(?:644|755))$/u.test(metadata.mode) && metadata.type === 'blob' ? metadata : null
    if (!match || match.mode !== entry.mode) throw new Error(`Candidate mode mismatch: ${entry.path}`)
    const content = blobs.get(entry.path)
    assertLocalEditionRuntime(entry.path, content)
    const digest = createHash('sha256').update(content).digest('hex')
    if (content.byteLength !== entry.bytes || digest !== entry.sha256) throw new Error(`Candidate blob hash mismatch: ${entry.path}`)
  }
  return true
}

async function assertRegularFileTarget(root, relative) {
  const target = path.resolve(root, ...relative.split('/'))
  if (!isPathInside(root, target)) throw new Error(`Refusing candidate path outside workspace: ${relative}`)
  const parent = path.dirname(target)
  const stat = await lstatOrNull(target)
  if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink candidate path: ${relative}`)
  await fs.mkdir(parent, { recursive: true })
  const parentStat = await lstatOrNull(parent)
  if (parentStat?.isSymbolicLink()) throw new Error(`Refusing symlink candidate directory: ${relative}`)
  await assertNoSymlinkPath(parent)
  return target
}

export function assertNoSharedHistory(sourceRoot, publicRoot) {
  const sourceCommits = new Set(String(git(sourceRoot, ['rev-list', '--all'])).split(/\r?\n/u).filter(Boolean))
  const publicCommits = String(git(publicRoot, ['rev-list', '--all'])).split(/\r?\n/u).filter(Boolean)
  const shared = publicCommits.find((commit) => sourceCommits.has(commit))
  if (shared) throw new Error(`Public checkout shares authoring Git history (${shared})`)
}

export async function archiveSource({ candidateRoot, version, destination }) {
  const target = path.resolve(destination)
  await fs.mkdir(path.dirname(target), { recursive: true })
  git(candidateRoot, ['archive', '--format=zip', `--prefix=CanAI-${version}-source/`, '-o', target, 'HEAD'])
  const stat = await fs.stat(target)
  if (!stat.isFile() || stat.size === 0) throw new Error(`Source archive was not created: ${target}`)
  return target
}

export async function publishCandidate({ candidateRoot, publicRoot, publicInfo, commit }) {
  const target = path.resolve(publicRoot)
  if (publicInfo?.exists) {
    const current = await assertPublicCheckout(target)
    if (current.head !== publicInfo.head || current.branch !== publicInfo.branch) {
      throw new Error('Public checkout changed while release gates were running')
    }
    git(target, ['fetch', '--no-tags', candidateRoot, commit])
    git(target, ['merge', '--ff-only', '--no-edit', commit])
    return { root: target, commit: git(target, ['rev-parse', 'HEAD']).trim(), branch: current.branch }
  }
  if (await lstatOrNull(target)) throw new Error(`Public checkout appeared during release: ${target}`)
  execFileSync('git', ['clone', '--config', 'core.autocrlf=false', '--config', 'core.longpaths=true', '--local', '--no-hardlinks', candidateRoot, target], { stdio: 'pipe' })
  git(target, ['remote', 'remove', 'origin'])
  configureFreshRepo(target)
  const remotes = git(target, ['remote']).trim()
  if (remotes) throw new Error('New public checkout unexpectedly has a remote')
  await assertPublicCheckout(target)
  return { root: target, commit: git(target, ['rev-parse', 'HEAD']).trim(), branch: git(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() }
}

export async function hashFile(file) {
  const data = await fs.readFile(file)
  return createHash('sha256').update(data).digest('hex')
}

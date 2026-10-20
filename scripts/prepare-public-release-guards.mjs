import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  PUBLIC_MANIFEST_NAME,
  PUBLIC_REVISION_NAME,
  PUBLIC_SOURCE_FORMAT,
  PUBLIC_SOURCE_VERSION,
  REQUIRED_SOURCE_GROUPS,
  isPathInside,
  isPublicSourcePath,
  isLegacyPublicSourcePath,
  posixPath,
} from './public-release-config.mjs'
import { LOCAL_EDITION, assertLocalEditionRuntime } from './local-edition.mjs'

// Validate the original boundary of an unmarked historical snapshot before
// migrating it. Local-edition snapshots and fresh candidates use the stricter
// policy; neither Cloud files nor retired updater files can enter a new export.
const RETIRED_PUBLIC_MANIFEST_PATHS = new Set(['Update CanAI.bat', 'update.ps1'])

function isAcceptedPublicCheckoutPath(value, legacy) {
  const normalized = posixPath(value)
  return legacy
    ? isLegacyPublicSourcePath(normalized) || RETIRED_PUBLIC_MANIFEST_PATHS.has(normalized)
    : isPublicSourcePath(normalized)
}

export function git(root, args, { encoding = 'utf8' } = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  })
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

export async function lstatOrNull(target) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function assertNoSymlinkPath(target) {
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = await lstatOrNull(current)
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink path: ${current}`)
  }
}

export function parseGitStatus(output) {
  const records = String(output).split('\0').filter(Boolean)
  return records.map((record) => ({
    code: record.slice(0, 2),
    path: posixPath(record.slice(3)),
  }))
}

function assertStatusClean(root, { allowPrivateUntracked }) {
  const records = parseGitStatus(git(root, ['status', '--porcelain=v1', '--untracked-files=all', '-z']))
  const problems = []
  for (const record of records) {
    if (record.code === '??' && allowPrivateUntracked && !isLegacyPublicSourcePath(record.path) && !record.path.startsWith('local-edition/')) continue
    problems.push(record)
  }
  if (problems.length) {
    const summary = problems.slice(0, 8).map((item) => `${item.code} ${item.path}`).join(', ')
    throw new Error(`Working tree is not clean: ${summary}${problems.length > 8 ? '…' : ''}`)
  }
}

async function assertPublicLayout(root) {
  const manifestPath = path.join(root, PUBLIC_MANIFEST_NAME)
  const revisionPath = path.join(root, PUBLIC_REVISION_NAME)
  const manifestStat = await lstatOrNull(manifestPath)
  const revisionStat = await lstatOrNull(revisionPath)
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || !revisionStat?.isFile() || revisionStat.isSymbolicLink()) {
    throw new Error(`Public checkout is missing ${PUBLIC_MANIFEST_NAME} or ${PUBLIC_REVISION_NAME}`)
  }
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error(`Public checkout has an invalid ${PUBLIC_MANIFEST_NAME}`)
  }
  if (manifest?.format !== PUBLIC_SOURCE_FORMAT || manifest?.version !== PUBLIC_SOURCE_VERSION || !Array.isArray(manifest.files)) {
    throw new Error(`Public checkout has an invalid ${PUBLIC_MANIFEST_NAME}`)
  }
  if (manifest.edition !== undefined && manifest.edition !== LOCAL_EDITION) throw new Error('Public checkout has an invalid edition')
  const legacy = manifest.edition === undefined
  const listed = new Set()
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !isAcceptedPublicCheckoutPath(entry.path, legacy) || listed.has(entry.path)) {
      throw new Error(`Public checkout manifest contains an invalid path: ${entry?.path ?? '<unknown>'}`)
    }
    if (!/^100(?:644|755)$/u.test(String(entry.mode)) || !/^[a-f0-9]{64}$/u.test(String(entry.sha256))) {
      throw new Error(`Public checkout manifest contains invalid metadata for ${entry.path}`)
    }
    listed.add(entry.path)
  }
  const revision = (await fs.readFile(revisionPath, 'utf8')).trim()
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error(`Public checkout has an invalid ${PUBLIC_REVISION_NAME}`)
  if (manifest.sourceRevision !== revision) throw new Error(`Public checkout manifest revision does not match ${PUBLIC_REVISION_NAME}`)
  const tracked = String(git(root, ['ls-files', '-z'])).split('\0').filter(Boolean).map(posixPath)
  for (const trackedPath of tracked) {
    if (trackedPath === PUBLIC_MANIFEST_NAME || trackedPath === PUBLIC_REVISION_NAME) continue
    if (!isAcceptedPublicCheckoutPath(trackedPath, legacy) || !listed.has(trackedPath)) {
      throw new Error(`Public checkout contains a path outside its manifest: ${trackedPath}`)
    }
  }
  for (const listedPath of listed) {
    if (!tracked.includes(listedPath)) throw new Error(`Public checkout manifest path is not tracked: ${listedPath}`)
  }
  const tree = headTree(root)
  const blobs = headBlobs(root, [...manifest.files.map((entry) => entry.path), PUBLIC_REVISION_NAME])
  for (const entry of manifest.files) {
    const metadata = tree.get(entry.path)
    const match = metadata && /^(100(?:644|755))$/u.test(metadata.mode) && metadata.type === 'blob' ? metadata : null
    if (!match || match.mode !== String(entry.mode)) throw new Error(`Public checkout mode does not match manifest: ${entry.path}`)
    const content = blobs.get(entry.path)
    if (!legacy) assertLocalEditionRuntime(entry.path, content)
    const digest = createHash('sha256').update(content).digest('hex')
    if (content.byteLength !== entry.bytes || digest !== entry.sha256) throw new Error(`Public checkout blob does not match manifest: ${entry.path}`)
  }
  const committedRevision = blobs.get(PUBLIC_REVISION_NAME)?.toString('utf8').trim()
  if (committedRevision !== revision) throw new Error(`Public checkout ${PUBLIC_REVISION_NAME} differs from its committed marker`)
}

export async function assertAuthoringCheckout(root) {
  const sourceRoot = path.resolve(root)
  const stat = await lstatOrNull(sourceRoot)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('Authoring source must be a real directory')
  await assertNoSymlinkPath(sourceRoot)
  if (path.resolve(await fs.realpath(sourceRoot)) !== sourceRoot) throw new Error('Authoring source path must resolve to itself')
  const top = path.resolve(git(sourceRoot, ['rev-parse', '--show-toplevel']).trim())
  if (top !== sourceRoot) throw new Error(`Authoring source must be the Git worktree root: ${sourceRoot}`)
  const gitStat = await lstatOrNull(path.join(sourceRoot, '.git'))
  if (!gitStat?.isDirectory() || gitStat.isSymbolicLink()) throw new Error('Authoring source must use a real .git directory')
  const manifest = await lstatOrNull(path.join(sourceRoot, PUBLIC_MANIFEST_NAME))
  const revision = await lstatOrNull(path.join(sourceRoot, PUBLIC_REVISION_NAME))
  if (manifest?.isFile() && revision?.isFile()) {
    throw new Error('Refusing a public-source snapshot as the authoring checkout')
  }
  assertStatusClean(sourceRoot, { allowPrivateUntracked: true })
  return sourceRoot
}

export async function assertPublicCheckout(root) {
  const publicRoot = path.resolve(root)
  const stat = await lstatOrNull(publicRoot)
  if (!stat) return { exists: false, root: publicRoot }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Public checkout is not a real directory: ${publicRoot}`)
  await assertNoSymlinkPath(publicRoot)
  if (path.resolve(await fs.realpath(publicRoot)) !== publicRoot) throw new Error(`Public checkout path must resolve to itself: ${publicRoot}`)
  const gitStat = await lstatOrNull(path.join(publicRoot, '.git'))
  if (!gitStat?.isDirectory() || gitStat.isSymbolicLink()) {
    throw new Error(`Public checkout must be a normal Git worktree with a .git directory: ${publicRoot}`)
  }
  const top = path.resolve(git(publicRoot, ['rev-parse', '--show-toplevel']).trim())
  if (top !== publicRoot) throw new Error(`Public checkout is not rooted at ${publicRoot}`)
  assertStatusClean(publicRoot, { allowPrivateUntracked: false })
  const branch = git(publicRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim()
  if (!branch) throw new Error('Public checkout must be on a branch, not detached HEAD')
  await assertPublicLayout(publicRoot)
  return {
    exists: true,
    root: publicRoot,
    head: git(publicRoot, ['rev-parse', 'HEAD']).trim(),
    branch,
  }
}

export async function assertDisjointPaths({ sourceRoot, publicRoot, artifactRoot }) {
  const source = path.resolve(sourceRoot)
  const publicPath = path.resolve(publicRoot)
  const artifact = path.resolve(artifactRoot)
  if (isPathInside(source, publicPath) || isPathInside(publicPath, source)) {
    throw new Error('Public checkout path must not overlap the authoring source')
  }
  if (isPathInside(publicPath, artifact) || isPathInside(artifact, publicPath)) {
    throw new Error('Artifact path must not overlap the public checkout')
  }
  if (isPathInside(source, artifact)) {
    const allowed = path.join(source, 'artifacts')
    if (!isPathInside(allowed, artifact)) throw new Error('Artifact path inside the source must stay in ignored artifacts/')
    try {
      git(source, ['check-ignore', '--quiet', '--', `${artifact}${path.sep}`])
    } catch {
      throw new Error('Artifact path inside the source must be Git-ignored')
    }
  }
  await assertNoSymlinkPath(path.dirname(publicPath))
  await assertNoSymlinkPath(path.dirname(artifact))
}

export function sourceGroupsPresent(root) {
  return REQUIRED_SOURCE_GROUPS.some(([authoringPath]) => {
    try {
      return Boolean(git(root, ['ls-files', '--error-unmatch', '--', authoringPath]))
    } catch {
      return false
    }
  })
}

export async function readVersion(root) {
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  if (typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(packageJson.version)) {
    throw new Error('Root package.json has no valid release version')
  }
  return packageJson.version
}

export function shortRevision(root) {
  return git(root, ['rev-parse', '--short=12', 'HEAD']).trim()
}

export function assertInside(parent, candidate, label) {
  if (!isPathInside(parent, candidate)) throw new Error(`${label} must stay inside ${parent}`)
}

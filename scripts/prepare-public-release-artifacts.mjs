import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertInside, assertNoSymlinkPath, lstatOrNull } from './prepare-public-release-guards.mjs'
import { verifyDesktopUpdateManifest } from './desktop-update-manifest.mjs'

export async function sha256File(file) {
  const data = await fs.readFile(file)
  return createHash('sha256').update(data).digest('hex')
}

export async function makeOwnedTemp(prefix = 'canai-release-prepare-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function removeOwnedTemp(target, prefix = 'canai-release-prepare-') {
  const absolute = path.resolve(target)
  const tempRoot = path.resolve(os.tmpdir())
  const relative = path.relative(tempRoot, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(absolute).startsWith(prefix)) {
    throw new Error(`Refusing to remove unexpected temporary path: ${target}`)
  }
  const stat = await lstatOrNull(absolute)
  if (!stat) return
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe temporary path: ${target}`)
  await assertNoSymlinkPath(absolute)
  const realRoot = await fs.realpath(tempRoot)
  const realTarget = await fs.realpath(absolute)
  const realRelative = path.relative(realRoot, realTarget)
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error(`Refusing temporary path outside temp: ${target}`)
  await fs.rm(absolute, { recursive: true, force: true })
}

async function regularFile(root, relative, label) {
  const target = path.resolve(root, relative)
  assertInside(root, target, label)
  const stat = await lstatOrNull(target)
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${relative}`)
  await assertNoSymlinkPath(path.dirname(target))
  return target
}

async function verifyHashSidecar(file, expectedHash) {
  const actualHash = await sha256File(file)
  if (actualHash !== expectedHash) throw new Error(`Artifact hash mismatch: ${path.basename(file)}`)
  const sidecar = `${file}.sha256`
  const sidecarStat = await lstatOrNull(sidecar)
  if (!sidecarStat?.isFile() || sidecarStat.isSymbolicLink()) throw new Error(`Artifact hash sidecar is missing: ${path.basename(file)}`)
  const expectedLine = `${expectedHash}  ${path.basename(file)}`
  if ((await fs.readFile(sidecar, 'utf8')).trim() !== expectedLine) throw new Error(`Artifact hash sidecar is invalid: ${path.basename(file)}`)
}

export async function assertReusableArtifact(target, expected) {
  if (!expected || typeof expected !== 'object') throw new Error(`Reusable artifact metadata is missing: ${target}`)
  const targetStat = await lstatOrNull(target)
  if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) throw new Error(`Artifact path is not a real directory: ${target}`)
  await assertNoSymlinkPath(target)
  const provenancePath = await regularFile(target, 'provenance.json', 'Artifact provenance')
  let provenance
  try {
    provenance = JSON.parse(await fs.readFile(provenancePath, 'utf8'))
  } catch {
    throw new Error(`Artifact provenance is invalid: ${target}`)
  }
  if (provenance?.format !== 'canai-public-release'
    || provenance.version !== expected.version
    || provenance.sourceRevision !== expected.sourceRevision
    || provenance.platform !== expected.platform
    || provenance.sourceOnly !== expected.sourceOnly
    || provenance.publicCommit !== expected.publicCommit) {
    throw new Error(`Artifact path already exists for a different release: ${target}`)
  }
  if (!/^[0-9a-f]{40}$/u.test(String(provenance.publicCommit))) throw new Error(`Artifact provenance has an invalid public commit: ${target}`)
  const archives = [provenance.sourceArchive]
  if (expected.sourceOnly === false) archives.push(provenance.package)
  for (const archive of archives) {
    if (!archive || typeof archive.file !== 'string' || path.basename(archive.file) !== archive.file || !/^[0-9a-f]{64}$/u.test(String(archive.sha256))) {
      throw new Error(`Artifact provenance has an invalid archive entry: ${target}`)
    }
    const file = await regularFile(target, archive.file, 'Artifact archive')
    await verifyHashSidecar(file, archive.sha256)
  }
  if (expected.sourceOnly === false) await verifyDesktopUpdateManifest(target, provenance)
  const logs = await lstatOrNull(path.join(target, 'logs'))
  if (!logs?.isDirectory() || logs.isSymbolicLink()) throw new Error(`Artifact diagnostics are missing: ${target}`)
}

export async function copyArtifacts({ stage, destination, reuseExisting = false, expected = null }) {
  const target = path.resolve(destination)
  await assertNoSymlinkPath(path.dirname(target))
  const stat = await lstatOrNull(target)
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Artifact path is not a real directory: ${target}`)
    if (reuseExisting) {
      await assertReusableArtifact(target, expected)
      return target
    }
    throw new Error(`Artifact path already exists and is not empty: ${target}`)
  }
  const parent = path.dirname(target)
  await fs.mkdir(parent, { recursive: true })
  const temporary = await fs.mkdtemp(path.join(parent, `.${path.basename(target)}.incomplete-`))
  try {
    await copyExclusive(stage, temporary)
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return target
}

async function copyExclusive(source, destination) {
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      await fs.mkdir(to)
      await copyExclusive(from, to)
    } else if (entry.isFile()) {
      await fs.copyFile(from, to, constants.COPYFILE_EXCL)
    } else {
      throw new Error(`Artifact source contains a non-regular entry: ${from}`)
    }
  }
}

export async function assertLatestPointerReady({ artifactRoot, pointerName = 'latest.json' }) {
  const root = path.resolve(artifactRoot)
  await assertNoSymlinkPath(path.dirname(root))
  const stat = await lstatOrNull(root)
  if (!stat) return path.join(root, pointerName)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Artifact root is not a real directory: ${root}`)
  await assertNoSymlinkPath(root)
  const target = path.join(root, pointerName)
  const existing = await lstatOrNull(target)
  if (existing?.isSymbolicLink()) throw new Error(`Refusing symlink latest pointer: ${target}`)
  if (existing && !existing.isFile()) throw new Error(`Latest pointer is not a regular file: ${target}`)
  return target
}

export async function writeLatestPointer({ artifactRoot, artifactDirectory, version, revision, publicCommit, platform, pointerName = 'latest.json' }) {
  const root = path.resolve(artifactRoot)
  await fs.mkdir(root, { recursive: true })
  await assertLatestPointerReady({ artifactRoot: root, pointerName })
  const pointer = {
    version,
    edition: 'local',
    sourceRevision: revision,
    publicCommit,
    platform,
    artifact: path.basename(artifactDirectory),
    updatedAt: new Date().toISOString(),
  }
  const temporary = path.join(root, `.latest-${process.pid}-${Date.now()}.json`)
  const target = path.join(root, pointerName)
  await fs.writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
  try {
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return pointer
}

export function assertArtifactInside(root, target) {
  assertInside(root, target, 'Artifact')
  return path.resolve(target)
}

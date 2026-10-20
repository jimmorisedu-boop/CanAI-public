import fs from 'node:fs/promises'
import path from 'node:path'
import { assertNoSymlinkPath, lstatOrNull } from './prepare-public-release-guards.mjs'

export const projectArtifactsRoot = (root) => path.resolve(root, 'artifacts')
export const projectTempRoot = (root) => path.join(projectArtifactsRoot(root), '.tmp')

function assertPrefix(prefix) {
  if (!/^canai-[a-z0-9-]+-$/u.test(prefix)) throw new Error('Invalid project temporary prefix')
}

export async function makeProjectTemp(root, prefix) {
  assertPrefix(prefix)
  const owner = await lstatOrNull(path.resolve(root))
  if (!owner?.isDirectory() || owner.isSymbolicLink()) throw new Error('Project root must be an existing real directory')
  const parent = projectTempRoot(root)
  await assertNoSymlinkPath(parent)
  await fs.mkdir(parent, { recursive: true })
  await assertNoSymlinkPath(parent)
  return fs.mkdtemp(path.join(parent, prefix))
}

export async function removeProjectTemp(root, target, prefix) {
  assertPrefix(prefix)
  const absolute = path.resolve(target)
  const parent = projectTempRoot(root)
  if (path.dirname(absolute) !== parent || !path.basename(absolute).startsWith(prefix)) {
    throw new Error(`Refusing unexpected project temporary path: ${target}`)
  }
  await assertNoSymlinkPath(absolute)
  const stat = await lstatOrNull(absolute)
  if (!stat) return
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe project temporary path: ${target}`)
  if (path.dirname(await fs.realpath(absolute)) !== await fs.realpath(parent)) {
    throw new Error(`Project temporary path escaped its project: ${target}`)
  }
  await fs.rm(absolute, { recursive: true, force: true })
}

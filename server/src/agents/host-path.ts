import fs from 'node:fs/promises'
import path from 'node:path'
import { AgentHostError } from './host-shared.js'
import { checkRelativePath } from './validation.js'

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

async function existingAncestor(candidate: string): Promise<string> {
  let current = candidate
  while (true) {
    try {
      return await fs.realpath(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

export async function resolveWorkspacePath(workspaceRoot: string, relative: string, ensure = false): Promise<string> {
  checkRelativePath(relative, 'workspacePath')
  await fs.mkdir(workspaceRoot, { recursive: true })
  const root = await fs.realpath(workspaceRoot)
  const candidate = path.resolve(root, relative)
  if (!inside(root, candidate)) throw new AgentHostError('PATH_INVALID', 'workspacePath is outside the workspace', 400)
  const existing = await fs.realpath(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    if (!inside(root, existing)) throw new AgentHostError('PATH_INVALID', 'workspacePath uses a symlink outside the workspace', 400)
    return existing
  }
  // Resolve the parent before mkdir: recursive mkdir follows a symlink in an
  // existing ancestor and could otherwise create the persisted child outside
  // the task workspace before the containment check runs.
  const parent = await existingAncestor(path.dirname(candidate))
  if (!inside(root, parent)) throw new AgentHostError('PATH_INVALID', 'workspacePath uses a symlink outside the workspace', 400)
  if (!ensure) throw new AgentHostError('PATH_INVALID', 'workspacePath is missing', 400)
  await fs.mkdir(candidate, { recursive: true })
  const real = await fs.realpath(candidate)
  if (!inside(root, real)) throw new AgentHostError('PATH_INVALID', 'workspacePath uses a symlink outside the workspace', 400)
  return real
}

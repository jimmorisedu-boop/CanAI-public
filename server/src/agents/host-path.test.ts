import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveWorkspacePath } from './host-path.js'

test('workspace path rejects a symlinked parent before recursive mkdir', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-path-'))
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'outside')
  await fs.mkdir(outside, { recursive: true })
  const link = path.join(workspace, 'task-symlink', 'escape')
  await fs.mkdir(path.dirname(link), { recursive: true })
  try {
    await fs.symlink(outside, link, 'junction')
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true })
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows symlink privileges are unavailable')
      return
    }
    throw error
  }
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  await assert.rejects(
    resolveWorkspacePath(workspace, 'task-symlink/escape/new-child', true),
    (error: unknown) => error instanceof Error && /symlink|рабочую папку/u.test(error.message),
  )
  await assert.rejects(fs.stat(path.join(outside, 'new-child')), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
})

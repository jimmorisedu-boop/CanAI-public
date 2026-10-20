import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentCheckpointPayload } from '../../../packages/agent-protocol/index.js'
import type { AgentTaskRecord } from './types.js'
import { AgentProtocolError, checkRelativePath } from './validation.js'

export async function verifyCheckpoint(
  task: AgentTaskRecord,
  checkpoint: AgentCheckpointPayload,
  workspaceRoot: string,
): Promise<void> {
  const root = path.resolve(workspaceRoot, task.workspacePath)
  const realRoot = await fs.realpath(root).catch(() => root)
  for (const file of checkpoint.files) {
    checkRelativePath(file.path, 'checkpoint.files[].path')
    const absolute = path.resolve(root, file.path)
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new AgentProtocolError('PATH_INVALID', 'Checkpoint is outside the workspace')
    const realFile = await fs.realpath(absolute).catch(() => '')
    if (!realFile || !realFile.startsWith(`${realRoot}${path.sep}`)) throw new AgentProtocolError('PATH_INVALID', 'Checkpoint uses a symlink outside the workspace')
    const bytes = await fs.readFile(realFile)
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex')
    if (checksum !== file.checksum) throw new AgentProtocolError('CHECKPOINT_INVALID', `Checksum does not match for ${file.path}`)
  }
}

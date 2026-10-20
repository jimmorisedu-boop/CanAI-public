import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { readLegacyPromptChat } from './promptChats.js'
import { PromptChatRepository } from './promptChatStorage.js'
import type { PromptChatIndexV2 } from './promptChatTypes.js'

const defaultRootDir = path.join(path.dirname(config.projectFile), 'prompt-chats')
const defaultRepository = new PromptChatRepository({
  rootDir: defaultRootDir,
  now: Date.now,
  id: randomUUID,
})

export interface PromptChatMigrationDeps {
  repository?: PromptChatRepository
  legacyRootDir?: string
}

export async function ensurePromptChatV2(
  projectId: string,
  defaultModelId: string,
  deps: PromptChatMigrationDeps = {},
): Promise<PromptChatIndexV2> {
  const repository = deps.repository ?? defaultRepository
  const legacyRootDir = deps.legacyRootDir ?? defaultRootDir
  const existing = await repository.readIndexIfExists(projectId)
  if (existing) return existing

  const legacy = await readLegacyPromptChat(projectId, legacyRootDir)
  if (!legacy) return repository.ensureProject(projectId)

  const legacyFile = path.join(legacyRootDir, `${projectId}.json`)
  await fs.copyFile(legacyFile, `${legacyFile}.bak`)
  return repository.importLegacy(projectId, legacy.document, defaultModelId)
}

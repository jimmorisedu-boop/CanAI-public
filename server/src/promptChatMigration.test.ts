import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensurePromptChatV2 } from './promptChatMigration.js'
import { PromptChatRepository } from './promptChatStorage.js'
import type { PromptChatMessage } from './promptChats.js'

function makeLegacyMessages(count: number, prefix = 'active'): PromptChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-m${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `${prefix} сообщение ${index + 1}`,
    createdAt: index + 1,
    status: index % 2 === 0 ? undefined : 'done',
  }))
}

function makeLegacyArchives(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `archive-${index + 1}`,
    title: `Архив ${index + 1}`,
    createdAt: 1_000 + index,
    messages: makeLegacyMessages(2, `archive-${index + 1}`),
  }))
}

function removeTempDir(rootDir: string) {
  return fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

test('мигрирует активный диалог и все архивы один раз без старых лимитов', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-migration-'))
  t.after(() => removeTempDir(rootDir))
  const legacyFile = path.join(rootDir, 'p1.json')
  await fs.writeFile(legacyFile, JSON.stringify({
    revision: 7,
    document: {
      version: 1,
      conversationId: 'active',
      messages: makeLegacyMessages(140),
      archives: makeLegacyArchives(24),
    },
  }))

  let generated = 0
  const repo = new PromptChatRepository({
    rootDir,
    now: () => 2_000,
    id: () => `generated-${++generated}`,
  })
  const index = await ensurePromptChatV2('p1', 'claude', { repository: repo, legacyRootDir: rootDir })
  assert.equal(index.conversations.length, 25)
  assert.equal(index.activeConversationId, 'active')
  assert.equal((await repo.loadAll('p1', 'active')).length, 140)
  assert.equal(await exists(`${legacyFile}.bak`), true)

  const ids = index.conversations.map((item) => item.id)
  const repeated = await ensurePromptChatV2('p1', 'claude', { repository: repo, legacyRootDir: rootDir })
  assert.deepEqual(repeated.conversations.map((item) => item.id), ids)
  assert.equal(repeated.revision, index.revision)
})

test('не публикует V2-индекс поверх повреждённого legacy-файла', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-migration-corrupt-'))
  t.after(() => removeTempDir(rootDir))
  const legacyFile = path.join(rootDir, 'p1.json')
  await fs.writeFile(legacyFile, '{"revision":')
  const repo = new PromptChatRepository({ rootDir, now: () => 1, id: () => 'generated' })

  await assert.rejects(
    () => ensurePromptChatV2('p1', 'gemini', { repository: repo, legacyRootDir: rootDir }),
    /corrupted legacy-file/u,
  )
  assert.equal(await exists(path.join(rootDir, 'p1', 'index.json')), false)
  assert.equal(await fs.readFile(legacyFile, 'utf8'), '{"revision":')
})

test('заменяет небезопасные и повторяющиеся legacy-id детерминированно', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-migration-ids-'))
  t.after(() => removeTempDir(rootDir))
  await fs.writeFile(path.join(rootDir, 'p1.json'), JSON.stringify({
    revision: 1,
    document: {
      version: 1,
      conversationId: '../active',
      messages: [],
      archives: [
        { id: '../active', title: 'A', createdAt: 1, messages: [] },
        { id: '../active', title: 'B', createdAt: 2, messages: [] },
      ],
    },
  }))
  const repo = new PromptChatRepository({ rootDir, now: () => 3, id: () => 'unused' })

  const index = await ensurePromptChatV2('p1', 'gemini', { repository: repo, legacyRootDir: rootDir })
  assert.equal(new Set(index.conversations.map((item) => item.id)).size, 3)
  assert.ok(index.conversations.every((item) => /^[A-Za-z0-9_-]+$/.test(item.id)))
})

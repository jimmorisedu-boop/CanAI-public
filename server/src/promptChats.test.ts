import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  isLegacyPromptChatDocument,
  readLegacyPromptChat,
  type PromptChatMessage,
} from './promptChats.js'
import { PromptChatRepository } from './promptChatStorage.js'
import type { PromptChatMessageV2 } from './promptChatTypes.js'

function message(index: number): PromptChatMessage {
  return {
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Сообщение ${index}`,
    createdAt: index,
    ...(index % 2 === 0 ? {} : { status: 'done' as const, reply: `Ответ ${index}` }),
  }
}

test('legacy parser читает неограниченную историю только для миграции', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-legacy-chat-'))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  const document = {
    version: 1 as const,
    conversationId: 'active',
    messages: Array.from({ length: 120 }, (_, index) => message(index)),
    archives: Array.from({ length: 24 }, (_, archiveIndex) => ({
      id: `archive-${archiveIndex}`,
      title: `Архив ${archiveIndex}`,
      createdAt: archiveIndex,
      messages: [message(archiveIndex + 200)],
    })),
  }
  await fs.writeFile(
    path.join(rootDir, 'p1.json'),
    JSON.stringify({ revision: 9, document }),
  )

  const loaded = await readLegacyPromptChat('p1', rootDir)

  assert.equal(loaded?.revision, 9)
  assert.equal(loaded?.document.messages.length, 120)
  assert.equal(loaded?.document.archives?.length, 24)
  assert.equal(isLegacyPromptChatDocument(document), true)
})

test('legacy parser принимает до десяти подсказок, но не одиннадцать', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-legacy-chat-'))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  const prompts = (count: number) => Array.from({ length: count }, (_, index) => ({
    title: `Вариант ${index + 1}`,
    prompt: `Промпт ${index + 1}`,
  }))
  const document = {
    version: 1 as const,
    conversationId: 'active',
    messages: [{ ...message(1), prompts: prompts(10) }],
  }
  const file = path.join(rootDir, 'p1.json')
  await fs.writeFile(file, JSON.stringify({ revision: 1, document }))
  assert.equal((await readLegacyPromptChat('p1', rootDir))?.document.messages[0]?.prompts?.length, 10)

  await fs.writeFile(file, JSON.stringify({
    revision: 1,
    document: { ...document, messages: [{ ...message(1), prompts: prompts(11) }] },
  }))
  await assert.rejects(() => readLegacyPromptChat('p1', rootDir), /corrupted legacy-file/)
})

test('legacy parser отклоняет inline-data и не переписывает повреждённый файл', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-legacy-chat-'))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  const unsafe = {
    version: 1 as const,
    conversationId: 'active',
    messages: [{
      ...message(1),
      attachments: [{
        shapeId: 'shape-1',
        kind: 'image' as const,
        label: 'Референс',
        src: 'data:image/png;base64,AAAA',
      }],
    }],
  }
  assert.equal(isLegacyPromptChatDocument(unsafe), false)

  const file = path.join(rootDir, 'p1.json')
  await fs.writeFile(file, '{"revision":')
  await assert.rejects(() => readLegacyPromptChat('p1', rootDir), /corrupted legacy-file/)
  assert.equal(await fs.readFile(file, 'utf8'), '{"revision":')
})

test('V2 append/load сохраняет пакет из десяти промптов помощника', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-prompts-'))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  const repo = new PromptChatRepository({ rootDir, now: () => 100, id: () => 'c1' })
  const conversation = await repo.createOrReuseEmpty('p1', 'gemini')
  const message: PromptChatMessageV2 = {
    id: 'answer-10',
    role: 'assistant',
    text: '',
    createdAt: 100,
    status: 'done',
    prompts: Array.from({ length: 10 }, (_, index) => ({
      title: `Вариант ${index + 1}`,
      prompt: `Промпт ${index + 1}`,
    })),
  }

  await repo.appendMessages('p1', conversation.id, [message])
  const loaded = await repo.loadAll('p1', conversation.id)
  assert.equal(loaded[0]?.prompts?.length, 10)

  const tooMany: PromptChatMessageV2 = {
    ...message,
    id: 'answer-11',
    prompts: Array.from({ length: 11 }, (_, index) => ({
      title: `Вариант ${index + 1}`,
      prompt: `Промпт ${index + 1}`,
    })),
  }
  await assert.rejects(
    () => repo.appendMessages('p1', conversation.id, [tooMany]),
    /invalid message format/,
  )
  assert.equal((await repo.loadAll('p1', conversation.id)).length, 1)
})

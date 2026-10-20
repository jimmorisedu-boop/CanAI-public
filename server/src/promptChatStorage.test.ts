import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PromptChatRepository } from './promptChatStorage.js'
import type { PromptChatMessageV2 } from './promptChatTypes.js'

function makeMessages(count: number): PromptChatMessageV2[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Сообщение ${index + 1}`,
    createdAt: index + 1,
    status: index % 2 === 0 ? undefined : 'done',
  }))
}

function messageWithSrc(src: string): PromptChatMessageV2 {
  return {
    id: 'unsafe',
    role: 'user',
    text: 'Референс',
    createdAt: 200,
    attachments: [{
      shapeId: 'shape-1',
      kind: 'image',
      label: 'Картинка',
      src,
    }],
  }
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

function removeTempDir(rootDir: string): Promise<void> {
  // Windows may briefly keep a freshly renamed JSON file open. maxRetries is
  // only honored for recursive rm and avoids a test-only ENOTEMPTY race.
  return fs.rm(rootDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  }).catch(() => {})
}

test('создаёт один пустой диалог и разбивает неограниченную историю на чанки', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-v2-'))
  t.after(() => removeTempDir(rootDir))
  const idQueue = ['c1', 'c2']
  const repo = new PromptChatRepository({
    rootDir,
    now: () => 100,
    id: () => idQueue.shift() ?? 'generated',
  })

  const first = await repo.createOrReuseEmpty('p1', 'gemini')
  const second = await repo.createOrReuseEmpty('p1', 'gemini')
  assert.equal(second.id, first.id)
  await repo.patchMeta('p1', first.id, {
    draft: {
      text: 'Не потерять этот черновик',
      attachments: [],
      selectionStart: 24,
      selectionEnd: 24,
    },
  })
  const third = await repo.createOrReuseEmpty('p1', 'gemini')
  assert.equal(third.id, 'c2')
  assert.equal((await repo.loadMeta('p1', first.id)).draft.text, 'Не потерять этот черновик')

  await repo.appendMessages('p1', first.id, makeMessages(125))
  const newest = await repo.loadPage('p1', first.id, { limit: 50 })
  assert.equal(newest.messages.length, 50)
  assert.deepEqual(newest.messages.map((message) => message.id), makeMessages(125).slice(75).map((message) => message.id))
  assert.ok(newest.before)

  const older = await repo.loadPage('p1', first.id, { limit: 50, before: newest.before! })
  assert.deepEqual(older.messages.map((message) => message.id), makeMessages(125).slice(25, 75).map((message) => message.id))

  const files = await fs.readdir(path.join(rootDir, 'p1', 'conversations', first.id, 'messages'))
  assert.deepEqual(files.filter((file) => !file.endsWith('.bak')), ['000001.json', '000002.json', '000003.json'])
})

test('отклоняет inline-data до записи и не повреждает индекс', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-v2-safe-'))
  t.after(() => removeTempDir(rootDir))
  const repo = new PromptChatRepository({ rootDir, now: () => 100, id: () => 'c1' })
  const conversation = await repo.createOrReuseEmpty('p1', 'gemini')

  await assert.rejects(
    () => repo.appendMessages('p1', conversation.id, [messageWithSrc('data:image/png;base64,AAAA')]),
    /base64/,
  )
  assert.deepEqual((await repo.list('p1')).conversations.map((item) => item.id), [conversation.id])
  assert.deepEqual(await repo.loadAll('p1', conversation.id), [])
})

test('сохраняет переключатель памяти доски отдельно от истории и переживает перезагрузку', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-board-memory-'))
  t.after(() => removeTempDir(rootDir))
  const repo = new PromptChatRepository({ rootDir, now: () => 100, id: () => 'c1' })
  const conversation = await repo.createOrReuseEmpty('p1', 'gemini')
  await repo.appendMessages('p1', conversation.id, [{
    id: 'm1', role: 'user', text: 'История остаётся', createdAt: 101,
  }])

  const before = await repo.list('p1')
  assert.equal(before.boardMemoryEnabled, true)
  const disabled = await repo.setBoardMemoryEnabled('p1', false)
  assert.equal(disabled.boardMemoryEnabled, false)
  assert.equal(disabled.revision, before.revision + 1)
  const repeated = await repo.setBoardMemoryEnabled('p1', false)
  assert.equal(repeated.revision, disabled.revision, 'повтор того же значения идемпотентен')

  const reloaded = new PromptChatRepository({ rootDir, now: () => 200, id: () => 'c2' })
  assert.equal((await reloaded.list('p1')).boardMemoryEnabled, false)
  assert.equal((await reloaded.loadAll('p1', conversation.id)).length, 1)
  const enabled = await reloaded.setBoardMemoryEnabled('p1', true)
  assert.equal(enabled.boardMemoryEnabled, true)

  const indexFile = path.join(rootDir, 'p1', 'index.json')
  const legacyIndex = JSON.parse(await fs.readFile(indexFile, 'utf8')) as Record<string, unknown>
  delete legacyIndex.boardMemoryEnabled
  await fs.writeFile(indexFile, JSON.stringify(legacyIndex))
  const legacyReload = new PromptChatRepository({ rootDir, now: () => 300, id: () => 'c3' })
  assert.equal((await legacyReload.list('p1')).boardMemoryEnabled, true, 'старый index означает включённое состояние')
})

test('обновляет метаданные и заменяет только нужное сообщение', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-v2-meta-'))
  t.after(() => removeTempDir(rootDir))
  let now = 100
  const repo = new PromptChatRepository({ rootDir, now: () => now, id: () => 'c1' })
  const conversation = await repo.createOrReuseEmpty('p1', 'gemini')
  await repo.appendMessages('p1', conversation.id, makeMessages(3))

  now = 200
  const patched = await repo.patchMeta('p1', conversation.id, {
    title: 'Кампания',
    selectedModelId: 'claude',
  })
  assert.equal(patched.title, 'Кампания')
  assert.equal(patched.selectedModelId, 'claude')
  assert.equal(patched.updatedAt, 200)

  await repo.replaceMessage('p1', conversation.id, {
    ...makeMessages(3)[2],
    role: 'assistant',
    status: 'done',
    text: 'Готовый ответ',
    reply: 'Готовый ответ',
  })
  assert.equal((await repo.loadAll('p1', conversation.id))[2].reply, 'Готовый ответ')
  assert.equal((await repo.list('p1')).conversations[0].preview, 'Готовый ответ')
  assert.equal((await repo.list('p1')).conversations[0].attention, 'unread')

  const activated = await repo.activate('p1', conversation.id)
  assert.equal(activated.lastReadAssistantMessageId, 'm3')
  assert.equal((await repo.list('p1')).activeConversationId, conversation.id)
  assert.equal((await repo.list('p1')).conversations[0].attention, 'idle')
})

test('перемещает диалог в корзину, восстанавливает и удаляет окончательно', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-v2-trash-'))
  t.after(() => removeTempDir(rootDir))
  const repo = new PromptChatRepository({ rootDir, now: () => 100, id: () => 'c1' })
  const conversation = await repo.createOrReuseEmpty('p1', 'gemini')

  await repo.moveToTrash('p1', conversation.id)
  assert.deepEqual((await repo.list('p1')).conversations, [])
  assert.equal(await exists(path.join(rootDir, 'p1', 'trash', conversation.id, 'meta.json')), true)

  await repo.restore('p1', conversation.id)
  assert.equal((await repo.list('p1')).conversations[0].id, conversation.id)

  await repo.moveToTrash('p1', conversation.id)
  await repo.permanentDelete('p1', conversation.id)
  assert.equal(await exists(path.join(rootDir, 'p1', 'trash', conversation.id)), false)
})

test('keeps a conversation active when moving it to trash cannot commit its index', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-v2-trash-rollback-'))
  t.after(() => removeTempDir(rootDir))
  const repo = new PromptChatRepository({ rootDir, now: () => 100, id: () => 'c1' })
  const conversation = await repo.createOrReuseEmpty('p1', 'gemini')
  const realRename = fs.rename
  const renameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const [source, destination] = args
    const indexFile = path.join(rootDir, 'p1', 'index.json')
    if (
      typeof source === 'string'
      && typeof destination === 'string'
      && destination === indexFile
      && source.startsWith(`${indexFile}.`)
      && source.endsWith('.tmp')
    ) {
      throw new Error('simulated chat index write failure')
    }
    return realRename(...args)
  })

  await assert.rejects(
    () => repo.moveToTrash('p1', conversation.id),
    /simulated chat index write failure/,
  )
  renameMock.mock.restore()
  assert.equal(await exists(path.join(rootDir, 'p1', 'conversations', conversation.id, 'meta.json')), true)
  assert.equal(await exists(path.join(rootDir, 'p1', 'trash', conversation.id)), false)
})

test('keeps a conversation in trash when restoring it cannot commit its index', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-v2-restore-rollback-'))
  t.after(() => removeTempDir(rootDir))
  const repo = new PromptChatRepository({ rootDir, now: () => 100, id: () => 'c1' })
  const conversation = await repo.createOrReuseEmpty('p1', 'gemini')
  await repo.moveToTrash('p1', conversation.id)
  const realRename = fs.rename
  const renameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const [source, destination] = args
    const indexFile = path.join(rootDir, 'p1', 'index.json')
    if (
      typeof source === 'string'
      && typeof destination === 'string'
      && destination === indexFile
      && source.startsWith(`${indexFile}.`)
      && source.endsWith('.tmp')
    ) {
      throw new Error('simulated chat restore index write failure')
    }
    return realRename(...args)
  })

  await assert.rejects(
    () => repo.restore('p1', conversation.id),
    /simulated chat restore index write failure/,
  )
  renameMock.mock.restore()
  assert.equal(await exists(path.join(rootDir, 'p1', 'trash', conversation.id, 'meta.json')), true)
  assert.equal(await exists(path.join(rootDir, 'p1', 'conversations', conversation.id)), false)
})

test('ассет с полки сохраняется в черновике: shapeId вида «asset:3» валиден', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-asset-'))
  t.after(() => removeTempDir(rootDir))
  const repo = new PromptChatRepository({ rootDir, now: () => 100, id: () => 'c1' })
  const conversation = await repo.createOrReuseEmpty('p1', 'gemini')

  // раньше двоеточие не проходило ID_RE и любой ассет ронял сохранение
  // черновика ошибкой «prompt-chat: неверный черновик»
  await repo.patchMeta('p1', conversation.id, {
    draft: {
      text: 'по этому ассету',
      attachments: [
        { shapeId: 'asset:3', kind: 'image', label: 'лого.png', src: '/media/logo.png' },
      ],
      selectionStart: 0,
      selectionEnd: 0,
    },
  })

  const meta = await repo.loadMeta('p1', conversation.id)
  assert.equal(meta.draft.attachments.length, 1)
  assert.equal(meta.draft.attachments[0].shapeId, 'asset:3')
})

test('черновик по-прежнему отвергает мусорный shapeId и не-media src', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-chat-asset-bad-'))
  t.after(() => removeTempDir(rootDir))
  const repo = new PromptChatRepository({ rootDir, now: () => 100, id: () => 'c1' })
  const conversation = await repo.createOrReuseEmpty('p1', 'gemini')

  const draft = (attachment: unknown) => ({
    text: '', attachments: [attachment], selectionStart: 0, selectionEnd: 0,
  })

  await assert.rejects(
    () => repo.patchMeta('p1', conversation.id, {
      draft: draft({ shapeId: '../../etc', kind: 'image', label: 'x' }),
    } as never),
    /invalid draft/,
  )
  await assert.rejects(
    () => repo.patchMeta('p1', conversation.id, {
      draft: draft({ shapeId: 'asset:1', kind: 'image', label: 'x', src: 'https://чужой/файл.png' }),
    } as never),
    /invalid draft/,
  )
})

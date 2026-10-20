import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  EMPTY_PROMPT_CHAT_CONTEXT,
  type ConversationPage,
  type ConversationPatch,
  type PromptChatAttachment,
  type PromptChatContextV1,
  type PromptChatDraft,
  type PromptChatIndexV2,
  type PromptChatMessageV2,
  type PromptChatMetaV2,
  type PromptChatCommandName,
  type PromptChatRequestReceipt,
  type PromptChatSummary,
  type RepositoryDeps,
  SHAPE_ID_RE,
} from './promptChatTypes.js'
import type { PromptChatDocumentV1 } from './promptChats.js'
import {
  CHUNK_RE,
  CHUNK_SIZE,
  atomicJson,
  conversationLocks,
  projectLocks,
  requestLocks,
  withLock,
} from './promptChatFiles.js'
import { deterministicLegacyId, normalizeLegacyMessages } from './promptChatLegacy.js'
import {
  ID_RE,
  assertMessages,
  assertSafeId,
  attentionOf,
  emptyIndex,
  isDraft,
  isMessage,
  isNotFound,
  previewOf,
  validateContext,
  validateIndex,
  validateMeta,
  validateReceipts,
} from './promptChatValidation.js'


export class PromptChatRepository {
  constructor(private readonly deps: RepositoryDeps) {}

  private projectDir(projectId: string): string {
    assertSafeId(projectId, 'projectId')
    return path.join(this.deps.rootDir, projectId)
  }

  private conversationDir(projectId: string, conversationId: string, trashed = false): string {
    assertSafeId(conversationId, 'conversationId')
    return path.join(
      this.projectDir(projectId),
      trashed ? 'trash' : 'conversations',
      conversationId,
    )
  }

  private indexFile(projectId: string): string {
    return path.join(this.projectDir(projectId), 'index.json')
  }

  /** Legacy indexes predate the preference; their effective default is on. */
  private normalizeIndex(index: PromptChatIndexV2): PromptChatIndexV2 {
    return {
      ...index,
      boardMemoryEnabled: index.boardMemoryEnabled !== false,
    }
  }

  private async readIndex(projectId: string): Promise<PromptChatIndexV2> {
    try {
      return this.normalizeIndex(validateIndex(JSON.parse(await fs.readFile(this.indexFile(projectId), 'utf8'))))
    } catch (error) {
      if (isNotFound(error)) return emptyIndex()
      throw error
    }
  }

  private async readReceipts(projectId: string): Promise<PromptChatRequestReceipt[]> {
    const file = path.join(this.projectDir(projectId), 'requests.json')
    try {
      return validateReceipts(JSON.parse(await fs.readFile(file, 'utf8')))
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
  }

  private async readMeta(projectId: string, conversationId: string, trashed = false): Promise<PromptChatMetaV2> {
    const file = path.join(this.conversationDir(projectId, conversationId, trashed), 'meta.json')
    try {
      return validateMeta(JSON.parse(await fs.readFile(file, 'utf8')))
    } catch (error) {
      if (isNotFound(error)) throw new Error('prompt-chat: chat not found')
      throw error
    }
  }

  private async chunkFiles(projectId: string, conversationId: string, trashed = false): Promise<string[]> {
    const dir = path.join(this.conversationDir(projectId, conversationId, trashed), 'messages')
    try {
      return (await fs.readdir(dir)).filter((file) => CHUNK_RE.test(file)).sort()
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
  }

  private async readChunk(
    projectId: string,
    conversationId: string,
    file: string,
    trashed = false,
  ): Promise<PromptChatMessageV2[]> {
    const parsed = JSON.parse(await fs.readFile(
      path.join(this.conversationDir(projectId, conversationId, trashed), 'messages', file),
      'utf8',
    )) as unknown
    if (!Array.isArray(parsed) || !parsed.every(isMessage)) {
      throw new Error(`prompt-chat: corrupted chunk ${file}`)
    }
    return parsed
  }

  private async readAllUnlocked(
    projectId: string,
    conversationId: string,
    trashed = false,
  ): Promise<PromptChatMessageV2[]> {
    const chunks = await this.chunkFiles(projectId, conversationId, trashed)
    const messages: PromptChatMessageV2[] = []
    for (const file of chunks) messages.push(...await this.readChunk(projectId, conversationId, file, trashed))
    return messages
  }

  private async writeIndexSummary(
    projectId: string,
    meta: PromptChatMetaV2,
    messages: PromptChatMessageV2[],
  ): Promise<void> {
    await withLock(projectLocks, projectId, async () => {
      const index = await this.readIndex(projectId)
      const current = index.conversations.find((item) => item.id === meta.id)
      if (!current) throw new Error('prompt-chat: chat is missing from the index')
      const summary: PromptChatSummary = {
        id: meta.id,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        preview: previewOf(messages),
        attention: attentionOf(messages, meta.lastReadAssistantMessageId),
      }
      await atomicJson(this.indexFile(projectId), {
        ...index,
        revision: index.revision + 1,
        conversations: index.conversations.map((item) => item.id === meta.id ? summary : item),
      } satisfies PromptChatIndexV2)
    })
  }

  async readIndexIfExists(projectId: string): Promise<PromptChatIndexV2 | null> {
    return withLock(projectLocks, projectId, async () => {
      try {
        return this.normalizeIndex(validateIndex(JSON.parse(await fs.readFile(this.indexFile(projectId), 'utf8'))))
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    })
  }

  async ensureProject(projectId: string): Promise<PromptChatIndexV2> {
    return withLock(projectLocks, projectId, async () => {
      const existing = await this.readIndex(projectId)
      try {
        await fs.access(this.indexFile(projectId))
        return existing
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      await atomicJson(this.indexFile(projectId), existing)
      return existing
    })
  }

  async importLegacy(
    projectId: string,
    document: PromptChatDocumentV1,
    defaultModelId: string,
  ): Promise<PromptChatIndexV2> {
    assertSafeId(defaultModelId, 'modelId')
    return withLock(projectLocks, projectId, async () => {
      const existing = await this.readIndex(projectId)
      try {
        await fs.access(this.indexFile(projectId))
        return existing
      } catch (error) {
        if (!isNotFound(error)) throw error
      }

      const sources = [
        {
          sourceId: document.conversationId,
          title: 'Chat',
          createdAt: document.messages[0]?.createdAt ?? this.deps.now(),
          messages: document.messages,
          active: true,
        },
        ...(document.archives ?? []).map((archive) => ({
          sourceId: archive.id,
          title: archive.title || 'Chat',
          createdAt: archive.createdAt,
          messages: archive.messages,
          active: false,
        })),
      ]
      const used = new Set<string>()
      const summaries: PromptChatSummary[] = []
      let activeConversationId: string | null = null

      for (const [index, source] of sources.entries()) {
        let id = source.sourceId
        if (!ID_RE.test(id) || used.has(id)) {
          id = deterministicLegacyId(projectId, source.sourceId, index, 'conversation')
        }
        while (used.has(id)) id = `${id}-${index}`
        used.add(id)
        if (source.active) activeConversationId = id
        const messages = normalizeLegacyMessages(projectId, id, source.messages)
        const updatedAt = messages.at(-1)?.createdAt ?? source.createdAt
        const meta: PromptChatMetaV2 = {
          version: 2,
          revision: 0,
          id,
          projectId,
          title: source.title,
          selectedModelId: defaultModelId,
          createdAt: source.createdAt,
          updatedAt,
          draft: { text: '', attachments: [], selectionStart: 0, selectionEnd: 0 },
          activeJobIds: [],
          lastReadAssistantMessageId: [...messages].reverse().find((message) => (
            message.role === 'assistant' && message.status === 'done'
          ))?.id,
        }
        const dir = this.conversationDir(projectId, id)
        await atomicJson(path.join(dir, 'meta.json'), meta)
        await atomicJson(path.join(dir, 'context.json'), EMPTY_PROMPT_CHAT_CONTEXT)
        for (let chunk = 0; chunk * CHUNK_SIZE < messages.length; chunk += 1) {
          await atomicJson(
            path.join(dir, 'messages', `${String(chunk + 1).padStart(6, '0')}.json`),
            messages.slice(chunk * CHUNK_SIZE, (chunk + 1) * CHUNK_SIZE),
          )
        }
        summaries.push({
          id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          preview: previewOf(messages),
          attention: 'idle',
        })
      }

      const index: PromptChatIndexV2 = {
        version: 2,
        revision: 1,
        activeConversationId,
        conversations: summaries,
        hasTrash: false,
        boardMemoryEnabled: true,
      }
      await atomicJson(this.indexFile(projectId), index)
      return index
    })
  }

  async createOrReuseEmpty(projectId: string, defaultModelId: string): Promise<PromptChatMetaV2> {
    assertSafeId(defaultModelId, 'modelId')
    return withLock(projectLocks, projectId, async () => {
      const index = await this.readIndex(projectId)
      let reusable: PromptChatMetaV2 | null = null
      for (const summary of index.conversations) {
        if (summary.preview !== '') continue
        const meta = await this.readMeta(projectId, summary.id)
        if (
          meta.activeJobIds.length === 0
          && meta.draft.text.length === 0
          && meta.draft.attachments.length === 0
          && (await this.readAllUnlocked(projectId, summary.id)).length === 0
        ) {
          reusable = meta
          break
        }
      }
      if (reusable) {
        if (index.activeConversationId !== reusable.id) {
          await atomicJson(this.indexFile(projectId), {
            ...index,
            revision: index.revision + 1,
            activeConversationId: reusable.id,
          } satisfies PromptChatIndexV2)
        }
        return reusable
      }

      const id = this.deps.id()
      assertSafeId(id, 'conversationId')
      const now = this.deps.now()
      const meta: PromptChatMetaV2 = {
        version: 2,
        revision: 0,
        id,
        projectId,
        title: 'New chat',
        selectedModelId: defaultModelId,
        createdAt: now,
        updatedAt: now,
        draft: { text: '', attachments: [], selectionStart: 0, selectionEnd: 0 },
        activeJobIds: [],
      }
      const dir = this.conversationDir(projectId, id)
      await atomicJson(path.join(dir, 'meta.json'), meta)
      await atomicJson(path.join(dir, 'context.json'), EMPTY_PROMPT_CHAT_CONTEXT)
      const summary: PromptChatSummary = {
        id,
        title: meta.title,
        createdAt: now,
        updatedAt: now,
        preview: '',
        attention: 'idle',
      }
      await atomicJson(this.indexFile(projectId), {
        ...index,
        revision: index.revision + 1,
        activeConversationId: id,
        conversations: [summary, ...index.conversations],
      } satisfies PromptChatIndexV2)
      return meta
    })
  }

  async list(projectId: string): Promise<PromptChatIndexV2> {
    return withLock(projectLocks, projectId, () => this.readIndex(projectId))
  }

  async getBoardMemoryEnabled(projectId: string): Promise<boolean> {
    return withLock(projectLocks, projectId, async () => (
      (await this.readIndex(projectId)).boardMemoryEnabled !== false
    ))
  }

  async setBoardMemoryEnabled(projectId: string, enabled: boolean): Promise<PromptChatIndexV2> {
    if (typeof enabled !== 'boolean') throw new Error('prompt-chat: boardMemoryEnabled must be boolean')
    return withLock(projectLocks, projectId, async () => {
      const index = await this.readIndex(projectId)
      if (index.boardMemoryEnabled === enabled) return index
      const next: PromptChatIndexV2 = {
        ...index,
        revision: index.revision + 1,
        boardMemoryEnabled: enabled,
      }
      await atomicJson(this.indexFile(projectId), next)
      return next
    })
  }

  async listTrash(projectId: string): Promise<PromptChatSummary[]> {
    return withLock(projectLocks, projectId, async () => {
      const trashDir = path.join(this.projectDir(projectId), 'trash')
      let ids: string[]
      try {
        ids = (await fs.readdir(trashDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && ID_RE.test(entry.name))
          .map((entry) => entry.name)
      } catch (error) {
        if (isNotFound(error)) return []
        throw error
      }
      const summaries: PromptChatSummary[] = []
      for (const id of ids) {
        const meta = await this.readMeta(projectId, id, true)
        const messages = await this.readAllUnlocked(projectId, id, true)
        summaries.push({
          id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          preview: previewOf(messages),
          attention: attentionOf(messages, meta.lastReadAssistantMessageId),
        })
      }
      return summaries.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    })
  }

  async activate(projectId: string, conversationId: string): Promise<PromptChatMetaV2> {
    const key = `${projectId}/${conversationId}`
    return withLock(conversationLocks, key, async () => {
      const current = await this.readMeta(projectId, conversationId)
      const messages = await this.readAllUnlocked(projectId, conversationId)
      const lastReadAssistantMessageId = [...messages].reverse().find((message) => (
        message.role === 'assistant' && message.status === 'done'
      ))?.id
      const changed = Boolean(
        lastReadAssistantMessageId
        && lastReadAssistantMessageId !== current.lastReadAssistantMessageId,
      )
      const meta: PromptChatMetaV2 = changed
        ? {
            ...current,
            lastReadAssistantMessageId,
            revision: current.revision + 1,
            updatedAt: this.deps.now(),
          }
        : current
      if (changed) {
        await atomicJson(path.join(this.conversationDir(projectId, conversationId), 'meta.json'), meta)
      }
      await withLock(projectLocks, projectId, async () => {
        const index = await this.readIndex(projectId)
        if (!index.conversations.some((item) => item.id === conversationId)) {
          throw new Error('prompt-chat: chat is missing from the index')
        }
        await atomicJson(this.indexFile(projectId), {
          ...index,
          revision: index.revision + 1,
          activeConversationId: conversationId,
          conversations: index.conversations.map((item) => (
            item.id === conversationId
              ? {
                  ...item,
                  updatedAt: meta.updatedAt,
                  attention: attentionOf(messages, meta.lastReadAssistantMessageId),
                }
              : item
          )),
        } satisfies PromptChatIndexV2)
      })
      return meta
    })
  }

  async loadMeta(projectId: string, conversationId: string): Promise<PromptChatMetaV2> {
    const key = `${projectId}/${conversationId}`
    return withLock(conversationLocks, key, () => this.readMeta(projectId, conversationId))
  }

  async loadContext(projectId: string, conversationId: string): Promise<PromptChatContextV1> {
    const key = `${projectId}/${conversationId}`
    return withLock(conversationLocks, key, async () => {
      await this.readMeta(projectId, conversationId)
      const file = path.join(this.conversationDir(projectId, conversationId), 'context.json')
      try {
        return validateContext(JSON.parse(await fs.readFile(file, 'utf8')))
      } catch (error) {
        if (isNotFound(error)) return structuredClone(EMPTY_PROMPT_CHAT_CONTEXT)
        throw error
      }
    })
  }

  async replaceContext(
    projectId: string,
    conversationId: string,
    expectedRevision: number,
    nextContext: PromptChatContextV1,
  ): Promise<void> {
    const validated = validateContext(structuredClone(nextContext))
    if (validated.revision !== expectedRevision + 1) {
      throw new Error('prompt-chat: invalid next context revision')
    }
    const key = `${projectId}/${conversationId}`
    await withLock(conversationLocks, key, async () => {
      await this.readMeta(projectId, conversationId)
      const file = path.join(this.conversationDir(projectId, conversationId), 'context.json')
      let current: PromptChatContextV1
      try {
        current = validateContext(JSON.parse(await fs.readFile(file, 'utf8')))
      } catch (error) {
        if (!isNotFound(error)) throw error
        current = structuredClone(EMPTY_PROMPT_CHAT_CONTEXT)
      }
      if (current.revision !== expectedRevision) {
        throw new Error('prompt-chat: context revision conflict')
      }
      await atomicJson(file, validated)
    })
  }

  async withIdempotency<T>(
    projectId: string,
    scope: string,
    requestId: string,
    command: PromptChatCommandName,
    action: () => Promise<T>,
  ): Promise<T> {
    assertSafeId(requestId, 'requestId')
    if (!scope || scope.length > 100) throw new Error('prompt-chat: invalid team scope')
    const key = projectId
    return withLock(requestLocks, key, async () => {
      const receipts = await this.readReceipts(projectId)
      const previous = receipts.find((receipt) => (
        receipt.scope === scope
        && receipt.requestId === requestId
        && receipt.command === command
      ))
      if (previous) return structuredClone(previous.result) as T

      const result = await action()
      const receipt: PromptChatRequestReceipt = {
        scope,
        requestId,
        command,
        createdAt: this.deps.now(),
        result: structuredClone(result),
      }
      const next = [...receipts, receipt].slice(-128)
      await atomicJson(path.join(this.projectDir(projectId), 'requests.json'), {
        version: 1,
        receipts: next,
      })
      return result
    })
  }

  async loadAll(projectId: string, conversationId: string): Promise<PromptChatMessageV2[]> {
    const key = `${projectId}/${conversationId}`
    return withLock(conversationLocks, key, async () => {
      await this.readMeta(projectId, conversationId)
      return this.readAllUnlocked(projectId, conversationId)
    })
  }

  async findMessage(
    projectId: string,
    conversationId: string,
    messageId: string,
  ): Promise<PromptChatMessageV2 | null> {
    assertSafeId(messageId, 'messageId')
    return (await this.loadAll(projectId, conversationId)).find((message) => message.id === messageId) ?? null
  }

  async loadPage(
    projectId: string,
    conversationId: string,
    page: { before?: string; limit: 50 },
  ): Promise<ConversationPage> {
    const key = `${projectId}/${conversationId}`
    return withLock(conversationLocks, key, async () => {
      const meta = await this.readMeta(projectId, conversationId)
      const files = await this.chunkFiles(projectId, conversationId)
      const chunks: PromptChatMessageV2[][] = []
      for (const file of files) chunks.push(await this.readChunk(projectId, conversationId, file))
      const messages = chunks.flat()
      let end = messages.length
      if (page.before) {
        const match = /^(\d{6}\.json):(\d{1,2})$/.exec(page.before)
        if (!match) throw new Error('prompt-chat: invalid cursor')
        const chunkIndex = files.indexOf(match[1])
        const offset = Number(match[2])
        if (chunkIndex < 0 || offset < 0 || offset > chunks[chunkIndex].length) {
          throw new Error('prompt-chat: stale cursor')
        }
        end = chunks.slice(0, chunkIndex).reduce((sum, chunk) => sum + chunk.length, 0) + offset
      }
      const limit = Math.min(Math.max(Math.floor(page.limit || CHUNK_SIZE), 1), CHUNK_SIZE)
      const start = Math.max(0, end - limit)
      let before: string | null = null
      if (start > 0) {
        let consumed = 0
        for (let index = 0; index < chunks.length; index += 1) {
          if (start <= consumed + chunks[index].length) {
            before = `${files[index]}:${start - consumed}`
            break
          }
          consumed += chunks[index].length
        }
      }

      let contextHealth: ConversationPage['contextHealth'] = 'ready'
      try {
        const context = JSON.parse(await fs.readFile(
          path.join(this.conversationDir(projectId, conversationId), 'context.json'),
          'utf8',
        )) as Partial<PromptChatContextV1>
        if (context.version !== 1) contextHealth = 'error'
        else if (context.compaction?.status === 'error') contextHealth = 'stale'
      } catch {
        contextHealth = 'error'
      }
      return { meta, messages: messages.slice(start, end), before, contextHealth }
    })
  }

  async patchMeta(
    projectId: string,
    conversationId: string,
    patch: ConversationPatch,
  ): Promise<PromptChatMetaV2> {
    const key = `${projectId}/${conversationId}`
    return withLock(conversationLocks, key, async () => {
      if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.trim().length === 0 || patch.title.length > 200)) {
        throw new Error('prompt-chat: invalid name')
      }
      if (patch.selectedModelId !== undefined) assertSafeId(patch.selectedModelId, 'modelId')
      if (patch.draft !== undefined && !isDraft(patch.draft)) throw new Error('prompt-chat: invalid draft')
      if (patch.activeJobIds !== undefined && (
        !Array.isArray(patch.activeJobIds)
        || !patch.activeJobIds.every((id) => typeof id === 'string' && ID_RE.test(id))
      )) throw new Error('prompt-chat: invalid jobId')

      const current = await this.readMeta(projectId, conversationId)
      const meta: PromptChatMetaV2 = {
        ...current,
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.selectedModelId !== undefined ? { selectedModelId: patch.selectedModelId } : {}),
        ...(patch.draft !== undefined ? { draft: structuredClone(patch.draft) } : {}),
        ...(patch.activeJobIds !== undefined ? { activeJobIds: [...patch.activeJobIds] } : {}),
        revision: current.revision + 1,
        updatedAt: this.deps.now(),
      }
      await atomicJson(path.join(this.conversationDir(projectId, conversationId), 'meta.json'), meta)
      await this.writeIndexSummary(projectId, meta, await this.readAllUnlocked(projectId, conversationId))
      return meta
    })
  }

  async appendMessages(
    projectId: string,
    conversationId: string,
    messages: PromptChatMessageV2[],
  ): Promise<void> {
    assertMessages(messages)
    if (messages.length === 0) return
    const key = `${projectId}/${conversationId}`
    await withLock(conversationLocks, key, async () => {
      const meta = await this.readMeta(projectId, conversationId)
      const existing = await this.readAllUnlocked(projectId, conversationId)
      const ids = new Set(existing.map((message) => message.id))
      if (messages.some((message) => ids.has(message.id))) throw new Error('prompt-chat: message already exists')

      const all = [...existing, ...structuredClone(messages)]
      const messagesDir = path.join(this.conversationDir(projectId, conversationId), 'messages')
      const firstChangedChunk = Math.floor(existing.length / CHUNK_SIZE)
      for (let index = firstChangedChunk; index * CHUNK_SIZE < all.length; index += 1) {
        const file = `${String(index + 1).padStart(6, '0')}.json`
        await atomicJson(
          path.join(messagesDir, file),
          all.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
        )
      }
      const updatedMeta = { ...meta, revision: meta.revision + 1, updatedAt: this.deps.now() }
      await atomicJson(path.join(this.conversationDir(projectId, conversationId), 'meta.json'), updatedMeta)
      await this.writeIndexSummary(projectId, updatedMeta, all)
    })
  }

  async replaceMessage(
    projectId: string,
    conversationId: string,
    message: PromptChatMessageV2,
  ): Promise<void> {
    assertMessages([message])
    const key = `${projectId}/${conversationId}`
    await withLock(conversationLocks, key, async () => {
      const meta = await this.readMeta(projectId, conversationId)
      const files = await this.chunkFiles(projectId, conversationId)
      const all: PromptChatMessageV2[] = []
      let replaced = false
      for (const file of files) {
        const chunk = await this.readChunk(projectId, conversationId, file)
        const index = chunk.findIndex((item) => item.id === message.id)
        if (index >= 0) {
          chunk[index] = structuredClone(message)
          await atomicJson(path.join(this.conversationDir(projectId, conversationId), 'messages', file), chunk)
          replaced = true
        }
        all.push(...chunk)
      }
      if (!replaced) throw new Error('prompt-chat: message not found')
      const updatedMeta = { ...meta, revision: meta.revision + 1, updatedAt: this.deps.now() }
      await atomicJson(path.join(this.conversationDir(projectId, conversationId), 'meta.json'), updatedMeta)
      await this.writeIndexSummary(projectId, updatedMeta, all)
    })
  }

  async moveToTrash(projectId: string, conversationId: string): Promise<void> {
    const key = `${projectId}/${conversationId}`
    await withLock(conversationLocks, key, () => withLock(projectLocks, projectId, async () => {
      const index = await this.readIndex(projectId)
      if (!index.conversations.some((item) => item.id === conversationId)) {
        throw new Error('prompt-chat: chat not found')
      }
      const source = this.conversationDir(projectId, conversationId)
      const target = this.conversationDir(projectId, conversationId, true)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.rename(source, target)
      try {
        const conversations = index.conversations.filter((item) => item.id !== conversationId)
        await atomicJson(this.indexFile(projectId), {
          ...index,
          revision: index.revision + 1,
          activeConversationId: index.activeConversationId === conversationId
            ? conversations[0]?.id ?? null
            : index.activeConversationId,
          conversations,
          hasTrash: true,
        } satisfies PromptChatIndexV2)
      } catch (error) {
        await fs.rename(target, source).catch(() => {})
        throw error
      }
    }))
  }

  async restore(projectId: string, conversationId: string): Promise<void> {
    const key = `${projectId}/${conversationId}`
    await withLock(conversationLocks, key, () => withLock(projectLocks, projectId, async () => {
      const index = await this.readIndex(projectId)
      const source = this.conversationDir(projectId, conversationId, true)
      const target = this.conversationDir(projectId, conversationId)
      const meta = await this.readMeta(projectId, conversationId, true)
      const messages = await this.readAllUnlocked(projectId, conversationId, true)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.rename(source, target)
      try {
        const summary: PromptChatSummary = {
          id: meta.id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          preview: previewOf(messages),
          attention: attentionOf(messages, meta.lastReadAssistantMessageId),
        }
        const trashEntries = await fs.readdir(path.join(this.projectDir(projectId), 'trash')).catch(() => [])
        await atomicJson(this.indexFile(projectId), {
          ...index,
          revision: index.revision + 1,
          activeConversationId: conversationId,
          conversations: [summary, ...index.conversations],
          hasTrash: trashEntries.length > 0,
        } satisfies PromptChatIndexV2)
      } catch (error) {
        await fs.rename(target, source).catch(() => {})
        throw error
      }
    }))
  }

  async permanentDelete(projectId: string, conversationId: string): Promise<void> {
    const key = `${projectId}/${conversationId}`
    await withLock(conversationLocks, key, () => withLock(projectLocks, projectId, async () => {
      const target = this.conversationDir(projectId, conversationId, true)
      await this.readMeta(projectId, conversationId, true)
      await fs.rm(target, { recursive: true, force: true })
      const index = await this.readIndex(projectId)
      const trashEntries = await fs.readdir(path.join(this.projectDir(projectId), 'trash')).catch(() => [])
      await atomicJson(this.indexFile(projectId), {
        ...index,
        revision: index.revision + 1,
        hasTrash: trashEntries.length > 0,
      } satisfies PromptChatIndexV2)
    }))
  }
}

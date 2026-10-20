import { CATALOG } from './catalog.js'
import type {
  AppendHistoryMessagesInput,
  AppendHistoryMessagesResult,
  BeginTurnInput,
  BeginTurnResult,
  ConversationPatch,
  PromptChatAttachment,
  PromptChatHistoryMessageInput,
  PromptChatEstimate,
  PromptChatMessageV2,
  PromptChatMetaV2,
  RecordUserMessageInput,
  RecordUserMessageResult,
} from './promptChatTypes.js'
import { PromptChatRepository } from './promptChatStorage.js'

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export interface PromptChatJobDescriptor {
  id: string
  kind: 'prompt-chat'
  prompt: string
  projectId: string
  conversationId: string
  requestMessageId: string
  responseMessageId: string
  requestId: string
  modelId: string
  boardMemoryEnabled: boolean
}

export interface PromptChatCommandsDeps {
  repository: PromptChatRepository
  now: () => number
  id: () => string
  estimateTurn: (
    projectId: string,
    conversationId: string,
    modelId: string,
    text: string,
    attachments: PromptChatAttachment[],
    boardMemoryEnabled?: boolean,
  ) => Promise<PromptChatEstimate>
  getBoardMemoryEnabled?: (projectId: string) => Promise<boolean>
  getConfirmCostAboveUsd: () => Promise<number>
  createJob: (descriptor: PromptChatJobDescriptor) => Promise<void>
}

export class PromptChatCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly estimate?: PromptChatEstimate,
  ) {
    super(message)
    this.name = 'PromptChatCommandError'
  }
}

function assertRequestId(requestId: string): void {
  if (!ID_RE.test(requestId)) throw new PromptChatCommandError('Invalid requestId', 'PROMPT_CHAT_INVALID')
}

function validateAttachments(attachments: PromptChatAttachment[]): void {
  if (!Array.isArray(attachments) || attachments.length > 8) {
    throw new PromptChatCommandError('You can attach at most 8 references', 'PROMPT_CHAT_INVALID')
  }
  let serialized = ''
  try {
    serialized = JSON.stringify(attachments).toLowerCase()
  } catch {
    throw new PromptChatCommandError('Invalid references', 'PROMPT_CHAT_INVALID')
  }
  if (serialized.includes('data:') || serialized.includes(';base64,')) {
    throw new PromptChatCommandError('Base64 and data URLs are not allowed in chat', 'PROMPT_CHAT_INVALID')
  }
  for (const attachment of attachments) {
    if (
      !attachment
      || !ID_RE.test(attachment.shapeId)
      || !['image', 'video', 'text'].includes(attachment.kind)
      || typeof attachment.label !== 'string'
      || attachment.label.length > 500
      || (attachment.src !== undefined && (
        !attachment.src.startsWith('/media/')
        || attachment.src.includes('..')
        || attachment.src.length > 2_000
      ))
      || (attachment.text !== undefined && attachment.text.length > 8_000)
    ) {
      throw new PromptChatCommandError('Invalid reference', 'PROMPT_CHAT_INVALID')
    }
  }
}

function validateHistoryMessages(messages: PromptChatHistoryMessageInput[]): void {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 8) {
    throw new PromptChatCommandError('Provide 1–8 workflow events', 'PROMPT_CHAT_INVALID')
  }
  let serialized = ''
  try {
    serialized = JSON.stringify(messages).toLowerCase()
  } catch {
    throw new PromptChatCommandError('Invalid workflow events', 'PROMPT_CHAT_INVALID')
  }
  if (serialized.includes('data:') || serialized.includes(';base64,')) {
    throw new PromptChatCommandError('Base64 and data URLs are not allowed in chat', 'PROMPT_CHAT_INVALID')
  }
  for (const message of messages) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string' || message.text.length > 12_000) {
      throw new PromptChatCommandError('Invalid workflow event', 'PROMPT_CHAT_INVALID')
    }
    if (message.role === 'user' && !message.text.trim()) {
      throw new PromptChatCommandError('Workflow message is empty', 'PROMPT_CHAT_INVALID')
    }
    if (message.role === 'assistant' && (
      message.text !== ''
      || typeof message.reply !== 'string'
      || !message.reply.trim()
      || message.reply.length > 12_000
    )) {
      throw new PromptChatCommandError('Invalid workflow result', 'PROMPT_CHAT_INVALID')
    }
    if (message.role === 'user' && message.reply !== undefined) {
      throw new PromptChatCommandError('Invalid workflow event', 'PROMPT_CHAT_INVALID')
    }
  }
}

function textModel(modelId: string) {
  const model = CATALOG.find((item) => item.id === modelId && item.kind === 'text')
  if (!model) throw new PromptChatCommandError('Text model not found', 'PROMPT_CHAT_MODEL_NOT_FOUND')
  return model
}

export class PromptChatCommands {
  constructor(private readonly deps: PromptChatCommandsDeps) {}

  create(
    projectId: string,
    input: { requestId: string; defaultModelId: string },
  ): Promise<{ conversation: PromptChatMetaV2 }> {
    assertRequestId(input.requestId)
    textModel(input.defaultModelId)
    return this.deps.repository.withIdempotency(
      projectId,
      'project',
      input.requestId,
      'create',
      async () => ({
        conversation: await this.deps.repository.createOrReuseEmpty(projectId, input.defaultModelId),
      }),
    )
  }

  patch(
    projectId: string,
    conversationId: string,
    input: { requestId: string; patch: ConversationPatch },
  ): Promise<{ meta: PromptChatMetaV2 }> {
    assertRequestId(input.requestId)
    if (input.patch.selectedModelId !== undefined) textModel(input.patch.selectedModelId)
    return this.deps.repository.withIdempotency(
      projectId,
      conversationId,
      input.requestId,
      'patch',
      async () => ({
        meta: await this.deps.repository.patchMeta(projectId, conversationId, input.patch),
      }),
    )
  }

  activate(
    projectId: string,
    conversationId: string,
    requestId: string,
  ): Promise<{ meta: PromptChatMetaV2 }> {
    assertRequestId(requestId)
    return this.deps.repository.withIdempotency(
      projectId,
      conversationId,
      requestId,
      'activate',
      async () => ({
        meta: await this.deps.repository.activate(projectId, conversationId),
      }),
    )
  }

  recordUserMessage(
    projectId: string,
    conversationId: string,
    input: RecordUserMessageInput,
  ): Promise<RecordUserMessageResult> {
    assertRequestId(input.requestId)
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 12_000) {
      throw new PromptChatCommandError('Message must contain from 1 to 12 000 characters', 'PROMPT_CHAT_INVALID')
    }
    validateAttachments(input.attachments)

    return this.deps.repository.withIdempotency(
      projectId,
      conversationId,
      input.requestId,
      'record',
      async () => {
        const meta = await this.deps.repository.loadMeta(projectId, conversationId)
        const firstTurn = (await this.deps.repository.loadAll(projectId, conversationId)).length === 0
        const userMessage: PromptChatMessageV2 = {
          id: this.deps.id(),
          role: 'user',
          text: input.text.trim(),
          createdAt: this.deps.now(),
          attachments: structuredClone(input.attachments),
        }
        await this.deps.repository.appendMessages(projectId, conversationId, [userMessage])
        const durableMeta = await this.deps.repository.patchMeta(projectId, conversationId, {
          draft: {
            text: '',
            attachments: [],
            selectionStart: 0,
            selectionEnd: 0,
          },
          ...(firstTurn && (meta.title === 'New chat' || meta.title === 'Новый диалог')
            ? { title: userMessage.text.replace(/\s+/g, ' ').slice(0, 60) }
            : {}),
        })
        return { userMessage, meta: durableMeta }
      },
    )
  }

  appendHistoryMessages(
    projectId: string,
    conversationId: string,
    input: AppendHistoryMessagesInput,
  ): Promise<AppendHistoryMessagesResult> {
    assertRequestId(input.requestId)
    validateHistoryMessages(input.messages)
    return this.deps.repository.withIdempotency(
      projectId,
      conversationId,
      input.requestId,
      'append-history',
      async () => {
        const now = this.deps.now()
        const messages: PromptChatMessageV2[] = input.messages.map((message, index) => ({
          id: this.deps.id(),
          role: message.role,
          text: message.text,
          createdAt: now + index,
          ...(message.role === 'assistant' ? { reply: message.reply!.trim() } : {}),
        }))
        await this.deps.repository.appendMessages(projectId, conversationId, messages)
        return {
          messages,
          meta: await this.deps.repository.loadMeta(projectId, conversationId),
        }
      },
    )
  }

  beginTurn(
    projectId: string,
    conversationId: string,
    input: BeginTurnInput,
  ): Promise<BeginTurnResult> {
    assertRequestId(input.requestId)
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 12_000) {
      throw new PromptChatCommandError('Message must contain from 1 to 12 000 characters', 'PROMPT_CHAT_INVALID')
    }
    validateAttachments(input.attachments)
    if (
      input.confirmedCostUsd !== undefined
      && (!Number.isFinite(input.confirmedCostUsd) || input.confirmedCostUsd < 0)
    ) throw new PromptChatCommandError('Invalid price confirmation', 'PROMPT_CHAT_INVALID')
    if (input.boardMemoryEnabled !== undefined && typeof input.boardMemoryEnabled !== 'boolean') {
      throw new PromptChatCommandError('Invalid boardMemoryEnabled value', 'PROMPT_CHAT_INVALID')
    }

    return this.deps.repository.withIdempotency(
      projectId,
      conversationId,
      input.requestId,
      'send',
      async () => {
        const meta = await this.deps.repository.loadMeta(projectId, conversationId)
        const existingMessages = await this.deps.repository.loadAll(projectId, conversationId)
        const recoveredAssistant = existingMessages.find((message) => (
          message.role === 'assistant'
          && message.requestId === input.requestId
          && typeof message.jobId === 'string'
          && typeof message.requestMessageId === 'string'
          && meta.activeJobIds.includes(message.jobId)
        ))
        if (recoveredAssistant && typeof recoveredAssistant.jobId === 'string') {
          const recoveredUser = existingMessages.find((message) => (
            message.id === recoveredAssistant.requestMessageId
          ))
          if (recoveredUser) {
            return {
              revision: meta.revision,
              jobId: recoveredAssistant.jobId,
              userMessage: recoveredUser,
              assistantMessage: recoveredAssistant,
              modelId: typeof recoveredAssistant.modelId === 'string'
                ? recoveredAssistant.modelId
                : meta.selectedModelId,
            }
          }
        }
        if (meta.activeJobIds.length > 0) {
          throw new PromptChatCommandError(
            'Wait for or stop the current response',
            'PROMPT_CHAT_ACTIVE_RESPONSE',
          )
        }
        textModel(meta.selectedModelId)
        const boardMemoryEnabled = input.boardMemoryEnabled
          ?? await this.deps.getBoardMemoryEnabled?.(projectId)
          ?? true
        const estimate = {
          ...(await this.deps.estimateTurn(
            projectId,
            conversationId,
            meta.selectedModelId,
            input.text,
            input.attachments,
          boardMemoryEnabled,
          )),
          boardMemoryEnabled,
        }
        const threshold = await this.deps.getConfirmCostAboveUsd()
        if (
          estimate.costUsd !== null
          && estimate.costUsd > 0
          && estimate.costUsd >= threshold
          && (input.confirmedCostUsd === undefined || input.confirmedCostUsd + 1e-9 < estimate.costUsd)
        ) {
          throw new PromptChatCommandError(
            'Confirm the response cost',
            'PROMPT_CHAT_COST_CONFIRM_REQUIRED',
            { ...estimate, requiresConfirmation: true },
          )
        }

        const now = this.deps.now()
        const firstTurn = existingMessages.length === 0
        const userMessage: PromptChatMessageV2 = {
          id: this.deps.id(),
          role: 'user',
          text: input.text.trim(),
          createdAt: now,
          attachments: structuredClone(input.attachments),
          boardMemoryEnabled,
        }
        const jobId = this.deps.id()
        const assistantMessage: PromptChatMessageV2 = {
          id: this.deps.id(),
          role: 'assistant',
          text: '',
          createdAt: now + 1,
          status: 'queued',
          jobId,
          requestMessageId: userMessage.id,
          requestId: input.requestId,
          modelId: meta.selectedModelId,
          boardMemoryEnabled,
        }
        await this.deps.repository.appendMessages(
          projectId,
          conversationId,
          [userMessage, assistantMessage],
        )
        const durableMeta = await this.deps.repository.patchMeta(
          projectId,
          conversationId,
          {
            activeJobIds: [jobId],
            draft: {
              text: '',
              attachments: [],
              selectionStart: 0,
              selectionEnd: 0,
            },
            ...(firstTurn && (meta.title === 'New chat' || meta.title === 'Новый диалог')
              ? { title: input.text.trim().replace(/\s+/g, ' ').slice(0, 60) }
              : {}),
          },
        )
        try {
          await this.deps.createJob({
            id: jobId,
            kind: 'prompt-chat',
            prompt: userMessage.text,
            projectId,
            conversationId,
            requestMessageId: userMessage.id,
            responseMessageId: assistantMessage.id,
            requestId: input.requestId,
            modelId: meta.selectedModelId,
            boardMemoryEnabled,
          })
        } catch (error) {
          await this.deps.repository.replaceMessage(projectId, conversationId, {
            ...assistantMessage,
            status: 'error',
            error: 'Could not create the job. Try sending again.',
          })
          await this.deps.repository.patchMeta(projectId, conversationId, { activeJobIds: [] })
          if (
            error instanceof PromptChatCommandError
            && error.code === 'PROMPT_CHAT_SHUTTING_DOWN'
          ) {
            throw error
          }
          throw new PromptChatCommandError(
            'Could not create the Assistant job',
            'PROMPT_CHAT_JOB_CREATE_FAILED',
          )
        }
        return {
          revision: durableMeta.revision,
          jobId,
          userMessage,
          assistantMessage,
          modelId: meta.selectedModelId,
        }
      },
    )
  }

  trash(projectId: string, conversationId: string, requestId: string): Promise<{ ok: true }> {
    assertRequestId(requestId)
    return this.deps.repository.withIdempotency(
      projectId,
      conversationId,
      requestId,
      'trash',
      async () => {
        const meta = await this.deps.repository.loadMeta(projectId, conversationId)
        if (meta.activeJobIds.length > 0) {
          throw new PromptChatCommandError(
            'Stop the response before deleting the chat',
            'PROMPT_CHAT_ACTIVE_RESPONSE',
          )
        }
        await this.deps.repository.moveToTrash(projectId, conversationId)
        return { ok: true as const }
      },
    )
  }

  restore(
    projectId: string,
    conversationId: string,
    requestId: string,
  ): Promise<{ conversation: PromptChatMetaV2 }> {
    assertRequestId(requestId)
    return this.deps.repository.withIdempotency(
      projectId,
      conversationId,
      requestId,
      'restore',
      async () => {
        await this.deps.repository.restore(projectId, conversationId)
        return { conversation: await this.deps.repository.loadMeta(projectId, conversationId) }
      },
    )
  }

  permanentDelete(
    projectId: string,
    conversationId: string,
    requestId: string,
  ): Promise<{ ok: true }> {
    assertRequestId(requestId)
    return this.deps.repository.withIdempotency(
      projectId,
      conversationId,
      requestId,
      'permanent-delete',
      async () => {
        await this.deps.repository.permanentDelete(projectId, conversationId)
        return { ok: true as const }
      },
    )
  }
}

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { CATALOG } from './catalog.js'
import { config } from './config.js'
import {
  buildPromptChatContext,
  estimateChatRequestCost,
  estimateChatTokens,
} from './promptChatContext.js'
import {
  applyCompactionCheckpoint,
  buildCompactionPrompt,
  parseCompactionResponse,
  shouldCompact,
} from './promptChatCompaction.js'
import { loadBoardMemoryForProject, formatBoardMemoryForContext } from './boardMemory.js'
import { parsePromptChatResponse } from './promptChatResponse.js'
import { PromptChatRepository } from './promptChatStorage.js'
import { readAssistantRules } from '../../packages/assistant-rules/readRules.js'
import type { Job, JobTarget } from './jobs.js'
import type { IncomingRef } from './refs.js'
import type {
  PromptChatAttachment,
  PromptChatEstimate,
  PromptChatMessageV2,
} from './promptChatTypes.js'

export function promptChatInstructions(): string {
  return readAssistantRules()
}

const defaultRootDir = path.join(path.dirname(config.projectFile), 'prompt-chats')
export const promptChatRepository = new PromptChatRepository({
  rootDir: defaultRootDir,
  now: Date.now,
  id: randomUUID,
})

function requireChatTarget(job: Job): Extract<JobTarget, { kind: 'prompt-chat' }> {
  if (job.target?.kind !== 'prompt-chat') throw new Error('prompt-chat: job has no target chat')
  return job.target
}

function requireCompactionTarget(job: Job): Extract<JobTarget, { kind: 'prompt-chat-compaction' }> {
  if (job.target?.kind !== 'prompt-chat-compaction') {
    throw new Error('prompt-chat: job has no target compaction')
  }
  return job.target
}

function attachmentRefs(attachments: PromptChatAttachment[]): IncomingRef[] {
  return attachments.flatMap((attachment): IncomingRef[] => {
    if (attachment.kind === 'text' && attachment.text?.trim()) {
      return [{ kind: 'text', text: attachment.text.trim() }]
    }
    if ((attachment.kind === 'image' || attachment.kind === 'video') && attachment.src) {
      return [{
        kind: attachment.kind,
        src: attachment.src,
        ...(attachment.width !== undefined ? { width: attachment.width } : {}),
        ...(attachment.height !== undefined ? { height: attachment.height } : {}),
      }]
    }
    return []
  })
}

function textModel(modelId: string) {
  const model = CATALOG.find((item) => item.id === modelId && item.kind === 'text')
  if (!model) throw new Error('prompt-chat: text model not found')
  return model
}

export async function preparePromptChatJob(
  repository: PromptChatRepository,
  job: Job,
  boardMemoryLoader: typeof loadBoardMemoryForProject = loadBoardMemoryForProject,
): Promise<{ prompt: string; refs: IncomingRef[]; estimatedInputTokens: number }> {
  const target = requireChatTarget(job)
  const [messages, context, boardMemory] = await Promise.all([
    repository.loadAll(target.projectId, target.conversationId),
    repository.loadContext(target.projectId, target.conversationId),
    target.boardMemoryEnabled === false
      ? Promise.resolve(null)
      : boardMemoryLoader(target.projectId).catch(() => null),
  ])
  const requestIndex = messages.findIndex((message) => message.id === target.requestMessageId)
  if (requestIndex < 0) throw new Error('prompt-chat: original message not found')
  const request = messages[requestIndex]
  if (request.role !== 'user') throw new Error('prompt-chat: original message has invalid role')
  const model = textModel(job.model ?? '')
  const boardMemoryText = boardMemory ? formatBoardMemoryForContext(boardMemory) : undefined
  const built = buildPromptChatContext({
    messages,
    checkpoint: context,
    throughMessageId: request.id,
    model,
    boardMemory: boardMemoryText,
  })
  const prompt = `${promptChatInstructions()}\n\n${built.prompt}`
  return {
    prompt,
    refs: attachmentRefs(request.attachments ?? []),
    estimatedInputTokens: estimateChatTokens(prompt),
  }
}

export async function estimatePromptChatTurn(
  repository: PromptChatRepository,
  projectId: string,
  conversationId: string,
  modelId: string,
  text: string,
  attachments: PromptChatAttachment[],
  boardMemoryEnabled = true,
  boardMemoryLoader: typeof loadBoardMemoryForProject = loadBoardMemoryForProject,
): Promise<PromptChatEstimate> {
  const [messages, context, boardMemory] = await Promise.all([
    repository.loadAll(projectId, conversationId),
    repository.loadContext(projectId, conversationId),
    boardMemoryEnabled === false
      ? Promise.resolve(null)
      : boardMemoryLoader(projectId).catch(() => null),
  ])
  const current: PromptChatMessageV2 = {
    id: 'estimate-current',
    role: 'user',
    text,
    createdAt: Date.now(),
    attachments: structuredClone(attachments),
  }
  const model = textModel(modelId)
  const boardMemoryText = boardMemory ? formatBoardMemoryForContext(boardMemory) : undefined
  const built = buildPromptChatContext({
    messages: [...messages, current],
    checkpoint: context,
    throughMessageId: current.id,
    model,
    boardMemory: boardMemoryText,
  })
  const inputTokens = estimateChatTokens(`${promptChatInstructions()}\n\n${built.prompt}`)
  return {
    modelId,
    inputTokens,
    outputTokens: 1_000,
    costUsd: estimateChatRequestCost(model, inputTokens, 1_000),
    requiresConfirmation: false,
    contextHealth: built.contextHealth,
    boardMemoryEnabled,
  }
}


export async function finalizePromptChatJob(
  repository: PromptChatRepository,
  job: Job,
): Promise<void> {
  const target = requireChatTarget(job)
  const [responseMessage, requestMessage, meta] = await Promise.all([
    repository.findMessage(target.projectId, target.conversationId, target.responseMessageId),
    repository.findMessage(target.projectId, target.conversationId, target.requestMessageId),
    repository.loadMeta(target.projectId, target.conversationId),
  ])
  if (!responseMessage) throw new Error('prompt-chat: expected response was not found')
  if (!requestMessage) throw new Error('prompt-chat: original message not found')

  let replacement: PromptChatMessageV2
  if (job.status === 'done' && typeof job.result?.text === 'string') {
    const parsed = parsePromptChatResponse(job.result.text, (requestMessage.attachments?.length ?? 0) > 0)
    replacement = {
      ...responseMessage,
      status: 'done',
      error: undefined,
      reply: parsed.reply,
      prompts: parsed.prompts,
      referenceNotes: parsed.referenceNotes,
      modelId: job.model ?? responseMessage.modelId ?? null,
    }
  } else {
    replacement = {
      ...responseMessage,
      status: job.cancelled || job.error === 'Cancelled' || job.error === 'отменено' ? 'cancelled' : 'error',
      error: job.error || 'Response not received',
    }
  }
  await repository.replaceMessage(target.projectId, target.conversationId, replacement)
  if (meta.activeJobIds.includes(job.id)) {
    await repository.patchMeta(target.projectId, target.conversationId, {
      activeJobIds: meta.activeJobIds.filter((id) => id !== job.id),
    })
  }
}

export async function prepareCompactionJob(
  repository: PromptChatRepository,
  job: Job,
): Promise<{ prompt: string; refs: IncomingRef[]; estimatedInputTokens: number }> {
  const target = requireCompactionTarget(job)
  const [messages, context] = await Promise.all([
    repository.loadAll(target.projectId, target.conversationId),
    repository.loadContext(target.projectId, target.conversationId),
  ])
  const throughIndex = messages.findIndex((message) => message.id === target.throughMessageId)
  if (throughIndex < 0) throw new Error('prompt-chat: boundary compaction not found')
  let fromIndex = 0
  if (target.fromMessageId) {
    fromIndex = messages.findIndex((message) => message.id === target.fromMessageId)
    if (fromIndex < 0 || fromIndex > throughIndex) throw new Error('prompt-chat: invalid range compaction')
  } else if (context.summaryThroughMessageId) {
    const summaryIndex = messages.findIndex((message) => message.id === context.summaryThroughMessageId)
    if (summaryIndex >= 0) fromIndex = summaryIndex + 1
  }
  const prompt = buildCompactionPrompt(context.summary, messages.slice(fromIndex, throughIndex + 1))
  return { prompt, refs: [], estimatedInputTokens: estimateChatTokens(prompt) }
}

export async function finalizeCompactionJob(
  repository: PromptChatRepository,
  job: Job,
): Promise<void> {
  const target = requireCompactionTarget(job)
  if (job.status === 'done' && typeof job.result?.text === 'string') {
    await applyCompactionCheckpoint(repository, {
      projectId: target.projectId,
      conversationId: target.conversationId,
      fromMessageId: target.fromMessageId,
      throughMessageId: target.throughMessageId,
      expectedContextRevision: target.contextRevision,
      createdAt: job.finishedAt ?? Date.now(),
      modelId: job.model ?? 'qwen',
    }, parseCompactionResponse(job.result.text))
    return
  }

  const context = await repository.loadContext(target.projectId, target.conversationId)
  if (context.revision !== target.contextRevision) return
  await repository.replaceContext(
    target.projectId,
    target.conversationId,
    context.revision,
    {
      ...context,
      revision: context.revision + 1,
      compaction: {
        status: 'error',
        error: job.error || 'Could not refresh memory',
      },
    },
  )
}

export interface CompactionJobDescriptor {
  id: string
  prompt: string
  model: 'qwen'
  target: Extract<JobTarget, { kind: 'prompt-chat-compaction' }>
  internal: true
}

export async function schedulePromptChatCompaction(
  repository: PromptChatRepository,
  sourceJob: Job,
  options: {
    confirmCostAboveUsd: number
    reserveId: () => string
    createJob: (descriptor: CompactionJobDescriptor) => Promise<void>
    force?: boolean
  },
): Promise<'skipped' | 'confirmation-required' | 'queued'> {
  const sourceTarget = requireChatTarget(sourceJob)
  const [messages, context] = await Promise.all([
    repository.loadAll(sourceTarget.projectId, sourceTarget.conversationId),
    repository.loadContext(sourceTarget.projectId, sourceTarget.conversationId),
  ])
  if (context.compaction.status === 'queued' || context.compaction.status === 'running') return 'skipped'
  if (!options.force && context.compaction.status !== 'idle') return 'skipped'
  const summaryIndex = context.summaryThroughMessageId
    ? messages.findIndex((message) => message.id === context.summaryThroughMessageId)
    : -1
  const completed = messages.slice(Math.max(0, summaryIndex + 1)).filter((message) => (
    message.role === 'user' || (message.role === 'assistant' && message.status === 'done')
  ))
  const prompt = buildCompactionPrompt(context.summary, completed)
  const recentTokens = estimateChatTokens(prompt)
  if (!options.force && !shouldCompact({
    completedSinceCheckpoint: completed.length,
    recentTokens,
  })) return 'skipped'
  const qwen = textModel('qwen')
  const estimatedCostUsd = estimateChatRequestCost(qwen, recentTokens, 1_000) ?? 0
  if (
    estimatedCostUsd > 0
    && estimatedCostUsd >= options.confirmCostAboveUsd
    && !options.force
  ) {
    await repository.replaceContext(
      sourceTarget.projectId,
      sourceTarget.conversationId,
      context.revision,
      {
        ...context,
        revision: context.revision + 1,
        compaction: {
          status: 'confirmation-required',
          estimatedCostUsd,
        },
      },
    )
    return 'confirmation-required'
  }

  const first = completed[0]
  const last = completed.at(-1)
  if (!first || !last) return 'skipped'
  const id = options.reserveId()
  const target: Extract<JobTarget, { kind: 'prompt-chat-compaction' }> = {
    kind: 'prompt-chat-compaction',
    projectId: sourceTarget.projectId,
    conversationId: sourceTarget.conversationId,
    fromMessageId: first.id,
    throughMessageId: last.id,
    contextRevision: context.revision + 1,
  }
  await repository.replaceContext(
    sourceTarget.projectId,
    sourceTarget.conversationId,
    context.revision,
    {
      ...context,
      revision: context.revision + 1,
      compaction: {
        status: 'queued',
        jobId: id,
        estimatedCostUsd,
      },
    },
  )
  try {
    await options.createJob({
      id,
      prompt: 'Updating chat memory',
      model: 'qwen',
      target,
      internal: true,
    })
  } catch (error) {
    const queued = await repository.loadContext(sourceTarget.projectId, sourceTarget.conversationId)
    if (queued.revision === target.contextRevision) {
      await repository.replaceContext(
        sourceTarget.projectId,
        sourceTarget.conversationId,
        queued.revision,
        {
          ...queued,
          revision: queued.revision + 1,
          compaction: { status: 'error', error: 'Could not create the memory job' },
        },
      )
    }
    throw error
  }
  return 'queued'
}

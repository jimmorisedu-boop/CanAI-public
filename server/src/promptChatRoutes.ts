import { randomUUID } from 'node:crypto'
import { logError } from './log.js'
import express, { Router } from 'express'
import { CATALOG } from './catalog.js'
import { PromptChatCommandError, PromptChatCommands } from './promptChatCommands.js'
import {
  estimatePromptChatTurn,
  promptChatRepository,
  schedulePromptChatCompaction,
} from './promptChatDelivery.js'
import { ensurePromptChatV2 } from './promptChatMigration.js'
import { generationGate, GenerationShuttingDownError } from './generationGate.js'
import { jobs, JobLimitError, MAX_LIVE_JOBS, type Job } from './jobs.js'
import { loadProjectSnapshot } from './projects.js'
import { enqueueCompactionJob, persistAndEnqueueJob } from './runner.js'
import { loadSettings } from './settings.js'
import { activeAssistantContext } from './assistants.js'
import { catalogLibrary } from './catalogLibrary.js'
import { AssistantRulesError } from '../../packages/assistant-rules/readRules.js'
import type { AppendHistoryMessagesInput, PromptChatAttachment } from './promptChatTypes.js'
import {
  generationUnavailableMessage,
  generationAvailable,
} from './generationAvailability.js'

export const promptChatRouter = Router()

function reqProjectId(req: express.Request): string | null {
  const raw = req.query.project
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

async function requireProject(req: express.Request, res: express.Response): Promise<string | null> {
  const projectId = reqProjectId(req)
  if (!projectId) {
    res.status(400).json({ error: 'Missing board', code: 'PROMPT_CHAT_INVALID' })
    return null
  }
  // Битый project.json холст переживает (баннер «Доска не загрузилась… пустой
  // холст не будет сохранён поверх данных»), а эта ручка роняла необработанное
  // отклонение прямо из JSON.parse: процесс спасал глобальный перехватчик, но
  // человек получал невнятный ответ (найдено прогоном 20.08.2026).
  let known: unknown
  try {
    known = await loadProjectSnapshot(projectId)
  } catch (error) {
    logError('prompt-chat', error)
    res.status(500).json({ error: 'Board file cannot be read; restore it from the backup copy', code: 'PROMPT_CHAT_BROKEN' })
    return null
  }
  if (!known) {
    res.status(404).json({ error: 'Board not found', code: 'PROMPT_CHAT_NOT_FOUND' })
    return null
  }
  return projectId
}

async function defaultModelId(): Promise<string> {
  // Включённый помощник главнее общей настройки: «включил — подключилась
  // его модель» это и есть смысл переключателя.
  const active = await activeAssistantContext()
  if (active) return active.modelId
  const catalogDefault = catalogLibrary.defaultModelId('assistant')
  if (catalogDefault) return catalogDefault
  const settings = await loadSettings()
  return CATALOG.some((model) => model.id === settings.assistantModelId && model.kind === 'text')
    ? settings.assistantModelId
    : 'gemini'
}

async function ensureProjectChats(projectId: string): Promise<void> {
  await ensurePromptChatV2(projectId, await defaultModelId(), {
    repository: promptChatRepository,
  })
}

const commands = new PromptChatCommands({
  repository: promptChatRepository,
  now: Date.now,
  id: randomUUID,
  estimateTurn: (projectId, conversationId, modelId, text, attachments, boardMemoryEnabled) => (
    estimatePromptChatTurn(
      promptChatRepository,
      projectId,
      conversationId,
      modelId,
      text,
      attachments,
      boardMemoryEnabled,
    )
  ),
  getBoardMemoryEnabled: (projectId) => promptChatRepository.getBoardMemoryEnabled(projectId),
  getConfirmCostAboveUsd: async () => (await loadSettings()).confirmCostAboveUsd,
  createJob: async (descriptor) => {
    const active = await activeAssistantContext().catch(() => null)
    let job
    try {
      job = jobs.create(
      'text',
      descriptor.prompt,
      [],
      active?.modelId ?? descriptor.modelId,
      {
        max_tokens: 4096,
        ...(active?.systemPrompt ? { system_prompt: active.systemPrompt } : {}),
      },
      {
        kind: 'prompt-chat',
        projectId: descriptor.projectId,
        conversationId: descriptor.conversationId,
        requestMessageId: descriptor.requestMessageId,
        responseMessageId: descriptor.responseMessageId,
        requestId: descriptor.requestId,
        boardMemoryEnabled: descriptor.boardMemoryEnabled,
      },
      false,
      descriptor.id,
    )
    } catch (error) {
      if (error instanceof JobLimitError) {
        throw new PromptChatCommandError(error.message, 'PROMPT_CHAT_JOB_LIMIT')
      }
      throw error
    }
    try {
      await persistAndEnqueueJob(job)
    } catch (error) {
      if (error instanceof GenerationShuttingDownError) {
        throw new PromptChatCommandError(
          error.message,
          'PROMPT_CHAT_SHUTTING_DOWN',
        )
      }
      throw error
    }
  },
})

function sendError(res: express.Response, error: unknown): void {
  if (error instanceof AssistantRulesError) {
    res.status(503).json({ error: error.message, code: error.code })
    return
  }
  if (error instanceof GenerationShuttingDownError) {
    res.status(503).json({
      error: error.message,
      code: 'PROMPT_CHAT_SHUTTING_DOWN',
    })
    return
  }
  if (error instanceof PromptChatCommandError) {
    const status = error.code === 'PROMPT_CHAT_ACTIVE_RESPONSE'
      || error.code === 'PROMPT_CHAT_COST_CONFIRM_REQUIRED'
      ? 409
      : error.code === 'PROMPT_CHAT_SHUTTING_DOWN'
        ? 503
      : error.code === 'PROMPT_CHAT_JOB_LIMIT'
        ? 429
        : error.code === 'PROMPT_CHAT_MODEL_NOT_FOUND'
          ? 400
          : error.code === 'PROMPT_CHAT_INVALID'
            ? 400
            : 500
    res.status(status).json({
      error: error.message,
      code: error.code,
      ...(error.estimate ? { estimate: error.estimate } : {}),
    })
    return
  }
  const message = error instanceof Error ? error.message : ''
  if (/не найден|отсутствует|not found|missing|does not exist/i.test(message)) {
    res.status(404).json({ error: 'Chat not found', code: 'PROMPT_CHAT_NOT_FOUND' })
    return
  }
  if (/неверн|запрещ|не больше|долж|invalid|forbidden|must|cannot|no more|requires|expected/i.test(message.toLocaleLowerCase('ru-RU'))) {
    res.status(400).json({ error: message || 'Invalid data', code: 'PROMPT_CHAT_INVALID' })
    return
  }
  res.status(500).json({ error: 'Could not complete the chat operation' })
}

promptChatRouter.get('/prompt-chats', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  try {
    await ensureProjectChats(projectId)
    res.json({ index: await promptChatRepository.list(projectId), boardMemoryControlSupported: true })
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.patch('/prompt-chats/preferences', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  const { boardMemoryEnabled } = (req.body ?? {}) as { boardMemoryEnabled?: unknown }
  if (typeof boardMemoryEnabled !== 'boolean') {
    return res.status(400).json({ error: 'boardMemoryEnabled must be boolean', code: 'PROMPT_CHAT_INVALID' })
  }
  try {
    await ensureProjectChats(projectId)
    const index = await promptChatRepository.setBoardMemoryEnabled(projectId, boardMemoryEnabled)
    res.json({ index, boardMemoryControlSupported: true })
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.post('/prompt-chats', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  const { requestId } = (req.body ?? {}) as { requestId?: unknown }
  if (typeof requestId !== 'string') return res.status(400).json({ error: 'requestId is required' })
  try {
    await ensureProjectChats(projectId)
    res.json(await commands.create(projectId, { requestId, defaultModelId: await defaultModelId() }))
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.get('/prompt-chats/trash', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  try {
    await ensureProjectChats(projectId)
    res.json({ conversations: await promptChatRepository.listTrash(projectId) })
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.get('/prompt-chats/:conversationId', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  const before = typeof req.query.before === 'string' ? req.query.before : undefined
  const parsedLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
    return res.status(400).json({ error: 'limit must be between 1 and 50' })
  }
  try {
    await ensureProjectChats(projectId)
    res.json(await promptChatRepository.loadPage(projectId, req.params.conversationId, {
      ...(before ? { before } : {}),
      limit: parsedLimit as 50,
    }))
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.patch('/prompt-chats/:conversationId', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  const { requestId, title, selectedModelId, draft } = (req.body ?? {}) as {
    requestId?: unknown
    title?: unknown
    selectedModelId?: unknown
    draft?: unknown
  }
  if (typeof requestId !== 'string') return res.status(400).json({ error: 'requestId is required' })
  const patch = {
    ...(title !== undefined ? { title: title as string } : {}),
    ...(selectedModelId !== undefined ? { selectedModelId: selectedModelId as string } : {}),
    ...(draft !== undefined ? { draft: draft as never } : {}),
  }
  try {
    await ensureProjectChats(projectId)
    res.json(await commands.patch(projectId, req.params.conversationId, { requestId, patch }))
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.post('/prompt-chats/:conversationId/activate', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  const { requestId } = (req.body ?? {}) as { requestId?: unknown }
  if (typeof requestId !== 'string') return res.status(400).json({ error: 'requestId is required' })
  try {
    await ensureProjectChats(projectId)
    res.json(await commands.activate(projectId, req.params.conversationId, requestId))
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.post('/prompt-chats/:conversationId/estimate', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  const { text, attachments, boardMemoryEnabled } = (req.body ?? {}) as {
    text?: unknown
    attachments?: unknown
    boardMemoryEnabled?: unknown
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 12_000 || !Array.isArray(attachments)) {
    return res.status(400).json({ error: 'Invalid message or references' })
  }
  if (boardMemoryEnabled !== undefined && typeof boardMemoryEnabled !== 'boolean') {
    return res.status(400).json({ error: 'boardMemoryEnabled must be boolean', code: 'PROMPT_CHAT_INVALID' })
  }
  try {
    await ensureProjectChats(projectId)
    const meta = await promptChatRepository.loadMeta(projectId, req.params.conversationId)
    const resolvedBoardMemoryEnabled = boardMemoryEnabled === undefined
      ? await promptChatRepository.getBoardMemoryEnabled(projectId)
      : boardMemoryEnabled
    const estimate = await estimatePromptChatTurn(
      promptChatRepository,
      projectId,
      req.params.conversationId,
      meta.selectedModelId,
      text,
      attachments as PromptChatAttachment[],
      resolvedBoardMemoryEnabled,
    )
    const threshold = (await loadSettings()).confirmCostAboveUsd
    res.json({
      ...estimate,
      requiresConfirmation: estimate.costUsd !== null
        && estimate.costUsd > 0
        && estimate.costUsd >= threshold,
    })
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.post('/prompt-chats/:conversationId/messages', async (req, res) => {
  if (generationGate.shuttingDown) {
    return res.status(503).json({
      error: 'CanAI is shutting down — try again after restart',
      code: 'PROMPT_CHAT_SHUTTING_DOWN',
    })
  }
  const projectId = await requireProject(req, res)
  if (!projectId) return
  if (!generationAvailable()) {
    return res.status(503).json({
      error: generationUnavailableMessage(),
      code: 'PROMPT_CHAT_GENERATION_UNAVAILABLE',
    })
  }
  if (jobs.liveCount() >= MAX_LIVE_JOBS) {
    return res.status(429).json({
      error: 'Too many active generations — wait for the current ones to finish',
      code: 'PROMPT_CHAT_JOB_LIMIT',
    })
  }
  const { requestId, text, attachments, confirmedCostUsd, boardMemoryEnabled } = (req.body ?? {}) as {
    requestId?: unknown
    text?: unknown
    attachments?: unknown
    confirmedCostUsd?: unknown
    boardMemoryEnabled?: unknown
  }
  if (typeof requestId !== 'string' || typeof text !== 'string' || !Array.isArray(attachments)) {
    return res.status(400).json({ error: 'Invalid message' })
  }
  if (boardMemoryEnabled !== undefined && typeof boardMemoryEnabled !== 'boolean') {
    return res.status(400).json({ error: 'boardMemoryEnabled must be boolean', code: 'PROMPT_CHAT_INVALID' })
  }
  try {
    await ensureProjectChats(projectId)
    res.json(await commands.beginTurn(projectId, req.params.conversationId, {
      requestId,
      text,
      attachments: attachments as PromptChatAttachment[],
      ...(typeof confirmedCostUsd === 'number' ? { confirmedCostUsd } : {}),
      ...(boardMemoryEnabled !== undefined ? { boardMemoryEnabled } : {}),
    }))
  } catch (error) {
    sendError(res, error)
  }
})

// Сценарий использует сообщение как вход для графа, но не должен отправлять
// его в LLM отдельно. Всё равно фиксируем этот вход в истории диалога.
promptChatRouter.post('/prompt-chats/:conversationId/history', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  const { requestId, text, attachments } = (req.body ?? {}) as {
    requestId?: unknown
    text?: unknown
    attachments?: unknown
  }
  if (typeof requestId !== 'string' || typeof text !== 'string' || !Array.isArray(attachments)) {
    return res.status(400).json({ error: 'Invalid message' })
  }
  try {
    await ensureProjectChats(projectId)
    res.json(await commands.recordUserMessage(projectId, req.params.conversationId, {
      requestId,
      text,
      attachments: attachments as PromptChatAttachment[],
    }))
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.post('/prompt-chats/:conversationId/history/events', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  const { requestId, messages } = (req.body ?? {}) as {
    requestId?: unknown
    messages?: unknown
  }
  if (typeof requestId !== 'string' || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid workflow events' })
  }
  try {
    await ensureProjectChats(projectId)
    res.json(await commands.appendHistoryMessages(projectId, req.params.conversationId, {
      requestId,
      messages: messages as AppendHistoryMessagesInput['messages'],
    }))
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.delete('/prompt-chats/:conversationId', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  const { requestId } = (req.body ?? {}) as { requestId?: unknown }
  if (typeof requestId !== 'string') return res.status(400).json({ error: 'requestId is required' })
  try {
    await ensureProjectChats(projectId)
    res.json(await commands.trash(projectId, req.params.conversationId, requestId))
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.post('/prompt-chats/:conversationId/restore', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  const { requestId } = (req.body ?? {}) as { requestId?: unknown }
  if (typeof requestId !== 'string') return res.status(400).json({ error: 'requestId is required' })
  try {
    await ensureProjectChats(projectId)
    res.json(await commands.restore(projectId, req.params.conversationId, requestId))
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.delete('/prompt-chats/:conversationId/permanent', async (req, res) => {
  const projectId = await requireProject(req, res)
  if (!projectId) return
  const { requestId } = (req.body ?? {}) as { requestId?: unknown }
  if (typeof requestId !== 'string') return res.status(400).json({ error: 'requestId is required' })
  try {
    await ensureProjectChats(projectId)
    res.json(await commands.permanentDelete(projectId, req.params.conversationId, requestId))
  } catch (error) {
    sendError(res, error)
  }
})

promptChatRouter.post('/prompt-chats/:conversationId/context/rebuild', async (req, res) => {
  if (generationGate.shuttingDown) {
    return res.status(503).json({
      error: 'CanAI is shutting down — try again after restart',
      code: 'PROMPT_CHAT_SHUTTING_DOWN',
    })
  }
  const projectId = await requireProject(req, res)
  if (!projectId) return
  if (!generationAvailable()) {
    return res.status(503).json({
      error: generationUnavailableMessage(),
      code: 'PROMPT_CHAT_GENERATION_UNAVAILABLE',
    })
  }
  try {
    await ensureProjectChats(projectId)
    const sourceJob: Job = {
      id: randomUUID(),
      kind: 'text',
      prompt: 'Retry memory',
      refs: [],
      model: 'qwen',
      params: {},
      status: 'done',
      createdAt: Date.now(),
      target: {
        kind: 'prompt-chat',
        projectId,
        conversationId: req.params.conversationId,
        requestMessageId: 'manual',
        responseMessageId: 'manual',
        requestId: 'manual',
      },
    }
    const result = await schedulePromptChatCompaction(promptChatRepository, sourceJob, {
      confirmCostAboveUsd: (await loadSettings()).confirmCostAboveUsd,
      reserveId: randomUUID,
      createJob: enqueueCompactionJob,
      force: true,
    })
    res.json({ status: result })
  } catch (error) {
    sendError(res, error)
  }
})

// Старый singular API больше не пишет данные. Сам legacy-файл читается только
// мигратором при первом обращении к plural V2 API.
promptChatRouter.all('/prompt-chat', (_req, res) => {
  res.status(410).json({
    code: 'PROMPT_CHAT_V1_REMOVED',
    error: 'Update the CanAI client: the new chat format is required',
  })
})

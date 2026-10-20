import { PromptChatRepository } from './promptChatStorage.js'
import { fitMemory } from './promptChatMemoryFit.js'
import type {
  PromptChatCheckpoint,
  PromptChatMemory,
  PromptChatMessageV2,
} from './promptChatTypes.js'



export interface CompactionTarget {
  projectId: string
  conversationId: string
  fromMessageId: string | null
  throughMessageId: string
  expectedContextRevision: number
  createdAt: number
  modelId: string
}

export function shouldCompact(input: {
  completedSinceCheckpoint: number
  recentTokens: number
}): boolean {
  return input.completedSinceCheckpoint >= 20 || input.recentTokens > 12_000
}

function cleanFence(raw: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw.trim())
  return match ? match[1].trim() : raw.trim()
}

// ⚠️ Длина не проверяется вовсе: размер подгоняет fitMemory. Длинная строка —
// это не сломанный ответ, а повод подрезать (см. promptChatMemoryFit.ts).
function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`prompt-chat: ${field} must be string`)
  }
}

/**
 * ⚠️ Форму КОНТЕЙНЕРА проверяем строго, а негодную ЗАПИСЬ внутри — пропускаем.
 *
 * Разница принципиальная. «facts вместо массива пришёл строкой» — сломанный
 * ответ, из него ничего не собрать. А «в массиве среди строк попался объект» —
 * это одна плохая запись из двадцати, и хоронить из-за неё всю выжимку нельзя:
 * она оплачена, а доставка потом повторяется вечно и переживает перезапуски
 * (журнал тестировщика 20.09.2026 — сперва «должен быть строкой не длиннее
 * 200 символов», после починки размеров «должен быть строкой», и оба раза без
 * конца).
 */
function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`prompt-chat: ${field} must be array`)
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function validateMemory(value: unknown): PromptChatMemory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('prompt-chat: memory must be a JSON object')
  }
  const raw = value as Partial<PromptChatMemory>
  assertString(raw.goal, 'goal')
  if (typeof raw.chronology !== 'string') {
    throw new Error('prompt-chat: chronology must be string')
  }
  const facts = parseStringList(raw.facts, 'facts')
  const constraints = parseStringList(raw.constraints, 'constraints')
  const preferences = parseStringList(raw.preferences, 'preferences')
  const referenceNotes = parseStringList(raw.referenceNotes, 'referenceNotes')
  const openQuestions = parseStringList(raw.openQuestions, 'openQuestions')
  if (!Array.isArray(raw.decisions)) throw new Error('prompt-chat: decisions must be array')
  // Негодное решение пропускаем по той же причине, что и негодную строку.
  const decisions = raw.decisions
    .filter((decision): decision is { text: string; reason: string } => (
      Boolean(decision)
      && typeof decision === 'object'
      && typeof (decision as { text?: unknown }).text === 'string'
      && typeof (decision as { reason?: unknown }).reason === 'string'
    ))
    .map((decision) => ({ text: decision.text.trim(), reason: decision.reason.trim() }))
    .filter((decision) => decision.text)
  const memory: PromptChatMemory = {
    goal: raw.goal.trim(),
    facts,
    decisions,
    constraints,
    preferences,
    referenceNotes,
    openQuestions,
    chronology: raw.chronology.trim(),
  }
  // ⚠️ Всё, что про РАЗМЕР, решает подгонка: отменять доставку оплаченной
  // выжимки из-за лишних знаков нельзя (см. promptChatMemoryFit.ts).
  return fitMemory(memory)
}

export function parseCompactionResponse(rawResponse: string): PromptChatMemory {
  const raw = rawResponse.trim()
  if (raw.toLocaleLowerCase('ru-RU').includes('data:')) {
    throw new Error('prompt-chat: data: in memory forbidden')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(cleanFence(raw))
  } catch (error) {
    throw new Error('prompt-chat: compaction must return only JSON', { cause: error })
  }
  return validateMemory(parsed)
}

function messageText(message: PromptChatMessageV2): string {
  if (message.role === 'user') return message.text.trim()
  return [
    message.reply?.trim(),
    ...(message.prompts ?? []).map((item) => item.prompt.trim()),
  ].filter(Boolean).join('\n')
}

export function buildCompactionPrompt(
  previousMemory: PromptChatMemory | null,
  messages: PromptChatMessageV2[],
): string {
  const completed = messages
    .filter((message) => (
      message.role === 'user'
      || (message.role === 'assistant' && message.status === 'done')
    ))
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${messageText(message)}`)
    .filter((line) => !line.endsWith(': '))
  return [
    'Update the long-term memory for one chat.',
    'Return only JSON without Markdown or explanation, with these fields:',
    '{"goal":"","facts":[],"decisions":[{"text":"","reason":""}],"constraints":[],"preferences":[],"referenceNotes":[],"openQuestions":[],"chronology":""}',
    'Do not add guesses. Keep current facts and decisions; merge new information without duplicates.',
    'Keep each array entry at 200 characters or fewer; keep each array to 80 entries or fewer.',
    '',
    '[PREVIOUS MEMORY]',
    previousMemory ? JSON.stringify(previousMemory) : 'Not yet no.',
    '',
    '[NEW MESSAGES]',
    completed.join('\n') || 'No.',
  ].join('\n')
}

export async function applyCompactionCheckpoint(
  repo: PromptChatRepository,
  target: CompactionTarget,
  memoryInput: PromptChatMemory,
): Promise<void> {
  const memory = validateMemory(memoryInput)
  const [context, messages] = await Promise.all([
    repo.loadContext(target.projectId, target.conversationId),
    repo.loadAll(target.projectId, target.conversationId),
  ])
  const throughIndex = messages.findIndex((message) => message.id === target.throughMessageId)
  if (throughIndex < 0) throw new Error('prompt-chat: boundary compaction not found')
  if (target.fromMessageId !== null) {
    const fromIndex = messages.findIndex((message) => message.id === target.fromMessageId)
    if (fromIndex < 0 || fromIndex > throughIndex) {
      throw new Error('prompt-chat: invalid range compaction')
    }
  }

  const checkpoints = [...context.checkpoints]
  if (context.summary && context.summaryThroughMessageId) {
    const previous: PromptChatCheckpoint = {
      revision: context.revision,
      summary: context.summary,
      fromMessageId: context.summaryMeta?.fromMessageId ?? null,
      throughMessageId: context.summaryThroughMessageId,
      createdAt: context.summaryMeta?.createdAt ?? target.createdAt,
      modelId: context.summaryMeta?.modelId ?? target.modelId,
    }
    checkpoints.push(previous)
  }
  await repo.replaceContext(
    target.projectId,
    target.conversationId,
    target.expectedContextRevision,
    {
      version: 1,
      revision: target.expectedContextRevision + 1,
      summary: memory,
      summaryThroughMessageId: target.throughMessageId,
      summaryMeta: {
        fromMessageId: target.fromMessageId,
        throughMessageId: target.throughMessageId,
        createdAt: target.createdAt,
        modelId: target.modelId,
      },
      checkpoints: checkpoints.slice(-3),
      compaction: { status: 'idle' },
    },
  )
}

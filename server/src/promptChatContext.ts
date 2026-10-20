import type { CatalogModel } from './catalog.js'
import type {
  PromptChatContextV1,
  PromptChatMessageV2,
} from './promptChatTypes.js'

const BASE_CONTEXT_TOKENS = 8_000
const RELEVANCE_CONTEXT_TOKENS = 12_000
const HARD_CONTEXT_TOKENS = 20_000

export interface RankedMessage {
  message: PromptChatMessageV2
  score: number
}

export interface BuiltPromptChatContext {
  prompt: string
  estimatedInputTokens: number
  includedMessageIds: string[]
  needsCompaction: boolean
  contextHealth: 'ready' | 'stale'
}

interface BuildContextInput {
  messages: PromptChatMessageV2[]
  checkpoint: PromptChatContextV1 | null
  throughMessageId: string
  model: CatalogModel
  boardMemory?: string
}

export function estimateChatTokens(text: string): number {
  const latin = (text.match(/[\u0000-\u024f]/g) ?? []).length
  const other = text.length - latin
  const raw = latin / 4 + other / 2
  return Math.ceil(raw * 1.15)
}

function words(value: string): string[] {
  return value
    .toLocaleLowerCase('ru-RU')
    .match(/[\p{L}\p{N}]+/gu) ?? []
}

function assistantContent(message: PromptChatMessageV2): string {
  return [
    message.reply?.trim(),
    ...(message.prompts ?? []).map((suggestion) => suggestion.prompt.trim()),
    !message.reply && (message.prompts?.length ?? 0) === 0 ? message.text.trim() : '',
  ].filter(Boolean).join('\n')
}

function messageContent(message: PromptChatMessageV2): string {
  const main = message.role === 'assistant' ? assistantContent(message) : message.text.trim()
  const attachmentLines = (message.attachments ?? []).map((attachment, index) => {
    if (attachment.kind === 'text' && attachment.text?.trim()) {
      return `Reference ${index + 1} (${attachment.label}): ${attachment.text.trim()}`
    }
    return `Reference ${index + 1}: ${attachment.label} [${attachment.kind}]`
  })
  return [main, ...attachmentLines].filter(Boolean).join('\n')
}

function usableMessage(message: PromptChatMessageV2): boolean {
  if (message.role === 'user') return Boolean(messageContent(message))
  return message.status === 'done' && Boolean(messageContent(message))
}

function formatMessage(message: PromptChatMessageV2): string {
  const role = message.role === 'user' ? 'User' : 'Assistant'
  return `${role} [${message.id}]: ${messageContent(message)}`
}

export function rankRelevantMessages(
  query: string,
  messages: PromptChatMessageV2[],
  excludedIds: Set<string>,
): RankedMessage[] {
  const candidates = messages.filter((message) => usableMessage(message) && !excludedIds.has(message.id))
  const queryTerms = [...new Set(words(query))]
  const phrases = [...query.matchAll(/["«]([^"»]{2,})["»]/g)]
    .map((match) => match[1].toLocaleLowerCase('ru-RU').trim())
  if (queryTerms.length === 0 && phrases.length === 0) return []

  const documentTerms = candidates.map((message) => new Set(words(messageContent(message))))
  const frequencies = new Map<string, number>()
  for (const term of queryTerms) {
    frequencies.set(term, documentTerms.reduce((count, terms) => count + Number(terms.has(term)), 0))
  }
  const maxCreatedAt = Math.max(1, ...candidates.map((message) => message.createdAt))

  return candidates
    .map((message, index) => {
      const normalized = messageContent(message).toLocaleLowerCase('ru-RU')
      let score = 0
      for (const term of queryTerms) {
        if (!documentTerms[index].has(term)) continue
        const documentFrequency = frequencies.get(term) ?? 0
        score += Math.log((candidates.length + 1) / (documentFrequency + 1)) + 1
      }
      for (const phrase of phrases) {
        if (normalized.includes(phrase)) score += 4
      }
      if (score > 0) score += Math.min(0.25, message.createdAt / maxCreatedAt * 0.25)
      return { message, score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || right.message.createdAt - left.message.createdAt
      || left.message.id.localeCompare(right.message.id)
    ))
}

function renderMemory(checkpoint: PromptChatContextV1 | null): { memory: string; chronology: string } {
  const summary = checkpoint?.summary
  if (!summary) return { memory: 'Not yet no.', chronology: 'Not yet no.' }
  const lines = [
    summary.goal ? `Goal: ${summary.goal}` : '',
    ...summary.facts.map((item) => `Fact: ${item}`),
    ...summary.decisions.map((item) => `Decision: ${item.text}${item.reason ? ` — ${item.reason}` : ''}`),
    ...summary.constraints.map((item) => `Constraint: ${item}`),
    ...summary.preferences.map((item) => `Preference: ${item}`),
    ...summary.referenceNotes.map((item) => `Reference: ${item}`),
    ...summary.openQuestions.map((item) => `Open question: ${item}`),
  ].filter(Boolean)
  return {
    memory: lines.join('\n') || 'Not yet no.',
    chronology: summary.chronology || 'Not yet no.',
  }
}

function assemblePrompt(
  checkpoint: PromptChatContextV1 | null,
  relevant: PromptChatMessageV2[],
  recent: PromptChatMessageV2[],
  current: PromptChatMessageV2,
  boardMemory?: string,
): string {
  const rendered = renderMemory(checkpoint)
  return [
    boardMemory ? `[CANVAS MEMORY AND BOARD ACTIVITY LOG]\n${boardMemory}\n` : '',
    '[MEMORY CHAT]',
    rendered.memory,
    '',
    '[SUMMARY OLD HISTORY]',
    rendered.chronology,
    '',
    '[RELEVANT FRAGMENTS]',
    relevant.length > 0 ? relevant.map(formatMessage).join('\n') : 'No.',
    '',
    '[RECENT CHAT]',
    recent.length > 0 ? recent.map(formatMessage).join('\n') : 'No.',
    '',
    '[CURRENT REQUEST]',
    formatMessage(current),
  ].filter(Boolean).join('\n')
}

export function buildPromptChatContext(input: BuildContextInput): BuiltPromptChatContext {
  const throughIndex = input.messages.findIndex((message) => message.id === input.throughMessageId)
  if (throughIndex < 0) throw new Error('prompt-chat: current request not found')
  const bounded = input.messages.slice(0, throughIndex + 1)
  const current = bounded.at(-1)!
  if (current.role !== 'user' || !usableMessage(current)) {
    throw new Error('prompt-chat: current request must be a user message')
  }

  const summaryIndex = input.checkpoint?.summaryThroughMessageId
    ? bounded.findIndex((message) => message.id === input.checkpoint!.summaryThroughMessageId)
    : -1
  const history = bounded.slice(0, -1).filter(usableMessage)
  const recentCandidates = bounded
    .slice(Math.max(0, summaryIndex + 1), -1)
    .filter(usableMessage)
  const hardBudget = Math.min(
    HARD_CONTEXT_TOKENS,
    Math.max(1_000, (input.model.contextWindowTokens ?? HARD_CONTEXT_TOKENS) - 2_000),
  )

  const recent: PromptChatMessageV2[] = []
  for (let index = recentCandidates.length - 1; index >= 0; index -= 1) {
    const candidate = [recentCandidates[index], ...recent]
    if (estimateChatTokens(assemblePrompt(input.checkpoint, [], candidate, current, input.boardMemory)) > BASE_CONTEXT_TOKENS) break
    recent.unshift(recentCandidates[index])
  }

  const selectedIds = new Set([current.id, ...recent.map((message) => message.id)])
  const relevant: PromptChatMessageV2[] = []
  for (const ranked of rankRelevantMessages(messageContent(current), history, selectedIds)) {
    if (ranked.score < 2) continue
    const candidate = [...relevant, ranked.message]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    const estimated = estimateChatTokens(assemblePrompt(input.checkpoint, candidate, recent, current, input.boardMemory))
    const allowed = estimated <= RELEVANCE_CONTEXT_TOKENS
      || (ranked.score >= 2 && estimated <= hardBudget)
    if (!allowed) continue
    relevant.splice(0, relevant.length, ...candidate)
    selectedIds.add(ranked.message.id)
  }

  const prompt = assemblePrompt(input.checkpoint, relevant, recent, current, input.boardMemory)
  const estimatedInputTokens = estimateChatTokens(prompt)
  if (estimatedInputTokens > hardBudget) {
    throw new Error('prompt-chat: current request and memory exceed the context window')
  }
  const order = new Map(bounded.map((message, index) => [message.id, index]))
  const includedMessageIds = [...selectedIds].sort((left, right) => (
    (order.get(left) ?? 0) - (order.get(right) ?? 0)
  ))
  const completedSinceCheckpoint = bounded
    .slice(Math.max(0, summaryIndex + 1))
    .filter(usableMessage)
  const recentTokens = estimateChatTokens(completedSinceCheckpoint.map(formatMessage).join('\n'))

  return {
    prompt,
    estimatedInputTokens,
    includedMessageIds,
    needsCompaction: completedSinceCheckpoint.length >= 20 || recentTokens > RELEVANCE_CONTEXT_TOKENS,
    contextHealth: input.checkpoint?.compaction.status === 'error' ? 'stale' : 'ready',
  }
}

export function estimateChatRequestCost(
  model: CatalogModel,
  inputTokens: number,
  outputTokens = 1_000,
): number | null {
  if (model.pricing?.unit === 'call') return model.pricing.usd
  const price = model.textPricing
  if (!price) return null
  return inputTokens / 1_000_000 * price.inputPerMillion
    + outputTokens / 1_000_000 * price.outputPerMillion
}

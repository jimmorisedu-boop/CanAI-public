import type { PromptChatMessage } from './promptChatTypes'
import type { ConversationPage, PromptChatEstimate } from './promptChatTypes'
import { systemErrorMessage } from '../../ui/systemMessage'

export function promptChatCollapsedLabel(
  messages: PromptChatMessage[],
  elapsed: number,
): string | null {
  const latest = [...messages].reverse().find((message) =>
    message.role === 'assistant',
  )
  if (!latest) return null
  if (latest.status === 'submitting') return "Sending..."
  if (latest.status === 'queued') return "Queued…"
  if (latest.status === 'running') return `Writing prompt · ${elapsed}s`
  return null
}

export interface PromptChatEcho {
  // что показать одной строкой над промпт-баром
  text: string
  // 'working' — ещё думает (пульсирующая точка), 'error' — сорвалось, 'done' — ответ готов
  tone: 'working' | 'done' | 'error'
  // сколько сообщений в диалоге — подпись кнопки «Ещё · N»
  total: number
}

// Полоска эха: при закрытой шторке пользователь всё равно видит, чем кончился
// разговор. Раньше свёрнутый статус ПРОПАДАЛ на done/error (аудит CHT-04) —
// о готовом ответе и об ошибке узнать было нельзя, не открывая панель.
export function promptChatEcho(
  messages: PromptChatMessage[],
  elapsed: number,
): PromptChatEcho | null {
  const latest = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!latest) return null
  const total = messages.length

  if (latest.status === 'submitting') return { text: "Sending...", tone: 'working', total }
  if (latest.status === 'queued') return { text: "Queued…", tone: 'working', total }
  if (latest.status === 'running') {
    return { text: `Writing prompt · ${elapsed}s`, tone: 'working', total }
  }
  if (latest.status === 'error') {
    return { text: systemErrorMessage(latest.error, "Failed to get response"), tone: 'error', total }
  }
  if (latest.status === 'cancelled') return { text: "Stopped", tone: 'error', total }

  const reply = (latest.reply || latest.text || '').trim()
  const promptsCount = latest.prompts?.length ?? 0
  if (!reply && promptsCount === 0) return null
  const text = reply
    ? reply
    : `Ready prompts: ${promptsCount}`
  return { text, tone: 'done', total }
}

export function promptChatEstimateLabel(
  estimate: PromptChatEstimate | null,
): string | null {
  if (estimate?.costUsd == null) return null
  return `≈ $${estimate.costUsd.toFixed(3)}`
}

export function promptChatMemoryWarning(
  health: ConversationPage['contextHealth'],
): "Memory was not updated" | null {
  return health === 'stale' ? "Memory was not updated" : null
}

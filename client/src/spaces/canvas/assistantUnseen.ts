import type { PromptChatMessage } from './promptChatTypes'

export type AssistantSignal = 'none' | 'working' | 'ready' | 'failed'

// Что показывать на вкладке «Помощник», пока пользователь смотрит в промпт:
//  working — ещё думает (пульсирующая точка),
//  ready   — ответ пришёл и его ещё не открывали (вермилионовая точка),
//  failed  — сорвалось и это тоже не открывали,
//  none    — показывать нечего.
// seenId — id последнего ответа, который пользователь уже видел (вкладка
// помощника была открыта). Без него «готово» горело бы вечно.
export function assistantSignal(
  messages: PromptChatMessage[],
  seenId: string | null,
  paneOpen: boolean,
): AssistantSignal {
  const latest = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!latest) return 'none'

  if (
    latest.status === 'submitting' ||
    latest.status === 'queued' ||
    latest.status === 'running'
  ) {
    return 'working'
  }

  // открытая вкладка = пользователь и так всё видит
  if (paneOpen || latest.id === seenId) return 'none'
  if (latest.status === 'error' || latest.status === 'cancelled') return 'failed'
  if (latest.status === 'done') {
    const hasContent = Boolean((latest.reply || latest.text || '').trim()) ||
      (latest.prompts?.length ?? 0) > 0
    return hasContent ? 'ready' : 'none'
  }
  return 'none'
}

// Короткая подпись рядом с названием вкладки — чтобы сигнал читался словами,
// а не только точкой (не все различают цвета).
export function assistantSignalLabel(signal: AssistantSignal): string | null {
  if (signal === 'working') return "thinks"
  if (signal === 'ready') return "replied"
  if (signal === 'failed') return "error"
  return null
}

// id ответа, который можно пометить просмотренным. Берём только ЗАВЕРШЁННЫЙ:
// у активного сообщения id тот же, что будет у готового ответа, и пометка в
// момент отправки погасила бы будущий сигнал «ответил».
export function latestAssistantId(messages: PromptChatMessage[]): string | null {
  const latest = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!latest) return null
  const active =
    latest.status === 'submitting' ||
    latest.status === 'queued' ||
    latest.status === 'running'
  return active ? null : latest.id
}

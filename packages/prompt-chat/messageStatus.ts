// Ответ помощника, за которым некому следить: показываем его как ошибку.
// Правило одно на мост компьютера (server/src/cloudPromptChatView.ts) и на
// планшет (client/src/tablet/cloudPromptChatView.ts).
//
// ⚠️ Перенос личной доски в команду сохраняет у сообщения помощника статус
// «идёт» (queued/running; submitting при переносе становится queued), а хода
// (`turnId`) у него на сервере команды нет — тот, кто отвечал, остался на
// старом компьютере. Следить за таким сообщением некому, оно не закончится
// никогда: диалог вечно «помощник ещё отвечает», новый вопрос задать нельзя.
// Ответ, у которого есть ход, не трогаем — его доведёт сервер.

export const ORPHANED_ANSWER_ERROR =
  'No answer was received because the board was moved to the team server while the assistant was responding. Ask the question again.'

const IN_PROGRESS: readonly string[] = ['queued', 'running', 'submitting']

/** Сообщение помощника «идёт», но хода на сервере у него нет — ждать нечего. */
export function isOrphanedAnswer(status: unknown, turnId: unknown): boolean {
  return typeof status === 'string' && IN_PROGRESS.includes(status) && !turnId
}

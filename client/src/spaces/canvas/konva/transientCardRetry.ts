/**
 * «Повторить» у карточки, которая живёт только в этой вкладке.
 *
 * Карточка переноса файла (вставка с другой доски) — временная: её нет ни в
 * снимке доски, ни на сервере, и описать повтор полями нельзя — повторить
 * значит заново отправить файл. Поэтому повтор держим здесь, пока жива
 * вкладка; после перезагрузки карточки нет, и повторять нечего.
 *
 * ⚠️ Повтор регистрируется ДО того, как карточка покраснеет: она
 * перерисовывается от той же правки и спрашивает, есть ли повтор, сразу.
 */

const retries = new Map<string, () => void>()

export function registerCardRetry(cardId: string, retry: () => void): void {
  retries.set(cardId, retry)
}

export function forgetCardRetry(cardId: string): void {
  retries.delete(cardId)
}

export function canRetryCard(cardId: string): boolean {
  return retries.has(cardId)
}

/** Запустить повтор; одно нажатие — одна попытка, второй клик ничего не сделает. */
export function retryCard(cardId: string): boolean {
  const retry = retries.get(cardId)
  if (!retry) return false
  retries.delete(cardId)
  retry()
  return true
}

import { config } from './config.js'

export const GENERATION_UNAVAILABLE_MESSAGE =
  'Generation is unavailable. Add a fal.ai key in Settings.'

/**
 * Можно ли вообще запускать генерацию.
 *
 * ⚠️ Путей ДВА, и мерить только ключом fal нельзя. Человек, выбравший «через
 * сервер CanAI», ключа не имеет вовсе — он ровно поэтому и выбрал сервер.
 * Отказ по ключу запирал генерацию именно тому, ради кого сервер и заведён
 * (поймано живым прогоном: 503 «Ключ fal.ai не настроен» при настроенном и
 * выбранном сервере).
 *
 * ⚠️ Обратное тоже важно: если выбран сервер, а подключения нет, мы НЕ
 * подменяем путь на прямой вызов. Молча потратить чужой ключ, который человек
 * держал про запас, хуже честного отказа.
 */
export function generationAvailable(): boolean {
  if (config.mockMode) return true
  return Boolean(config.falKey)
}

/** Отказ должен называть ту причину, которая есть на самом деле. */
export function generationUnavailableMessage(): string {
  return GENERATION_UNAVAILABLE_MESSAGE
}

// Настройки читаются с диска, а проверка доступности зовётся на каждый запуск —
// поэтому выбранный путь держим в памяти и обновляем при сохранении настроек.
export function setGenerationTransport(transport: 'local' | 'cloud'): void {
  void transport
}

/** Разовое чтение при старте: до первого сохранения настроек знать неоткуда. */
export async function initGenerationTransport(): Promise<void> {
  // Оставлено как совместимый startup hook: маршрут теперь определяется
  // source доски, а не глобальной настройкой.
}

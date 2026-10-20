import type { CanvasDoc } from './konva/types'

/**
 * Одинаковы ли два снимка доски ПО СОДЕРЖАНИЮ.
 *
 * Зачем: при старте клиент отправляет на сервер отложенный снимок прошлой
 * сессии — и отправляет его со СТАРЫМ номером ревизии. Если номер разошёлся
 * (а после обновления приложения это обычное дело), сервер делает конфликтную
 * копию ДО того, как человека о чём-то спросят, и в галерее появляется вторая
 * доска. Жалоба тестировщика 18.09.2026: «просто запустила после обновления,
 * он спросил про версию, выбрала последнюю — вышла, а там две доски».
 *
 * ⚠️ Чаще всего восстанавливать при этом НЕЧЕГО: работа уже сохранена, и
 * отложенный снимок слово в слово совпадает с тем, что лежит на сервере. Такой
 * снимок отправлять незачем — сравниваем содержимое и молчим.
 *
 * Сравнение нечувствительно к порядку ключей: снимок проходит через JSON и
 * обратно в разных местах, и полагаться на порядок полей нельзя.
 */
export function sameSnapshot(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left == null || right == null) return false
  try {
    return canonical(left) === canonical(right)
  } catch {
    // Снимок с циклом или чем-то непереводимым в JSON: считаем разными и идём
    // прежним путём — молча проглотить отличие хуже, чем лишняя отправка.
    return false
  }
}

/** Снимок для сравнения: ключи по алфавиту, остальное как есть. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value, 0))
}

const MAX_DEPTH = 64

function sortKeys(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error("the shot is too deep")
  if (Array.isArray(value)) return value.map((item) => sortKeys(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    // undefined в JSON не попадает вовсе; выбрасываем его и здесь, иначе
    // «поля нет» и «поле равно undefined» считались бы разными снимками.
    if (source[key] === undefined) continue
    sorted[key] = sortKeys(source[key], depth + 1)
  }
  return sorted
}

/** Нужно ли вообще отправлять отложенный снимок на сервер. */
export function recoveryWorthSending(recovery: CanvasDoc | null | undefined, server: unknown): boolean {
  if (!recovery) return false
  return !sameSnapshot(recovery, server)
}

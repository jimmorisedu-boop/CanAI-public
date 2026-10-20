/**
 * Подготовка значений к записи в журнал.
 *
 * Три правила, каждое выстрадано инвариантами проекта:
 *  1. Никакого base64 и никаких простыней. Журнал живёт в памяти вкладки, и
 *     одна вставленная картинка размером в мегабайты вытеснила бы из него всё
 *     остальное — то есть ровно те строки, ради которых его и открыли.
 *  2. Никаких секретов. Ключ fal и код доступа с планшета не должны попасть
 *     в файл, который человек пересылает мне в переписку.
 *  3. Ничего не бросать. Логирование обязано молчать при любом входе: журнал,
 *     который роняет приложение, хуже отсутствующего журнала.
 */

const MAX_STRING = 200
const MAX_ARRAY = 20
const MAX_KEYS = 40
const MAX_DEPTH = 4

/** Поля, значение которых в журнал не попадает НИКОГДА. */
const SECRET_KEYS = /(key|token|secret|password|pin|cookie|authorization|credential)/i

/** Ссылка на медиа со строкой запроса `?v=<mtime>` — хвост только мешает. */
function shortenUrl(value: string): string {
  const [path] = value.split('?')
  return path.length < value.length ? `${path}?…` : value
}

function shortenString(value: string): string {
  if (value.startsWith('data:')) {
    const head = value.slice(0, value.indexOf(',') + 1) || 'data:'
    return `${head}…(${Math.round(value.length / 1024)} KB)`
  }
  const trimmed = value.startsWith('/media/') || value.startsWith('http') ? shortenUrl(value) : value
  return trimmed.length > MAX_STRING
    ? `${trimmed.slice(0, MAX_STRING)}…(${trimmed.length} chars.)`
    : trimmed
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return shortenString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'function') return '[function]'
  if (value instanceof Error) return { error: value.name, message: shortenString(value.message) }
  if (depth >= MAX_DEPTH) return '[depth limit]'
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((entry) => sanitizeLogValue(entry, depth + 1))
    return value.length > MAX_ARRAY ? [...head, `…${value.length - MAX_ARRAY} more`] : head
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    let written = 0
    for (const key of Object.keys(source)) {
      if (written >= MAX_KEYS) {
        result['…'] = `${Object.keys(source).length - written} more fields`
        break
      }
      written += 1
      result[key] = SECRET_KEYS.test(key) ? '[hidden]' : sanitizeLogValue(source[key], depth + 1)
    }
    return result
  }
  return String(value)
}

export function sanitizeLogData(data: unknown): Record<string, unknown> | undefined {
  if (data === undefined || data === null) return undefined
  const clean = sanitizeLogValue(data)
  if (clean && typeof clean === 'object' && !Array.isArray(clean)) return clean as Record<string, unknown>
  return { value: clean }
}

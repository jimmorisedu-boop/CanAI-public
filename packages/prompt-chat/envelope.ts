/**
 * Найти НАШ конверт в ответе модели, где бы он ни лежал.
 *
 * ⚠️ **Раньше конверт опознавался, только когда занимал ВЕСЬ ответ целиком.**
 * Модель часто пишет вокруг него по-человечески — «Конечно!» перед блоком кода
 * или «Надеюсь, помог» после, — и разбор объявлял такой ответ чужим. Человек
 * видел в ленте машинный JSON вместо ответа (жалобы 09.09.2026 и 20.09.2026,
 * оба раза со снимком). Заставить модель молчать вокруг конверта нечем: у
 * нашего маршрута LLM режима строгого JSON нет (см. salvage.ts).
 *
 * ⚠️ Второй случай — ответ ОБРЫВАЕТСЯ на полуслове: разговор упёрся в потолок
 * токенов, и JSON не закрыт. Разбор падал, и в ленту опять уходил машинный
 * текст. Ответ при этом оплачен и по существу написан — показываем его.
 */

/** Дальше ищем только мусор: у наших ответов конверт лежит в начале. */
const MAX_SCAN = 200_000
/** Столько кандидатов «{…}» достаточно даже для болтливой модели. */
const MAX_CANDIDATES = 40

export interface PromptChatEnvelope {
  reply: string
  prompts?: unknown
  referenceNotes?: unknown
}

function asEnvelope(value: unknown): PromptChatEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as { reply?: unknown }
  if (typeof raw.reply !== 'string') return null
  return value as PromptChatEnvelope
}

function tryParse(text: string): PromptChatEnvelope | null {
  try {
    return asEnvelope(JSON.parse(text))
  } catch {
    return null
  }
}

/** Куски ```…``` в любом месте ответа, в порядке появления. */
function fencedBlocks(raw: string): string[] {
  const blocks: string[] = []
  const re = /```(?:json)?\s*([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null && blocks.length < MAX_CANDIDATES) {
    blocks.push(match[1].trim())
  }
  return blocks
}

/**
 * Границы объекта считаем СКОБКАМИ, а не регулярным выражением: в промпте
 * сплошь и рядом попадаются фигурные скобки и кавычки, и жадный разбор
 * отхватил бы кусок соседнего текста.
 */
function balancedObjects(raw: string): string[] {
  const found: string[] = []
  for (let i = 0; i < raw.length && found.length < MAX_CANDIDATES; i += 1) {
    if (raw[i] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = i; j < raw.length; j += 1) {
      const ch = raw[j]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          found.push(raw.slice(i, j + 1))
          i = j
          break
        }
      }
    }
  }
  return found
}

export function findEnvelope(rawResponse: string): PromptChatEnvelope | null {
  const raw = rawResponse.trim().slice(0, MAX_SCAN)
  if (!raw) return null
  const whole = tryParse(raw)
  if (whole) return whole
  for (const block of fencedBlocks(raw)) {
    const parsed = tryParse(block)
    if (parsed) return parsed
  }
  for (const candidate of balancedObjects(raw)) {
    const parsed = tryParse(candidate)
    if (parsed) return parsed
  }
  return null
}

/**
 * Расшифровать тело строки JSON, оборванное на полуслове.
 *
 * ⚠️ Незакрытый экранирующий знак в конце просто отбрасываем: «\» без пары —
 * это половина символа, которую модель не успела дописать.
 */
export function decodeJsonStringBody(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = body[i + 1]
    if (next === undefined) break
    i += 1
    if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === 'r') out += '\r'
    else if (next === 'b') out += '\b'
    else if (next === 'f') out += '\f'
    else if (next === 'u') {
      const hex = body.slice(i + 1, i + 5)
      if (/^[0-9a-f]{4}$/i.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
      }
    } else out += next
  }
  return out
}

/**
 * Достать текст ответа из ОБОРВАННОГО конверта.
 *
 * ⚠️ Признак узкий нарочно: строка должна начинаться с «{» и нести ключ
 * `reply`. Обычный текст, в котором случайно попалось слово reply, сюда не
 * попадёт — а ошибись мы, человек увидел бы вместо ответа его обрезок.
 */
export function salvageReply(rawResponse: string): string | null {
  const raw = rawResponse.trim().slice(0, MAX_SCAN)
  const body = raw.startsWith('{') ? raw : fencedBlocks(raw).find((block) => block.startsWith('{'))
  if (!body) return null
  const match = /"reply"\s*:\s*"/u.exec(body)
  if (!match) return null
  const rest = body.slice(match.index + match[0].length)
  let end = rest.length
  let escaped = false
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { end = i; break }
  }
  const text = decodeJsonStringBody(rest.slice(0, end)).trim()
  return text || null
}

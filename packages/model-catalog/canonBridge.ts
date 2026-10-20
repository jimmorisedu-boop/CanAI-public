/** Public compatibility aliases used by desktop, tablet and the team gateway. */
const sizes: Record<string, string> = {
  '0.5K': 'sd', '1K': 'hd', '2K': '2k', '4K': '4k', '1k': 'hd',
  '480p': 'sd', '720p': 'hd', '1080p': '2k',
  square_hd: 'hd', square: 'sd',
}
const aliases: Record<string, string> = {
  aspect_ratio: 'aspect', resolution: 'size', image_size: 'size',
  output_format: 'format', negative_prompt: 'negative', output_compression: 'compression',
}
const canonical = new Set(['aspect', 'size', 'format', 'negative', 'duration', 'seed', 'quality', 'background', 'compression'])
const forbidden = new Set(['__proto__', 'constructor', 'prototype'])

export function toCanonParams(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const custom: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(input)) {
    // Batch size belongs to admission, never to the provider parameter object.
    if (key === 'num_images' && raw === 1) continue
    const field = /^custom__([A-Za-z][A-Za-z0-9_]{0,63})$/u.exec(key)?.[1]
    if (field && !forbidden.has(field)) {
      if (!['string', 'number', 'boolean'].includes(typeof raw) || typeof raw === 'number' && !Number.isFinite(raw)) throw new Error(`Invalid parameter: ${key}`)
      custom[field] = raw
      continue
    }
    const name = aliases[key] ?? key
    if (!canonical.has(name)) throw new Error(`Unknown parameter: ${key}`)
    let value = raw
    if (name === 'size' && typeof raw === 'string') value = sizes[raw] ?? raw
    if (name === 'size' && !['auto', 'sd', 'hd', '2k', '4k'].includes(String(value))) throw new Error(`Unknown size: ${String(value)}`)
    // ⚠️ «Авто» у размера и пропорций — это ОТСУТСТВИЕ параметра, а не его
    // значение: «решает модель по референсу». Правило старое, но новый мост
    // стал возить «auto» дальше — и сервер команды честно отвечал «Значение
    // «auto» параметра «size» не поддерживается операцией», потому что ни
    // Grok, ни Nano Banana его не объявляют. Итог: генерация с настройками по
    // умолчанию падала совсем (жалоба 09.09.2026 с планшета, две модели
    // подряд). У кого «auto» — законное значение схемы, тот получит его своим
    // же умолчанием.
    if ((name === 'size' || name === 'aspect') && value === 'auto') continue
    if (name === 'duration' && typeof raw === 'string' && /^\d+$/u.test(raw)) value = Number(raw)
    if (name === 'negative' && typeof raw === 'string') value = raw.trim()
    if (name === 'seed' && typeof value === 'number' && value < 0) continue
    if (Object.hasOwn(result, name) && result[name] !== value) throw new Error(`Conflicting parameter values: ${name}`)
    result[name] = value
  }
  if (Object.keys(custom).length) result.custom = custom
  return result
}

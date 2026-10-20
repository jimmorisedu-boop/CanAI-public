// Случайный идентификатор — единственная точка на весь клиент.
//
// ⚠️ `crypto.randomUUID()` НЕ работает вне защищённого контекста.
//
// На компьютере страница живёт на `http://127.0.0.1`, а localhost браузер
// считает защищённым — поэтому там всё работает. Планшет же открывает доску по
// адресу вида `http://192.168.1.5:8789`, и это уже НЕ защищённый контекст:
// `crypto.randomUUID` там просто `undefined`, а `crypto.subtle` и
// `navigator.clipboard` отсутствуют вовсе (замерено вживую: isSecureContext
// false, randomUUID undefined).
//
// Первый же вызов бросал TypeError на старте — раньше, чем React успевал
// нарисовать хоть что-то, — и человек видел ПУСТОЙ ЭКРАН без единой подсказки.
// Поймано не нами: у коллеги на айпаде, потому что в разработке страницу
// открывают по localhost и на эти грабли не наступают никогда.
//
// `crypto.getRandomValues` доступен и в незащищённом контексте — на нём и
// стоим. Формат остаётся тем же UUID v4: он уезжает в id объектов доски и в
// ключи идемпотентности, и менять его форму нельзя.

export function newId(): string {
  const api = globalThis.crypto
  if (typeof api?.randomUUID === 'function') return api.randomUUID()

  const bytes = new Uint8Array(16)
  if (typeof api?.getRandomValues === 'function') {
    api.getRandomValues(bytes)
  } else {
    // Совсем древний браузер: слабее, но это лучше, чем пустой экран.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  // Версия 4 и вариант 10xx — иначе это будет не UUID, а просто 32 знака.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex: string[] = []
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

/**
 * Скопировать текст.
 *
 * `navigator.clipboard` — тоже только для защищённого контекста, и на планшете
 * его нет. Запасной путь через скрытое поле работает везде; если не вышло и он,
 * честно возвращаем false, чтобы кнопка не врала «Скопировано».
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // упало — пробуем запасной путь ниже
  }
  try {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    // Вне экрана, но не display:none — иначе выделять нечего.
    field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    document.body.appendChild(field)
    field.select()
    field.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    field.remove()
    return ok
  } catch {
    return false
  }
}

/**
 * Где брать прокси и кого через него НЕ пускать.
 *
 * ⚠️ Зачем это вообще: там, где до сервера команды не достучаться напрямую,
 * человек включает прокси в системе — и браузер начинает работать, а
 * приложение нет. Node переменные прокси сам не читает, поэтому запрос уходит
 * напрямую и вязнет на соединении. Замер на живой установке: через прокси
 * 577 мс, напрямую — 10.7 с и отказ.
 *
 * ⚠️ Включить это изнутри процесса нельзя: `NODE_USE_ENV_PROXY` Node читает
 * при старте, и присвоение в коде уже ничего не меняет (проверено). Поэтому
 * переменную выставляет лаунчер, а этот модуль нужен там, где прокси надо
 * применить руками — прежде всего к WebSocket доски: библиотека сокетов о
 * переменных окружения не знает вовсе.
 */

export interface ProxyEnv {
  [key: string]: string | undefined
}

function pick(env: ProxyEnv, ...names: string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return null
}

/** Свой адрес — никогда не через прокси, даже если его забыли в NO_PROXY. */
export function isLocalHost(host: string): boolean {
  const clean = host.replace(/^\[|\]$/gu, '').toLowerCase()
  if (clean === 'localhost' || clean.endsWith('.localhost')) return true
  if (clean === '::1' || clean === '0.0.0.0') return true
  if (/^127\./u.test(clean)) return true
  // Соседи по локальной сети — тоже мимо прокси: планшет и гостевая страница
  // живут именно там, и пускать их наружу было бы и медленно, и бессмысленно.
  if (/^10\./u.test(clean) || /^192\.168\./u.test(clean)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./u.test(clean)) return true
  if (/^169\.254\./u.test(clean)) return true
  return false
}

/** Правила NO_PROXY: имя, .суффикс, `*` — всё как принято в остальных программах. */
export function noProxyMatches(rule: string, host: string): boolean {
  const clean = rule.trim().toLowerCase().replace(/:\d+$/u, '')
  if (!clean) return false
  if (clean === '*') return true
  const target = host.toLowerCase()
  if (clean.startsWith('.')) return target.endsWith(clean) || target === clean.slice(1)
  if (clean.startsWith('*.')) return target.endsWith(clean.slice(1)) || target === clean.slice(2)
  return target === clean
}

/**
 * Адрес прокси для конкретной цели, либо null.
 *
 * ⚠️ Для https берём ИМЕННО https-переменную и не падаем на http-переменную:
 * у обычной связки прокси-клиента это разные порты и часто разные протоколы
 * (SOCKS против HTTP), и подстановка «похожего» адреса выглядела бы как
 * работающая настройка, а на деле обрывала бы соединение.
 */
export function proxyForUrl(target: string, env: ProxyEnv = process.env): string | null {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return null
  }
  if (isLocalHost(url.hostname)) return null

  const noProxy = pick(env, 'NO_PROXY', 'no_proxy')
  if (noProxy && noProxy.split(',').some((rule) => noProxyMatches(rule, url.hostname))) return null

  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const proxy = secure
    ? pick(env, 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy')
    : pick(env, 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy')
  if (!proxy) return null

  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(proxy) ? proxy : `http://${proxy}`)
    // Туннель умеем строить только через обычный HTTP-прокси: SOCKS это другой
    // протокол, и молча выдавать его за рабочий нельзя.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

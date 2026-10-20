// Сетевые сбои и запасной хост CDN fal.
//
// Наблюдение с боевой машины (2026-08-06): `v3.fal.media` и `v3b.fal.media`
// резолвятся в ОДНИ И ТЕ ЖЕ адреса, но соединение с первым рвётся с ECONNRESET,
// а второй отвечает нормально. Значит режет не маршрут, а DPI по имени хоста в
// TLS — ровно то, о чём говорит наше же сообщение «VPN/файрвол иногда режут
// CDN». Результат генерации при этом уже оплачен, поэтому терять его из-за
// одного заблокированного имени нельзя: пробуем зеркало.

const NETWORK_ERROR_RE =
  /fetch failed|network|socket hang up|terminated|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Connect Timeout|UND_ERR/i

export function isNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  if (NETWORK_ERROR_RE.test(message)) return true
  const cause = (err as { cause?: { message?: string; code?: string } })?.cause
  if (cause && NETWORK_ERROR_RE.test(`${cause.message ?? ''} ${cause.code ?? ''}`)) return true
  return false
}

// Пары взаимозаменяемых имён CDN fal.
const MIRRORS: Record<string, string> = {
  'v3.fal.media': 'v3b.fal.media',
  'v3b.fal.media': 'v3.fal.media',
}

/** Тот же файл на запасном хосте CDN, или null — если зеркала для него нет. */
export function falMirrorUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const mirror = MIRRORS[parsed.hostname.toLowerCase()]
  if (!mirror) return null
  parsed.hostname = mirror
  return parsed.toString()
}

/** Адреса, по которым стоит попробовать скачать один и тот же файл. */
export function downloadCandidates(url: string): string[] {
  const mirror = falMirrorUrl(url)
  return mirror ? [url, mirror] : [url]
}

/**
 * fal SDK получает одноразовый PUT-адрес загрузки на v3.fal.media. В сетях,
 * где DPI режет это TLS-имя, тот же адрес на v3b.fal.media остаётся рабочим.
 * Повторяем только сетевой сбой PUT: остальные запросы и HTTP-отказы не трогаем.
 */
export function withFalUploadMirror(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await fetchImpl(input, init)
    } catch (error) {
      const method = init?.method ?? (input instanceof Request ? input.method : undefined)
      const sourceUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      const mirror = method?.toUpperCase() === 'PUT' && isNetworkError(error)
        ? falMirrorUrl(sourceUrl)
        : null
      if (!mirror || !init?.body) throw error
      return fetchImpl(mirror, init)
    }
  }
}

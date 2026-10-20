/**
 * Поля снимка локальной доски, которые НЕ едут на сервер.
 *
 * ⚠️ `retry` — описание «как повторить генерацию»: тип, модель и референсы со
 * ссылками на локальные файлы. На сервере оно бесполезно (чужие ссылки), а
 * главное — ломает приём: сервер проверяет КАЖДЫЙ вложенный объект и видит
 * `kind: "image"` без `assetId`, то есть «медиа облачной доски требует
 * assetId». Из-за этого «Копировать в команду» падало с внутренней ошибкой на
 * любой доске, в истории версий которой была заглушка генерации (найдено
 * 03.09.2026 — та же причина, по которой падала генерация на сетевой доске,
 * только другим путём).
 *
 * Правило то же, что на клиенте (`LOCAL_ONLY_KEYS` в `cloudAssetTransport.ts`):
 * местное бухгалтерское поле наружу не уезжает. Держим его и здесь, потому что
 * этот путь идёт мимо клиента — снимок читается прямо с диска.
 */
const LOCAL_ONLY_KEYS = new Set([
  'retry',
  // Эти поля принадлежат только долговечной очереди jobs.json. Даже если
  // ошибочный клиент когда-нибудь положит их в snapshot, на сервер команды
  // схема неопубликованной модели и служебная квитанция уезжать не должны.
  'modelSnapshot',
  'catalogDraftTest',
])

export function stripLocalOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLocalOnly)
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (LOCAL_ONLY_KEYS.has(key)) continue
    output[key] = stripLocalOnly(nested)
  }
  return output
}

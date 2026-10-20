/**
 * Какая сборка интерфейса открыта (пункт 5.1 списка исправлений).
 *
 * Номер вшивает сборщик (`define` в vite.config.ts и vite.tablet.config.ts) по
 * тому же правилу, что сервер берёт для себя (`server/src/buildInfo.ts`): один
 * источник на обе стороны, иначе номера разъехались бы при первой правке.
 * ⚠️ Номера интерфейса и сервера показываются ОБА и НЕ сравниваются:
 * интерфейс пересобирается, только когда менялись его исходники, и после
 * чисто серверной правки номера законно разные — тревога была бы ложной.
 */

export interface BuildInfo {
  version: string
  commit: string | null
  date: string | null
  dirty?: boolean
}

declare const __CANAI_BUILD__: BuildInfo | undefined

/** Сборка этой страницы; null — страница не собрана сборщиком (тесты). */
export function clientBuild(): BuildInfo | null {
  return typeof __CANAI_BUILD__ === 'undefined' ? null : __CANAI_BUILD__
}

function day(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`
}

/** «0.1.0 · 9e84a03 от 26.09.2026» — для людей; номер короткий, как в git. */
export function formatBuild(info: BuildInfo | null | undefined): string {
  if (!info) return 'unknown'
  if (!info.commit) return `${info.version} · commit unknown`
  const when = day(info.date)
  return `${info.version} · ${info.commit.slice(0, 7)}${when ? ` on ${when}` : ''}${info.dirty ? ' (with changes)' : ''}`
}

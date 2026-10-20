import type { LastWriter } from './projects.js'

/**
 * Строки журнала о записи доски — там, где запись пошла не по прямой.
 *
 * ⚠️ Раньше конфликтная копия появлялась МОЛЧА: в журнале не оставалось ни
 * строки, и разбирать жалобу «опять две доски» приходилось по догадкам — чья
 * вкладка, после перезапуска или нет, писал ли доску сам сервер (21.09.2026).
 * Теперь каждая копия объясняет себя: кто ждал какую ревизию, кто писал доску
 * последним и сколько вкладок держат её открытой прямо сейчас. Одна открытая
 * вкладка при «другой вкладке» в последних записях — верный признак того, что
 * две вкладки представились серверу одним именем.
 */

/** Ключ сеанса короче: для журнала хватает начала, целиком он там не нужен. */
export function shortKey(key: string | null | undefined): string {
  return key ? key.slice(0, 8) : '—'
}

function describeWriter(writer: LastWriter): string {
  switch (writer.kind) {
    case 'other-tab':
      return `it was written by another tab ${shortKey(writer.key)} (revision ${writer.base})`
    case 'server':
      return 'The server placed the result on the board'
    case 'external':
      return 'Board file was changed outside the app'
    default:
      return 'Writer unknown (entry predates the update)'
  }
}

export function conflictLine(input: {
  projectId: string
  sessionKey: string | null
  expectedRevision: number
  serverRevision: number
  lastWriter: LastWriter
  openTabs: number
  holder: string | null
  copyName: string
}): string {
  const holder = input.holder ? `holds ${shortKey(input.holder)}` : 'nothing holds it'
  return `board ${input.projectId}: conflict — tab ${shortKey(input.sessionKey)} wrote over revision `
    + `${input.expectedRevision}, and on server already ${input.serverRevision}; ${describeWriter(input.lastWriter)}. `
    + `Open tabs: ${input.openTabs}, ${holder}. Edit saved as copy “${input.copyName}»`
}

export function repeatedWriteLine(input: {
  projectId: string
  sessionKey: string | null
  from: number
  to: number
}): string {
  return `board ${input.projectId}: tab ${shortKey(input.sessionKey)} repeated an entry whose response `
    + `did not reach it (revision ${input.from} → ${input.to}) — accepted without a conflict copy`
}

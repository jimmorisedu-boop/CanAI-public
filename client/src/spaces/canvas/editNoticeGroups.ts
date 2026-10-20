import type { PublicEditSession } from '../../api'
import { pluralWithCount } from '../../ui/plural'

// Одинаковые сообщения сворачиваются в ОДНО с числом.
//
// Жалоба 19.08.2026 (скриншот): шесть полосок «"…" открыт в редакторе — жду
// сохранения (Ctrl+S)» встали стопкой над промпт-баром и закрыли пол-холста.
// Открыть в Фотошопе несколько картинок — обычное дело, а сообщение у них
// одно и то же: отличается только имя файла. Шесть строк об одном и том же
// не сообщают в шесть раз больше — они просто занимают место там, где человек
// работает.
//
// Группируем по СМЫСЛУ карточки, а не по сессии: состояние плюс доска и её
// судьба. Именно эта тройка определяет и текст, и набор кнопок, поэтому внутри
// группы карточки взаимозаменяемы, и свернуть их можно без потери.

export interface EditNoticeGroup {
  key: string
  state: PublicEditSession['state']
  sessions: PublicEditSession[]
}

export function editNoticeGroupKey(session: PublicEditSession): string {
  return `${session.state}:${session.projectId}:${session.projectStatus}`
}

export function groupEditNotices(sessions: PublicEditSession[]): EditNoticeGroup[] {
  const groups: EditNoticeGroup[] = []
  const byKey = new Map<string, EditNoticeGroup>()
  for (const session of sessions) {
    const key = editNoticeGroupKey(session)
    const existing = byKey.get(key)
    if (existing) {
      existing.sessions.push(session)
      continue
    }
    // Порядок групп — по первому появлению: сообщения не должны прыгать
    // местами, пока человек тянется к кнопке.
    const group: EditNoticeGroup = { key, state: session.state, sessions: [session] }
    byKey.set(key, group)
    groups.push(group)
  }
  return groups
}

const FILES: [string, string, string] = ["file", "files", "files"]

/**
 * Текст свёрнутой группы. Для одиночной сессии — прежняя фраза с именем файла:
 * когда файл один, имя и есть самое полезное в сообщении.
 */
export function editNoticeGroupText(group: EditNoticeGroup): string {
  const count = group.sessions.length
  const name = group.sessions[0]?.sourceName ?? ''
  if (count === 1) {
    if (group.state === 'applied') return `The "${name}" edit has been applied.`
    if (group.state === 'ready') return `I apply the “${name}” edit...`
    return `“${name}” is open in the editor - waiting for saving (Ctrl+S)…`
  }
  const files = pluralWithCount(count, FILES)
  if (group.state === 'applied') return `Edits applied: ${files}.`
  if (group.state === 'ready') return `I apply the edits: ${files}…`
  return `${files} are open in the editor - waiting for saving (Ctrl+S)…`
}

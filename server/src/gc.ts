import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { mediaRootsIn } from './mediaLayout.js'
import { activeEditFileNames } from './editSessions.js'
import { allProjectFiles } from './projects.js'
import { hasPendingDurableRecovery } from './durableJsonRecovery.js'

// Сборка мусора: удаляем файлы из media/, на которые не ссылается ни один
// холст (project.json всех досок), ни черновик нод, ни макросы, ни сохранённая задача. Так папка
// не пухнет от старых генераций и версий из редактора.

const dataDir = path.dirname(config.projectFile)
const promptChatsDir = path.join(dataDir, 'prompt-chats')
const projectTrashDir = path.join(dataDir, 'trash')

async function walkJsonFiles(root: string): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...await walkJsonFiles(absolute))
    else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.tmp')) files.push(absolute)
  }
  return files
}

export async function allPromptChatJsonFiles(): Promise<string[]> {
  return [
    ...await walkJsonFiles(promptChatsDir),
    ...await walkJsonFiles(projectTrashDir),
  ]
}

async function collectReferenced(): Promise<Set<string> | null> {
  const sources = [
    ...(await allProjectFiles()),
    ...(await allPromptChatJsonFiles()),
    path.join(dataDir, 'workflow-draft.json'),
    path.join(dataDir, 'macros.json'),
    path.join(dataDir, 'edit-sessions.json'),
    config.jobsFile,
    config.mediaImportsFile,
    config.agentTasksFile,
  ]
  const referenced = new Set<string>()
  let sawAny = false
  for (const file of sources) {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      return null // EACCES/EIO: не рискуем удалять media без полного набора ссылок
    }
    // если файл есть, но не парсится — прерываем GC, чтобы не снести лишнее
    try {
      JSON.parse(text)
    } catch {
      return null
    }
    sawAny = true
    for (const m of text.matchAll(/\/media\/([A-Za-z0-9._-]+)/g)) referenced.add(m[1])
  }
  // активные edit-сессии (в памяти + на диске) — Photoshop может держать файл
  // часами, пока он ещё не попал на холст
  try {
    for (const name of await activeEditFileNames()) referenced.add(name)
  } catch {
    return null
  }
  // ни одного источника нет (совсем чистый старт) — тоже безопасно чистить
  void sawAny
  return referenced
}

// minAgeMs > 0 — щадить свежие файлы (для планового GC на живом сервере:
// только что скачанный результат мог ещё не попасть ни в один project.json)
export async function gcMedia(minAgeMs = 0): Promise<{ removed: number; kept: number }> {
  // A recovered projects/jobs backup may omit media references that were only
  // present in the damaged primary. Keep every file until the operator reviews
  // the durable recovery marker, including across subsequent restarts.
  if (await hasPendingDurableRecovery(dataDir)) return { removed: 0, kept: 0 }
  const referenced = await collectReferenced()
  if (referenced === null) return { removed: 0, kept: 0 } // защита: источник битый

  // Медиа лежит по папкам (см. mediaLayout), поэтому обходим и корень, и их:
  // в корне остаются файлы, записанные до раскладки.
  const roots = await mediaRootsIn(config.mediaDir)
  let removed = 0
  let kept = 0
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const file = entry.name
      // Ссылки хранят ТОЛЬКО имя файла, поэтому и сверяем по имени: где он
      // лежит на диске, для ссылки безразлично.
      if (referenced.has(file)) {
        kept++
        continue
      }
      const full = path.join(root, file)
      if (minAgeMs > 0) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat && Date.now() - stat.mtimeMs < minAgeMs) {
          kept++
          continue
        }
      }
      try {
        await fs.unlink(full)
        removed++
      } catch {
        kept++
      }
    }
  }
  return { removed, kept }
}

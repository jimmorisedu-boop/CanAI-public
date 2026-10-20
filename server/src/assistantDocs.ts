import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { logError } from './log.js'
import { AssistantsStoreError } from './assistantsFormat.js'

// Тексты документов знаний: data/assistant-docs/<id>.txt, по файлу на документ.
// Чей это документ, записано в библиотеке (assistantsStore.ts) — здесь только
// сами файлы.
//
// ⚠️ Номер документа в путь попадает ТОЛЬКО из библиотеки или только что
// выданным (randomUUID). Номер из адреса запроса сюда напрямую не отдают: по
// выдуманному «../…» читался или стирался бы посторонний файл.

const docsDir = path.join(path.dirname(config.settingsFile), 'assistant-docs')
const docFile = (id: string): string => path.join(docsDir, `${id}.txt`)

/** Текст документа знаний; null — прочитать не удалось: файла нет или он занят. */
export function readAssistantDoc(id: string): Promise<string | null> {
  return fs.readFile(docFile(id), 'utf8').catch(() => null)
}

/**
 * Пропал ли файл документа с диска.
 *
 * ⚠️ «Пропал» — только когда файла действительно нет. Занятый или недоступный
 * файл цел: по этому ответу документ убирают из списка помощника, и минутная
 * блокировка стоила бы человеку документа.
 */
export async function assistantDocMissing(id: string): Promise<boolean> {
  try {
    await fs.access(docFile(id))
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export async function writeAssistantDoc(id: string, text: string): Promise<void> {
  try {
    await fs.mkdir(docsDir, { recursive: true })
    await fs.writeFile(docFile(id), text)
  } catch (error) {
    logError('assistants', error)
    throw new AssistantsStoreError(
      'Could not save the assistant document: the data folder is unavailable or the disk is full. Try again.',
      { cause: error },
    )
  }
}

/** Убрать файлы документов. Пропавший файл — не ошибка: убирать уже нечего. */
export async function removeAssistantDocs(ids: readonly string[]): Promise<void> {
  for (const id of ids) await fs.rm(docFile(id), { force: true }).catch(() => {})
}

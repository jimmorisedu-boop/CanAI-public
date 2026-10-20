import { downloadTextFile } from '../../diag/logFile'
import { readLibraryFile, serializeLibraryFile, type LibraryFileKind } from './libraryFile'

// Диск для файлов обмена: отдать файл и выбрать файл. Всё, что решает, ЧТО в
// файле и сколько он может весить, живёт в libraryFile.ts, macroFile.ts и
// assistantFile.ts — там оно проверяется тестами.

/** Отдаёт файл. Не помещается в предел чтения — отказ словами, а не файл, который потом не загрузить. */
export function saveLibraryFile(fileName: string, file: unknown): void {
  downloadTextFile(fileName, serializeLibraryFile(file), 'application/json;charset=utf-8')
}

/**
 * Спросить у человека файл. `null` — окно выбора закрыли, ничего не выбрав.
 *
 * `kind` задаёт предел размера. По умолчанию — помощник: его файл несёт тексты
 * документов знаний и законно бывает крупнее файла макроса.
 */
export function pickLibraryFile(kind: LibraryFileKind = 'assistant'): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.style.display = 'none'
    const done = (value: string | null) => {
      input.remove()
      resolve(value)
    }
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return done(null)
      readLibraryFile(file, kind).then(done, (error) => {
        input.remove()
        reject(error instanceof Error ? error : new Error("Failed to read file"))
      })
    })
    input.addEventListener('cancel', () => done(null))
    document.body.appendChild(input)
    input.click()
  })
}

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Путь к внешнему редактору → файл, который реально можно запустить.
//
// ⚠️ Модуль ОДИН на проверку и на запуск. Раньше их было двое и они разошлись:
// кнопка «Проверить» звала fs.access, а он проходит и на ПАПКЕ — поэтому на
// macOS «/Applications/…app» получал бодрое «Программа найдена и доступна», а
// F2 потом падал со spawn EACCES. Ложное «всё в порядке» хуже честного отказа:
// человек ищет причину не там.
//
// На macOS программа — это не файл, а бандл: каталог «.app», внутри которого
// Contents/MacOS/<имя>. Его и запускаем.

export interface EditorTarget {
  /** Что передавать в spawn. */
  executable: string
  /** Чем это отличается от введённого пути; null — ничем. */
  resolvedFrom: string | null
}

export class EditorPathError extends Error {}

export interface EditorTargetDeps {
  platform?: NodeJS.Platform
  /** Имя исполняемого файла из Info.plist. Подменяется в тестах: plutil есть
   *  только на macOS, а тесты обязаны проходить и на Windows. */
  bundleExecutable?: (bundle: string) => Promise<string | null>
}

/** CFBundleExecutable из Info.plist. plutil читает и XML, и двоичный plist,
 *  и он есть на любой macOS — разбирать двоичный формат самим незачем. */
async function readBundleExecutable(bundle: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'plutil',
      ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')],
      { timeout: 5000, maxBuffer: 1_000_000 },
    )
    const parsed = JSON.parse(stdout) as { CFBundleExecutable?: unknown }
    return typeof parsed.CFBundleExecutable === 'string' && parsed.CFBundleExecutable
      ? parsed.CFBundleExecutable
      : null
  } catch {
    return null
  }
}

const isExecutableFile = async (file: string): Promise<boolean> => {
  const stats = await fs.stat(file).catch(() => null)
  if (!stats?.isFile()) return false
  return fs.access(file, fs.constants.X_OK).then(() => true, () => false)
}

/** Ищем исполняемый файл внутри бандла. Info.plist — основной путь; если его
 *  нет или он врёт, берём единственный исполняемый файл в Contents/MacOS. */
async function resolveBundle(bundle: string, deps: EditorTargetDeps): Promise<string> {
  const macOsDir = path.join(bundle, 'Contents', 'MacOS')
  const named = await (deps.bundleExecutable ?? readBundleExecutable)(bundle)
  if (named) {
    const candidate = path.join(macOsDir, named)
    if (await isExecutableFile(candidate)) return candidate
  }

  const entries = await fs.readdir(macOsDir).catch(() => null)
  if (!entries) {
    throw new EditorPathError('The selected macOS app has no Contents/MacOS folder')
  }
  const executables: string[] = []
  for (const entry of entries) {
    const candidate = path.join(macOsDir, entry)
    if (await isExecutableFile(candidate)) executables.push(candidate)
  }
  if (executables.length === 1) return executables[0]!
  throw new EditorPathError(
    executables.length === 0
      ? 'The macOS app contains no executable file'
      : 'The macOS app contains multiple executable files — provide the full path',
  )
}

export async function resolveEditorTarget(raw: string, deps: EditorTargetDeps = {}): Promise<EditorTarget> {
  const platform = deps.platform ?? process.platform
  const input = raw.trim()
  if (!input) throw new EditorPathError('Provide the application path')

  const stats = await fs.stat(input).catch(() => null)
  if (!stats) throw new EditorPathError(`File not found: ${input}`)

  if (stats.isFile()) {
    // На Windows бит исполняемости не хранится, проверять нечего.
    if (platform !== 'win32' && !(await isExecutableFile(input))) {
      throw new EditorPathError('This file cannot run because it lacks execute permission')
    }
    return { executable: input, resolvedFrom: null }
  }

  if (platform === 'darwin') {
    const executable = await resolveBundle(input, deps)
    return { executable, resolvedFrom: input }
  }

  // ⚠️ Раньше сюда приходило «ок»: fs.access на папке не возражает.
  throw new EditorPathError('This is a folder, not an application; provide the path to the application file')
}

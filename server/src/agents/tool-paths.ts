import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { AgentToolError, MAX_ARTIFACT_BYTES } from './tool-shared.js'

// Общие проверки путей и файлов для инструментов, которые трогают медиа Host
// (media.read, media.render). Одно место, а не копия в каждом инструменте:
// расхождение двух копий такой проверки — это дыра, а не неряшливость.
//
// ⚠️ Это НЕ песочница ОС. Проверки ловят выход из папки через «..», symlink и
// junction, но между проверкой и открытием файла остаётся обычное окно для
// процесса с правами пользователя.

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/u
export const CHECKSUM = /^[a-f0-9]{64}$/u

export interface FileDigest {
  checksum: string
  sizeBytes: number
}

/** Жёсткая ссылка. Подменяется в тестах: на exFAT и FAT ссылок нет вовсе. */
export type LinkFile = (existingPath: string, newPath: string) => Promise<void>

export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined
}

export function missing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

async function exists(file: string): Promise<boolean> {
  return fsp.lstat(file).then(() => true, (error) => {
    if (missing(error)) return false
    throw error
  })
}

/** SHA-256 и размер обычного файла. Ссылка, пустой и слишком большой файл — отказ. */
export async function digestFile(filePath: string): Promise<FileDigest> {
  const stat = await fsp.lstat(filePath).catch((error) => {
    if (missing(error)) throw new AgentToolError('REF_NOT_AVAILABLE', 'Native media file was not found')
    throw error
  })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) {
    throw new AgentToolError('FILE_INVALID', 'Native media file is empty, corrupt, or too large')
  }
  const hash = crypto.createHash('sha256')
  let sizeBytes = 0
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer
    sizeBytes += bytes.length
    if (sizeBytes > MAX_ARTIFACT_BYTES) throw new AgentToolError('FILE_INVALID', 'Native media file is too large')
    hash.update(bytes)
  }
  return { checksum: hash.digest('hex'), sizeBytes }
}

/**
 * Путь внутри `root`, на котором нет ни одной ссылки. Самого `target` может
 * ещё не быть — так проверяют место ДО того, как создать там папку: mkdir
 * сквозь junction создал бы её снаружи.
 */
export async function assertNoLinks(root: string, target: string, label: string): Promise<string> {
  const lexicalRoot = path.resolve(root)
  const lexicalTarget = path.resolve(target)
  const rootStat = await fsp.lstat(lexicalRoot).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (!rootStat) throw new AgentToolError('PATH_INVALID', `${label} is unavailable`)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new AgentToolError('PATH_INVALID', `${label} uses a symlink or junction`)
  }
  if (!inside(lexicalRoot, lexicalTarget)) throw new AgentToolError('PATH_INVALID', `${label} is outside the allowed folder`)

  let current = lexicalTarget
  // Сравниваем через relative, а не строками: на Windows пути одной папки
  // различаются регистром, и строгое равенство прошло бы мимо корня.
  while (path.relative(lexicalRoot, current) !== '') {
    const stat = await fsp.lstat(current).catch((error) => {
      if (missing(error)) return null
      throw error
    })
    if (stat?.isSymbolicLink()) throw new AgentToolError('PATH_INVALID', `${label} uses a symlink or junction`)
    const parent = path.dirname(current)
    if (parent === current || !inside(lexicalRoot, parent)) {
      throw new AgentToolError('PATH_INVALID', `${label} is outside the allowed folder`)
    }
    current = parent
  }
  return lexicalTarget
}

/**
 * Убедиться, что существующий `target` лежит внутри `root` и по дороге к нему
 * нет ни одной ссылки. Возвращает проверенный путь в том же написании, в каком
 * его дали: по нему же ищет индекс медиа.
 *
 * Корень обязан быть обычной папкой — junction на его месте отвергаем. А вот
 * ссылки ВЫШЕ корня не наше дело: /var → /private/var на macOS, короткие имена
 * 8.3 в %TEMP% и другой регистр буквы диска давали бы ложный отказ, если бы мы
 * сравнивали путь с realpath дословно.
 */
export async function assertSafeTree(root: string, target: string, label: string): Promise<string> {
  const lexicalRoot = path.resolve(root)
  const lexicalTarget = await assertNoLinks(root, target, label)
  const realRoot = await fsp.realpath(lexicalRoot).catch(() => '')
  const realTarget = await fsp.realpath(lexicalTarget).catch(() => '')
  if (!realRoot || !realTarget || !inside(realRoot, realTarget)) {
    throw new AgentToolError('PATH_INVALID', `${label} uses an external path`)
  }
  return lexicalTarget
}

/** Обычная подпапка первого уровня внутри проверенного корня: создать, если её нет. */
export async function ensureChildDirectory(root: string, name: string, label: string): Promise<string> {
  const next = path.join(root, name)
  await fsp.mkdir(next).catch((error) => {
    if (errorCode(error) !== 'EEXIST') throw error
  })
  const stat = await fsp.lstat(next)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AgentToolError('PATH_INVALID', `${label} uses a symlink or junction`)
  return assertSafeTree(root, next, label)
}

/**
 * Выставить готовый файл под итоговым именем, ничего не перетирая.
 *
 * Жёсткая ссылка атомарна и исключительна, поэтому она первая. На томах без
 * ссылок (exFAT и FAT на флешке, часть сетевых дисков) остаётся перенос: он
 * тоже атомарен, но перетирает молча — поэтому сначала смотрим, свободно ли
 * имя. Между томами не переносится ничего, тогда копируем во временное имя
 * рядом и переносим уже его: под итоговым именем никогда не лежит полфайла.
 *
 * ⚠️ На запасном пути `source` ПЕРЕЕЗЖАЕТ. Исходники так класть нельзя — для
 * них есть linkOrCopy.
 */
export async function placeExclusive(source: string, target: string, link: LinkFile = fsp.link): Promise<'placed' | 'exists'> {
  try {
    await link(source, target)
    return 'placed'
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return 'exists'
  }
  if (await exists(target)) return 'exists'
  try {
    await fsp.rename(source, target)
    return 'placed'
  } catch (error) {
    // Параллельный вызов успел занять имя между проверкой и переносом: на
    // Windows перенос поверх только что созданного файла отвечает EPERM.
    if (await exists(target)) return 'exists'
    if (errorCode(error) !== 'EXDEV') throw error
  }
  const staged = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`
  try {
    await fsp.copyFile(source, staged)
    if (await exists(target)) return 'exists'
    await fsp.rename(staged, target)
    return 'placed'
  } finally {
    await fsp.unlink(staged).catch(() => undefined)
  }
}

/** Положить рядом копию исходника: ссылкой, а где ссылок нет — настоящей
 *  копией. Исходник не трогаем; занятое имя — error, а не «уже есть». */
export async function linkOrCopy(source: string, target: string, link: LinkFile = fsp.link): Promise<void> {
  try {
    await link(source, target)
    return
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw error
  }
  await fsp.copyFile(source, target, fsp.constants.COPYFILE_EXCL)
}

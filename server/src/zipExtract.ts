import { inflateRawSync } from 'node:zlib'

// Минимальный читатель ZIP: нужен ровно затем, чтобы достать пару файлов из
// архива ffmpeg. Отдельной библиотеки ради этого не тащим, а PowerShell
// Expand-Archive не годится — приложение обязано оставаться папкой, которая
// работает сама по себе, без внешних команд и политик выполнения.
//
// Умышленно строгий: всё, чего не понимаем (ZIP64, шифрование, незнакомый
// метод сжатия), — ошибка с внятным текстом, а не молчаливо кривой файл.
// Битый ffmpeg.exe диагностировать потом куда дороже, чем отказ на месте.

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
const ZIP64_MARKER = 0xffffffff

export interface ZipEntry {
  name: string
  compressedSize: number
  uncompressedSize: number
  method: number
  localHeaderOffset: number
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // Комментарий архива может быть до 64 КБ, поэтому запись ищем с конца.
  const earliest = Math.max(0, zip.length - EOCD_MIN_SIZE - 0xffff)
  for (let at = zip.length - EOCD_MIN_SIZE; at >= earliest; at--) {
    if (zip.readUInt32LE(at) === EOCD_SIGNATURE) return at
  }
  throw new Error('Archive is corrupted: end-of-central-directory record not found')
}

export function listZipEntries(zip: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(zip)
  const total = zip.readUInt16LE(eocd + 10)
  const directorySize = zip.readUInt32LE(eocd + 12)
  const directoryOffset = zip.readUInt32LE(eocd + 16)
  if (directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER || total === 0xffff) {
    throw new Error('ZIP64 archives are not supported')
  }

  const entries: ZipEntry[] = []
  let at = directoryOffset
  for (let index = 0; index < total; index++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new Error('Archive is corrupted: failed to read the file catalog')
    }
    const flags = zip.readUInt16LE(at + 8)
    if (flags & 0x0001) throw new Error('Encrypted archives are not supported')
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    entries.push({
      name: zip.toString('utf8', at + 46, at + 46 + nameLength),
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      uncompressedSize: zip.readUInt32LE(at + 24),
      localHeaderOffset: zip.readUInt32LE(at + 42),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export function readZipEntry(zip: Buffer, entry: ZipEntry): Buffer {
  const header = entry.localHeaderOffset
  if (header + 30 > zip.length || zip.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new Error(`Archive is corrupted: missing file header ${entry.name}`)
  }
  // Длины имени и extra берём из ЛОКАЛЬНОГО заголовка: в каталоге они могут
  // отличаться, и по каталожным данные читались бы со сдвигом.
  const nameLength = zip.readUInt16LE(header + 26)
  const extraLength = zip.readUInt16LE(header + 28)
  const start = header + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > zip.length) throw new Error(`Archive is corrupted: file ${entry.name} is truncated`)

  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`Unknown compression method (${entry.method}) for file ${entry.name}`)
  }
  const raw = zip.subarray(start, end)
  let data: Buffer
  try {
    data = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
  } catch {
    // Сырое сообщение zlib («invalid code lengths set») ничего не говорит тому,
    // кто просто нажал «Скачать»: причина всегда одна — доехало не то.
    throw new Error(`Could not extract ${entry.name}: archive is corrupted`)
  }
  if (data.length !== entry.uncompressedSize) {
    throw new Error(`File ${entry.name} was not fully extracted`)
  }
  return data
}

/** Достать файлы по имени БЕЗ пути: в архивах ffmpeg всё лежит внутри папки
 *  с версией в названии, и знать её заранее нельзя. */
export function extractByBaseName(zip: Buffer, wanted: readonly string[]): Map<string, Buffer> {
  const want = new Set(wanted.map((name) => name.toLowerCase()))
  const found = new Map<string, Buffer>()
  for (const entry of listZipEntries(zip)) {
    if (entry.name.endsWith('/')) continue
    const base = entry.name.split('/').pop()?.toLowerCase() ?? ''
    if (!want.has(base) || found.has(base)) continue
    found.set(base, readZipEntry(zip, entry))
  }
  return found
}

import { createWriteStream } from 'node:fs'
import { extForMime } from './mediaTypes'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { config } from './config.js'
import { downloadCandidates, isNetworkError } from './falCdn.js'
import { downloadRemoteMedia, openSafeRemote, UploadTooLargeError } from './safeRemote.js'
import { mediaFileName, mediaWritePath, resolveMediaIn, resolveMediaInAsync } from './mediaLayout.js'

export { UploadTooLargeError } from './safeRemote.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function ensureMediaDir(): Promise<void> {
  await fs.mkdir(config.mediaDir, { recursive: true })

  // Возвращаем файлы из кратковременно использовавшегося корневого output/.
  // Коллизии не перетираем и не скрываем: оба пользовательских файла остаются.
  let files: string[]
  try {
    files = await fs.readdir(config.legacyMediaDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  let collisions = 0
  for (const file of files) {
    const oldPath = path.join(config.legacyMediaDir, file)
    const newPath = path.join(config.mediaDir, file)
    try {
      await fs.access(newPath)
      collisions++
      continue
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    try {
      await fs.rename(oldPath, newPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      await fs.copyFile(oldPath, newPath)
      await fs.unlink(oldPath)
    }
  }
  const remaining = await fs.readdir(config.legacyMediaDir)
  if (remaining.length === 0) await fs.rmdir(config.legacyMediaDir)
  if (collisions > 0) {
    console.warn(`[CanAI] media: ${collisions} files from output/ were not moved because of duplicate names`)
  }
}

/** Путь на диске для ссылки /media/…
 *
 * basename отрезает любые попытки выйти из папки медиа, а строку запроса
 * срезаем ДО разбора пути: у картинок из внешнего редактора src приходит с
 * ?v=<mtime> (сброс кэша браузера), и без среза расширением становилось бы
 * «png?v=123». Это общий инвариант проекта, поэтому функция одна на всех. */
export function mediaFilePath(src: string): string {
  const name = mediaFileName(src)
  // Сначала там, где файл ДОЛЖЕН лежать по раскладке, потом в корне: в корне
  // остаются файлы, записанные до раскладки, и те, чей перенос не удался
  // (занятое имя, файл открыт другой программой). Старые ссылки от раскладки
  // не портятся — в них по-прежнему только имя.
  return resolveMediaIn(config.mediaDir, name)
}

/** Асинхронная версия для запросных обработчиков: не блокирует event loop
 *  пересборкой индекса media на промахе. */
export async function mediaFilePathAsync(src: string): Promise<string> {
  const name = mediaFileName(src)
  return resolveMediaInAsync(config.mediaDir, name)
}

export function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl)
  if (!match) throw new Error('data not in format data-URL')
  return { buffer: Buffer.from(match[2], 'base64'), mime: match[1] }
}

export async function saveBuffer(
  buffer: Buffer,
  mime: string,
  baseName: string,
): Promise<{ url: string; mime: string }> {
  const ext = extForMime(mime)
  const fileName = `${baseName}.${ext}`
  const finalPath = await mediaWritePath(fileName)
  // tmp+rename: обрыв записи не оставляет в media битого файла
  await fs.writeFile(`${finalPath}.tmp`, buffer)
  await fs.rename(`${finalPath}.tmp`, finalPath)
  return { url: `/media/${fileName}`, mime }
}

const MAX_REMOTE_BYTES = 512 * 1024 * 1024

const MAX_BUFFER_REMOTE_BYTES = 64 * 1024 * 1024 // маски/превью — не 512 МБ
const BUFFER_REMOTE_TIMEOUT_MS = 60_000

/** Скачать HTTPS-URL в Buffer с SSRF-guard (без записи на диск). */
export async function fetchSafeBuffer(url: string, maxBytes = MAX_BUFFER_REMOTE_BYTES): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BUFFER_REMOTE_TIMEOUT_MS)
  timer.unref()
  try {
    const { response: res } = await openSafeRemote(url, {
      signal: controller.signal,
      timeoutMs: BUFFER_REMOTE_TIMEOUT_MS,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} when download`)
    const length = Number(res.headers.get('content-length') ?? 0)
    if (Number.isFinite(length) && length > maxBytes) throw new UploadTooLargeError('file too large')
    const arrayBuffer = await res.arrayBuffer()
    if (arrayBuffer.byteLength > maxBytes) throw new UploadTooLargeError('file too large')
    return Buffer.from(arrayBuffer)
  } finally {
    clearTimeout(timer)
  }
}

// Загрузка ПОТОКОМ прямо на диск: 512-МБ видео больше не собирается в памяти
// целиком (раньше express.raw держал весь Buffer — пара параллельных загрузок
// могла уронить процесс по памяти)
export async function saveStream(
  source: Readable,
  mime: string,
  baseName: string,
  maxBytes: number,
): Promise<{ url: string; mime: string }> {
  const ext = extForMime(mime)
  const fileName = `${baseName}.${ext}`
  const finalPath = await mediaWritePath(fileName)
  const tmpPath = `${finalPath}.tmp`

  let received = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      if (received > maxBytes) cb(new UploadTooLargeError('file too large'))
      else cb(null, chunk)
    },
  })
  try {
    await pipeline(source, limiter, createWriteStream(tmpPath))
    if (received === 0) throw new Error('empty file')
    await fs.rename(tmpPath, finalPath)
    return { url: `/media/${fileName}`, mime }
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {})
    throw err
  }
}

async function downloadOnce(url: string, baseName: string): Promise<{ url: string; mime: string }> {
  const result = await downloadRemoteMedia({
    url,
    mediaDir: config.mediaDir,
    baseName,
    maxBytes: MAX_REMOTE_BYTES,
  })
  return { url: result.url, mime: result.mime }
}

const DOWNLOAD_ATTEMPTS = 3

// Результат УЖЕ ОПЛАЧЕН, поэтому одна сетевая осечка не должна его хоронить:
// повторяем, а на заблокированном хосте CDN пробуем зеркало (см. falCdn.ts —
// v3/v3b это одни и те же серверы, режется имя в TLS, а не маршрут).
export async function saveFromUrl(url: string, baseName: string): Promise<{ url: string; mime: string }> {
  const [primary, mirror] = downloadCandidates(url)
  let lastErr: unknown
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await downloadOnce(primary, baseName)
    } catch (err) {
      lastErr = err
      // размер и явный отказ сервера повторять бессмысленно — это не «не дошло»
      if (err instanceof UploadTooLargeError || !isNetworkError(err)) throw err
    }

    // основной адрес не отозвался — пробуем зеркало. Его отказ (например 404,
    // если зеркало не отдаёт этот путь) НЕ повод сдаваться: следующий заход
    // снова пойдёт по основному, который мог просто моргнуть.
    if (mirror) {
      try {
        return await downloadOnce(mirror, baseName)
      } catch (err) {
        if (err instanceof UploadTooLargeError) throw err
      }
    }

    if (attempt < DOWNLOAD_ATTEMPTS - 1) await sleep(1000 + attempt * 2000)
  }
  throw lastErr
}

function jpegExifOrientation(segment: Buffer): number | null {
  if (segment.length < 14 || segment.toString('ascii', 0, 6) !== 'Exif\0\0') return null
  const tiff = segment.subarray(6)
  const byteOrder = tiff.toString('ascii', 0, 2)
  if (byteOrder !== 'II' && byteOrder !== 'MM') return null
  const u16 = (offset: number) => byteOrder === 'II' ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset)
  const u32 = (offset: number) => byteOrder === 'II' ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset)
  if (u16(2) !== 42) return null
  const ifd = u32(4)
  if (ifd < 8 || ifd + 2 > tiff.length) return null
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > tiff.length) return null
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
      const orientation = u16(entry + 8)
      return orientation >= 1 && orientation <= 8 ? orientation : null
    }
  }
  return null
}

export function probeMediaBufferDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    if (width > 0 && height > 0) return { width, height }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2
    let orientation = 1
    let size: { width: number; height: number } | null = null
    while (pos + 4 <= buf.length) {
      if (buf[pos] !== 0xff) break
      const marker = buf[pos + 1]
      if (marker === 0xff) { pos++; continue }
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue }
      const len = buf.readUInt16BE(pos + 2)
      if (len < 2 || pos + 2 + len > buf.length) break
      if (marker === 0xe1) {
        orientation = jpegExifOrientation(buf.subarray(pos + 4, pos + 2 + len)) ?? orientation
      }
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xcf)) {
        if (marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && len >= 7) {
          const height = buf.readUInt16BE(pos + 5)
          const width = buf.readUInt16BE(pos + 7)
          if (width > 0 && height > 0) size = { width, height }
        }
      }
      pos += 2 + len
    }
    // Как naturalWidth/naturalHeight браузера: EXIF 5–8 меняет оси местами.
    if (size) return orientation >= 5 ? { width: size.height, height: size.width } : size
  }
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58 && buf.length >= 30) {
      const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1
      const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1
      if (width > 0 && height > 0) return { width, height }
    }
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4c && buf.length >= 25) {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24]
      const width = 1 + (((b1 & 0x3f) << 8) | b0)
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      if (width > 0 && height > 0) return { width, height }
    }
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20 && buf.length >= 30) {
      const width = (buf.readUInt16LE(26) & 0x3fff)
      const height = (buf.readUInt16LE(28) & 0x3fff)
      if (width > 0 && height > 0) return { width, height }
    }
  }
  return null
}

export function probeLocalMediaDimensions(src?: string): { width: number; height: number } | null {
  if (!src) return null
  try {
    if (src.startsWith('data:image/')) {
      const comma = src.indexOf(',')
      if (comma !== -1) {
        const base64 = src.slice(comma + 1)
        const buf = Buffer.from(base64, 'base64')
        return probeMediaBufferDimensions(buf)
      }
    }
    if (src.startsWith('/media/')) {
      // ?v=<mtime> дописывается к картинкам из внешнего редактора — без среза
      // basename давал «edit-a.png?v=1», файл не открывался и размеры молча
      // терялись. Так же поступают refs.ts, fal.ts, editSessions.ts, routes.ts
      // Путь ищет раскладка: имя одно, а папка на диске у него своя
      const filePath = mediaFilePath(src)
      const fd = fsSync.openSync(filePath, 'r')
      // EXIF/ICC перед SOF часто больше прежних 4 КБ. Читаем ограниченный
      // заголовок, а не весь медиа-файл, и закрываем fd даже при ошибке чтения.
      const buf = Buffer.alloc(256 * 1024)
      let bytesRead: number
      try {
        bytesRead = fsSync.readSync(fd, buf, 0, buf.length, 0)
      } finally {
        fsSync.closeSync(fd)
      }
      if (bytesRead > 0) {
        return probeMediaBufferDimensions(buf.subarray(0, bytesRead))
      }
    }
  } catch {
    // игнорируем ошибки чтения заголовков
  }
  return null
}

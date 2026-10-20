import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const MAX_PREVIEW_EDGE = 1920

/**
 * Ступени размера превью.
 *
 * ⚠️ Превью «до 1920» само по себе память планшета не спасает: декод
 * 1920×1920 — это ~14 МБ ОЗУ на КАЖДУЮ картинку, сколько бы пикселей она ни
 * занимала на экране. При «Показать всё» большой доски в кадре все объекты
 * разом, и вкладка на айпаде умирает по памяти (белый экран — это Safari
 * после jetsam). Поэтому клиент просит превью под ФАКТИЧЕСКИЙ размер на
 * экране, а сервер режет запрос к одной из ступеней: 300-пиксельная карточка
 * декодит ~0,3 МБ вместо 14, а кэш не пух — на каждый источник максимум по
 * файлу на ступень.
 */
export const PREVIEW_EDGE_STEPS = [256, 512, 1024, 1920] as const

/** Ближайшая ступень сверху: 300 → 512, 700 → 1024, 2500 → 1920, мусор → 1920. */
export function previewEdgeStep(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return MAX_PREVIEW_EDGE
  for (const step of PREVIEW_EDGE_STEPS) {
    if (requested <= step) return step
  }
  return MAX_PREVIEW_EDGE
}

const pending = new Map<string, Promise<string>>()

function previewName(sourceFile: string, size: number, modifiedAt: number, maxEdge: number): string {
  const fingerprint = createHash('sha256')
    .update(sourceFile)
    .update('\0')
    .update(String(size))
    .update('\0')
    .update(String(Math.floor(modifiedAt)))
    .update('\0')
    .update(String(maxEdge))
    .digest('base64url')
  return `${fingerprint}.webp`
}
/**
 * Создаёт переносимое экранное превью рядом с data/media. Оригинал не меняется,
 * а повторные публикации и гости используют один и тот же кэшированный файл.
 * `maxEdge` приходит уже ступенью (previewEdgeStep) — иначе кэш разрастался бы
 * произвольными размерами.
 */
export async function ensureShareImagePreview(input: {
  sourceFile: string
  previewDir: string
  maxEdge?: number
}): Promise<string> {
  const maxEdge = input.maxEdge === undefined ? MAX_PREVIEW_EDGE : previewEdgeStep(input.maxEdge)
  const stat = await fs.stat(input.sourceFile)
  if (!stat.isFile()) throw new Error('Source media unavailable')
  const output = path.join(input.previewDir, previewName(input.sourceFile, stat.size, stat.mtimeMs, maxEdge))
  const existing = await fs.stat(output).catch(() => null)
  if (existing?.isFile() && existing.size > 0) return output

  const running = pending.get(output)
  if (running) return running
  const operation = (async () => {
    await fs.mkdir(input.previewDir, { recursive: true })
    const temporary = `${output}.${process.pid}.${Date.now()}.tmp`
    try {
      await sharp(input.sourceFile, { failOn: 'error' })
        .rotate()
        .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78, effort: 4 })
        .toFile(temporary)
      await fs.rename(temporary, output).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      return output
    } finally {
      await fs.rm(temporary, { force: true, maxRetries: 8, retryDelay: 25 }).catch(() => undefined)
    }
  })()
  pending.set(output, operation)
  try {
    return await operation
  } finally {
    pending.delete(output)
  }
}

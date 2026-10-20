import fs from 'node:fs/promises'
import { mimeForExt } from './mediaTypes'
import path from 'node:path'
import { uploadToFal } from './fal.js'
import { dataUrlToBuffer, mediaFilePath } from './storage.js'
import { imageRefForModel } from './refImageFormat.js'

// Референсы, приходящие с канваса: картинки/видео (локальный /media-файл или
// data-URI от перетащенных на канвас изображений) и тексты.
export interface IncomingRef {
  kind: 'image' | 'video' | 'audio' | 'text'
  src?: string
  text?: string
  width?: number
  height?: number
  // роль референса для моделей с именованными входами (Ideogram:
  // image_url/mask_url/reference_image_urls) — ставит клиент по порту ноды
  role?: string
}

export interface ResolvedRefs {
  imageUrls: string[]
  videoUrls: string[]
  audioUrls: string[]
  textParts: string[]
}


async function readMediaFile(src: string): Promise<{ buffer: Buffer; mime: string }> {
  const file = mediaFilePath(src)
  const buffer = await fs.readFile(file)
  const ext = path.basename(file).split('.').pop()?.toLowerCase() ?? ''
  return { buffer, mime: mimeForExt(ext) }
}

// Картинки/видео-референсы загружаются в хранилище fal (модели требуют URL),
// тексты просто собираются в список.
export async function resolveRefs(
  refs: IncomingRef[],
  onProgress: (text: string) => void,
): Promise<ResolvedRefs> {
  const imageUrls: string[] = []
  const videoUrls: string[] = []
  const audioUrls: string[] = []
  const textParts: string[] = []

  const mediaRefs = refs.filter((r) => r.kind === 'image' || r.kind === 'video' || r.kind === 'audio')
  let uploaded = 0

  for (const ref of refs) {
    if (ref.kind === 'text' && ref.text) {
      textParts.push(ref.text)
      continue
    }
    if ((ref.kind !== 'image' && ref.kind !== 'video' && ref.kind !== 'audio') || !ref.src) continue

    onProgress(`loading references (${++uploaded}/${mediaRefs.length})…`)
    const { buffer, mime } = ref.src.startsWith('data:')
      ? dataUrlToBuffer(ref.src)
      : await readMediaFile(ref.src)
    const upload = ref.kind === 'image'
      ? await imageRefForModel(buffer, mime)
      : { data: buffer, mime }
    const url = await uploadToFal(upload.data, upload.mime)
    if (ref.kind === 'video') videoUrls.push(url)
    else if (ref.kind === 'audio') audioUrls.push(url)
    else imageUrls.push(url)
  }

  return { imageUrls, videoUrls, audioUrls, textParts }
}

// Для LLM (текст): выделенный текст с канваса — явный «контекст», отдельным
// блоком. Модель чата понимает разметку и разделяет свой ответ от контекста.
export function withTextContext(prompt: string, textParts: string[]): string {
  if (textParts.length === 0) return prompt
  return `${prompt}\n\nAdditional context:\n${textParts.map((t) => `— ${t}`).join('\n')}`
}

// Для картинок/видео: выделенный текст с канваса просто ДОПИСЫВАЕТ промпт
// (пользователь пишет начало в промпт-баре, текст с канваса его заканчивает).
// Без обёртки «контекст» — модели картинок/видео не понимают такую разметку,
// она попадёт в кадр буквально как текст.
export function withTextSuffix(prompt: string, textParts: string[]): string {
  if (textParts.length === 0) return prompt
  return [prompt.trim(), ...textParts.map((t) => t.trim())].filter(Boolean).join(' ')
}

// Inline-ссылки на референсы. Клиент вставляет нейтральные токены @1, @2… по
// ПОРЯДКУ медиа-референсов (картинки/видео). Здесь переводим их в реальный
// синтаксис модели (сверено по openapi 2026-07-14):
//   'gemini'   → <IMAGE_REF_0> (0-based, только картинки; видео тегами не адресуются)
//   'seedance' → @Image1 / @Video1 (1-based, раздельно по модальностям)
//    null      → модель ссылок не понимает: токен убираем, чтобы «@1» не попал в кадр
// Нумерация media СОВПАДАЕТ с порядком в image_urls/video_urls (тот же обход refs).
export function applyRefTags(
  prompt: string,
  refs: IncomingRef[],
  style: 'gemini' | 'seedance' | null,
): string {
  const byGlobal = new Map<number, string>() // @n (1-based среди media) → замена
  let global = 0
  let img = 0
  let vid = 0
  let audio = 0
  for (const r of refs) {
    if (r.kind !== 'image' && r.kind !== 'video' && r.kind !== 'audio') continue
    global++
    if (r.kind === 'image') {
      const i0 = img++
      byGlobal.set(global, style === 'gemini' ? `<IMAGE_REF_${i0}>` : style === 'seedance' ? `@Image${i0 + 1}` : '')
    } else if (r.kind === 'video') {
      const v0 = vid++
      // у gemini reference-to-video видео нет — нейтрализуем (пустая строка)
      byGlobal.set(global, style === 'seedance' ? `@Video${v0 + 1}` : '')
    } else {
      const a0 = audio++
      byGlobal.set(global, style === 'seedance' ? `@Audio${a0 + 1}` : '')
    }
  }
  return prompt
    .replace(/@(\d+)/g, (whole, num) => {
      const n = Number(num)
      return byGlobal.has(n) ? byGlobal.get(n)! : whole // чужой номер — не трогаем
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// Разбор референсов, пришедших от клиента. Живёт здесь, а не в routes: тем же
// разбором пользуется запуск макроса, а правила тут не косметические —
// видео и звук принимаются ТОЛЬКО ссылкой на файл (инлайн раздул бы запрос),
// путь с «..» не проходит вовсе.
const MAX_REFS = 16
const MAX_IMAGE_SRC = 30_000_000 // ~22 МБ картинки в base64
const MAX_REF_TEXT = 8000
const MAX_ASSET_DATAURL = 45_000_000 // ~33 МБ файла в base64

export function parseRefs(raw: unknown): IncomingRef[] | null {
  if (raw == null) return []
  if (!Array.isArray(raw) || raw.length > MAX_REFS) return null

  const refs: IncomingRef[] = []
  for (const item of raw as Array<{ kind?: unknown; src?: unknown; text?: unknown; width?: unknown; height?: unknown; role?: unknown }>) {
    // роль порта (Ideogram: image_url/mask_url/reference_image_urls) — короткая строка
    const role = typeof item.role === 'string' && item.role.length <= 64 ? item.role : undefined
    if (item?.kind === 'image' && typeof item.src === 'string' && item.src.length <= MAX_IMAGE_SRC) {
      if (
        !item.src.startsWith('/media/')
        && !item.src.startsWith('data:image/')
        && !false
      ) return null
      if (item.src.includes('..')) return null
      const width = typeof item.width === 'number' ? item.width : undefined
      const height = typeof item.height === 'number' ? item.height : undefined
      refs.push({ kind: 'image', src: item.src, width, height, role })
    } else if (item?.kind === 'video' && typeof item.src === 'string') {
      // видео-референс — только уже загруженным файлом (никаких data-URI: видео
      // большое, инлайн раздул бы запрос)
      if (
        (!item.src.startsWith('/media/') && !false)
        || item.src.includes('..')
      ) return null
      const width = typeof item.width === 'number' ? item.width : undefined
      const height = typeof item.height === 'number' ? item.height : undefined
      refs.push({ kind: 'video', src: item.src, width, height, role })
    } else if (item?.kind === 'audio' && typeof item.src === 'string') {
      if (
        (!item.src.startsWith('/media/') && !false)
        || item.src.includes('..')
      ) return null
      refs.push({ kind: 'audio', src: item.src, role })
    } else if (item?.kind === 'text' && typeof item.text === 'string' && item.text.trim()) {
      refs.push({ kind: 'text', text: item.text.slice(0, MAX_REF_TEXT) })
    } else {
      return null
    }
  }
  return refs
}

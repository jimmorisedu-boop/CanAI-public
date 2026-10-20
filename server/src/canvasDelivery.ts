import { randomUUID } from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'
import { boardBusy, boardHolder, presenceWarmingUp } from './boardPresence.js'
import type { Job } from './jobs.js'
import { mutateProjectSnapshot } from './projects.js'
import { mediaFilePathAsync } from './storage.js'

// Результат генерации кладёт СЕРВЕР, когда доску не держит ни одно устройство.
//
// Обычный путь остаётся прежним: доска открыта — её клиент и ставит результат
// на место заглушки. Этот модуль нужен для случая «запустил и закрыл»: ноутбук
// захлопнули, планшет заснул, а генерация доработала и оплачена. Раньше она
// просто ждала, пока доску кто-нибудь откроет.
//
// ПРАВИЛО, которое здесь главное: пока за доской кто-то сидит, сервер её НЕ
// трогает. Иначе два писателя поставят два объекта на одно место или доска
// уедет в конфликтную копию. Занятость проверяется перед каждой попыткой, а
// повторы даёт общий механизм доставки (15с / 1мин / 5мин / 30мин).

export interface CanvasJobTarget {
  kind: 'canvas'
  projectId: string
  placeholderId: string
  /** Нет у старых jobs.json и означает local. */
  source?: 'local'
}

export function isCanvasTarget(target: Job['target']): target is CanvasJobTarget {
  return target?.kind === 'canvas'
}

/** Доску держит устройство — доставку откладываем, а не делаем. */
export class BoardBusyError extends Error {
  /** `null` — сервер только что запущен и ещё не знает, где открыта доска. */
  constructor(device: string | null) {
    super(device === null
      ? 'server just started; waiting for open boards to check in'
      : `Board is open on “${device}”; it will place the result`)
  }
}

const AUDIO_ITEM_WIDTH = 320
const AUDIO_ITEM_HEIGHT = 96

function shortName(prompt: string): string {
  const cleaned = prompt.trim().replace(/\s+/g, ' ')
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned || 'result'
}

/** Натуральный размер результата или null, если измерить нечем. */
async function naturalSize(
  url: string,
  result: { width?: number; height?: number },
): Promise<{ width: number; height: number } | null> {
  if (result.width && result.height) return { width: result.width, height: result.height }
  // Картинку можем измерить сами — sharp уже стоит ради экранных превью.
  // Видео измерять нечем (ffprobe есть не у всех), и это не беда: пропорции
  // заглушки посчитаны по той же модели, что и результат.
  try {
    const file = await mediaFilePathAsync(path.basename(url.split('?')[0]))
    const meta = await sharp(file).metadata()
    if (meta.width && meta.height) return { width: meta.width, height: meta.height }
  } catch {
    // не картинка или файл недоступен
  }
  return null
}

interface SnapshotShape {
  items?: Array<Record<string, unknown>>
  archive?: Array<Record<string, unknown>>
  pending?: Array<Record<string, unknown>>
  [key: string]: unknown
}

/**
 * Поставить результат на доску вместо заглушки.
 *
 * Возвращает `false`, если ставить было нечего (заглушку убрали руками или
 * объект уже поставил открытый клиент) — это не ошибка, а обычный исход.
 */
export async function deliverCanvasJob(job: Job, target: CanvasJobTarget): Promise<boolean> {
  if (job.status !== 'done' || (!job.result?.url && !job.result?.text)) return false

  if (presenceWarmingUp()) throw new BoardBusyError(null)

  // Занята — значит доска где-то открыта, пусть даже в свёрнутой вкладке:
  // такой клиент по-прежнему сохраняет холст, и запись под ним отправила бы
  // его в конфликтную копию.
  if (boardBusy(target.projectId)) {
    throw new BoardBusyError(boardHolder(target.projectId)?.device ?? 'another device')
  }

  // Размер читаем ДО замка: чтение файла с диска может занять заметное время,
  // а держать на нём критическую секцию доски незачем.
  const size = job.result.url ? await naturalSize(job.result.url, job.result) : null

  const outcome = await mutateProjectSnapshot(target.projectId, (raw) => {
    if (boardBusy(target.projectId)) {
      throw new BoardBusyError(boardHolder(target.projectId)?.device ?? 'another device')
    }
    const snapshot = (raw ?? {}) as SnapshotShape
    const items = Array.isArray(snapshot.items) ? [...snapshot.items] : []
    const archive = Array.isArray(snapshot.archive) ? snapshot.archive : []
    const pending = Array.isArray(snapshot.pending) ? [...snapshot.pending] : []
    // Клиент успел раньше — второго такого же объекта доске не нужно.
    if (items.some((item) => item.sourceJobId === job.id)
      || archive.some((item) => item.sourceJobId === job.id)) return null
    const slot = pending.find((entry) => entry.jobId === job.id || entry.id === target.placeholderId)
    // Заглушки нет — но результат ОПЛАЧЕН, и терять его нельзя.
    //
    // Так бывает, когда страницу закрыли раньше, чем автосейв успел записать
    // спиннер (поймано живым прогоном: макрос доработал, а встать было некуда).
    // Кладём рядом с тем, что уже есть: место хуже, чем задумывалось, всё
    // равно лучше исчезнувшей картинки.
    const box = slot ?? freeSpotFor(items, size)
    return {
      ...snapshot,
      items: [...items, placedItem(job, box, size)],
      pending: slot ? pending.filter((entry) => entry !== slot) : pending,
    }
  })
  if (outcome === 'not-found') throw new Error('Board unavailable for result delivery')
  return outcome === 'saved'
}


const FALLBACK_WIDTH = 440
const GAP = 60

/**
 * Куда положить результат, если заглушки не нашлось.
 *
 * Правее всего, что уже лежит на доске, по верхней кромке — так объект точно
 * ни на что не наедет и его видно рядом с остальным материалом.
 */
export function freeSpotFor(
  items: Array<Record<string, unknown>>,
  size: { width: number; height: number } | null,
): Record<string, unknown> {
  const ratio = size && size.width > 0 ? size.height / size.width : 1
  const width = FALLBACK_WIDTH
  const height = Math.max(40, Math.round(width * ratio))
  let right = 0
  let top = 0
  let found = false
  for (const item of items) {
    const x = Number(item.x)
    const y = Number(item.y)
    const w = Number(item.w)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w)) continue
    right = found ? Math.max(right, x + w) : x + w
    top = found ? Math.min(top, y) : y
    found = true
  }
  return { x: found ? right + GAP : 0, y: found ? top : 0, w: width, h: height }
}

export function placedItem(
  job: Job,
  slot: Record<string, unknown>,
  size: { width: number; height: number } | null,
): Record<string, unknown> {
  const box = {
    x: Number(slot.x) || 0,
    y: Number(slot.y) || 0,
    w: Number(slot.w) || 512,
    h: Number(slot.h) || 512,
  }
  const mime = job.result?.mime ?? 'image/jpeg'
  const isVideo = mime.startsWith('video/')
  const isAudio = mime.startsWith('audio/')
  const common = {
    id: randomUUID(),
    src: job.result?.url,
    mime,
    name: shortName(job.prompt),
    prompt: typeof slot.prompt === 'string' ? slot.prompt : job.prompt,
    modelId: slot.modelId,
    referenceIds: slot.referenceIds,
    sourceJobId: job.id,
  }
  if (!job.result?.url && job.result?.text) {
    return {
      id: common.id,
      kind: 'text',
      text: job.result.text,
      name: 'text',
      prompt: common.prompt,
      sourceJobId: job.id,
      fontSize: 15,
      ...box,
    }
  }
  if (isAudio) {
    // У звука пропорций нет: плашка встаёт по нижней кромке заглушки — ровно
    // так же, как это делает клиент.
    return {
      ...common,
      kind: 'audio',
      x: box.x,
      y: box.y + box.h - AUDIO_ITEM_HEIGHT,
      w: AUDIO_ITEM_WIDTH,
      h: AUDIO_ITEM_HEIGHT,
    }
  }
  // Не измерили — оставляем размеры заглушки: её пропорции считались по той
  // же модели, что и результат (estimatedAspectRatio), так что промах будет
  // небольшим, а объект окажется на доске.
  const height = size ? Math.max(40, Math.round((box.w * size.height) / size.width)) : box.h
  return {
    ...common,
    kind: isVideo ? 'video' : 'image',
    // Низ ряда держится — иначе результат прыгнет относительно соседей.
    x: box.x,
    y: box.y + box.h - height,
    w: box.w,
    h: height,
    ...(size ? { naturalWidth: size.width, naturalHeight: size.height } : {}),
  }
}

import type { CanvasItem } from './types'
import { log } from '../../../diag/log'

/**
 * Копирование картинки с холста в СИСТЕМНЫЙ буфер — чтобы её можно было
 * вставить в Photoshop, письмо или мессенджер.
 *
 * ⚠️ Наш собственный буфер этим не заменяется, а дополняется. Внутри
 * приложения Ctrl+V вставляет объекты целиком (с промптом, моделью, метками),
 * и опознаёт их метка в системном буфере (см. pasteDecision). Поэтому в буфер
 * кладутся ОБА представления одним элементом: `image/png` для чужих программ и
 * `text/plain` с меткой для нас. Положишь только картинку — сломается вставка
 * внутри приложения; положишь только метку — картинку не примет никто снаружи.
 *
 * ⚠️ Только PNG. Chrome разрешает записывать в буфер лишь `image/png` (и SVG),
 * поэтому JPEG и WebP перерисовываются. Видео и звук системный буфер не
 * принимает вовсе — для них копирование остаётся внутренним.
 */

/** Что из выделения можно отдать другой программе. */
export function clipboardImageSource(items: readonly CanvasItem[]): CanvasItem | null {
  // Системный буфер держит ОДИН элемент, поэтому из нескольких картинок берём
  // первую: класть последнюю значило бы отдать не то, на что человек смотрит.
  return items.find((item) => item.kind === 'image' && Boolean(item.src)) ?? null
}

export function needsPngConversion(mime: string | undefined): boolean {
  return (mime ?? '').toLowerCase() !== 'image/png'
}

interface ClipboardDeps {
  fetch?: typeof fetch
  toPng?(blob: Blob): Promise<Blob>
  write?(items: ClipboardItem[]): Promise<void>
  /**
   * Запись, которая должна лечь в буфер РАНЬШЕ картинки (наша метка текстом).
   * Картинка ждёт её: придя первой, она была бы перетёрта текстом.
   */
  after?: Promise<unknown>
}

async function repaintAsPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable')
    context.drawImage(bitmap, 0, 0)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!png) throw new Error('Failed to redraw the image')
    return png
  } finally {
    bitmap.close()
  }
}

/**
 * Положить картинку в системный буфер вместе с меткой нашего буфера.
 *
 * ⚠️ Блоб уходит в ClipboardItem ПРОМИСОМ, а не готовым значением: скачивание
 * и перерисовка занимают сотни миллисекунд, и к их концу браузер уже не считал
 * бы нажатие Ctrl+C «живым действием человека» — запись в буфер отклонялась бы.
 */
export async function copyImageToSystemClipboard(
  item: CanvasItem,
  ownPayload: string,
  deps: ClipboardDeps = {},
): Promise<boolean> {
  if (item.kind !== 'image' || !item.src) return false
  const write = deps.write
    ?? (typeof navigator !== 'undefined' && navigator.clipboard?.write
      ? (items: ClipboardItem[]) => navigator.clipboard.write(items)
      : null)
  if (!write || typeof ClipboardItem === 'undefined') return false

  const request = deps.fetch ?? fetch
  const toPng = deps.toPng ?? repaintAsPng
  const png = (async () => {
    if (deps.after) await deps.after.catch(() => {})
    const response = await request(item.src!)
    if (!response.ok) throw new Error('Image is unavailable')
    const blob = await response.blob()
    return needsPngConversion(blob.type) ? toPng(blob) : blob
  })()

  try {
    await write([new ClipboardItem({
      'image/png': png,
      // Метка нашего буфера едет рядом: без неё Ctrl+V внутри приложения
      // перестал бы узнавать собственную копию. Пустую метку не кладём — она
      // заняла бы системный буфер строкой, которая никому не нужна.
      ...(ownPayload ? { 'text/plain': new Blob([ownPayload], { type: 'text/plain' }) } : {}),
    })])
    return true
  } catch (error) {
    // Браузер отказал (нет разрешения, картинка не читается) — внутренний
    // буфер при этом уже заполнен, копирование внутри приложения работает.
    // В журнал — обязательно: иначе «не вставляется в Фотошоп» не разобрать.
    log.warn('board', 'Image could not be placed in the system clipboard', {
      объект: item.id,
      ошибка: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
    return false
  }
}

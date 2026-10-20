// Строка сведений об объекте на холсте: что это за файл и какой он.
//
// Раньше по наведению показывалось только «1024×1536 • 2,3 МБ» — то есть
// техника без ответа на главный вопрос «что это». Имя файла не показывалось
// нигде, кроме звука (просьба 18.09.2026 «покажи имя, оно может быть длинным»).
//
// Правила здесь, а не в фигуре: их можно проверить без Konva и без DOM, и они
// одни на картинку и на видео — две копии разъехались бы при первой же правке.

/** Ниже этой ширины на экране строку не показываем вовсе: там она нечитаема,
 *  а шум создаёт. */
export const INFO_LINE_MIN_WIDTH = 120

export interface InfoLineInput {
  /** Имя файла. У генераций оно машинное и человеку бесполезно. */
  name?: string
  /** Имя модели, если объект сгенерирован. */
  modelName?: string
  naturalWidth?: number
  naturalHeight?: number
  /** Готовая строка веса («2,3 МБ»): считает её тот, кто спрашивал размер. */
  fileSize?: string | null
  /** Длительность в секундах — только у видео и звука. */
  durationText?: string
}

export interface InfoLineParts {
  /** Главное: чем этот объект отличается от соседнего. */
  title: string
  /** Техника: разрешение, длительность, вес. Её не режем никогда. */
  tech: string
}

/**
 * ⚠️ У сгенерированного первым идёт МОДЕЛЬ, а не имя файла: имя у него
 * машинное (вида «fal-1737…png») и человеку не говорит ничего, а модель — это
 * ровно то, что ищут глазами, сравнивая две картинки на доске.
 */
export function infoLineParts(input: InfoLineInput): InfoLineParts {
  const tech = [
    input.naturalWidth && input.naturalHeight ? `${input.naturalWidth}×${input.naturalHeight}` : '',
    input.durationText ?? '',
    input.fileSize ?? '',
  ].filter(Boolean).join(' · ')
  return { title: input.modelName?.trim() || fileTitle(input.name), tech }
}

/** Имя файла для показа. Пустое имя не выдаём за файл — честнее промолчать. */
function fileTitle(name: string | undefined): string {
  const raw = (name ?? '').trim()
  if (!raw) return ''
  // Путь нам не нужен: на холсте лежит файл, а не его адрес.
  return raw.split(/[\\/]/).pop()?.trim() ?? ''
}

/**
 * Усечение ПО СЕРЕДИНЕ с сохранением хвоста.
 *
 * ⚠️ Обрезка с конца съедает как раз то, чем файлы отличаются: «…_v7.png» и
 * «…_v8.png» превратились бы в одинаковое «морской_закат_финальн…». Поэтому
 * оставляем и начало, и конец.
 */
export function middleTruncate(text: string, maxChars: number): string {
  if (maxChars <= 1) return text ? '…' : ''
  if (text.length <= maxChars) return text
  // Хвосту отдаём чуть больше: там расширение и номер версии.
  const tail = Math.max(1, Math.round((maxChars - 1) * 0.45))
  const head = Math.max(1, maxChars - 1 - tail)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

export interface FitInfoLineInput extends InfoLineParts {
  /** Сколько места есть под текст, в мировых координатах фигуры. */
  maxTextWidth: number
  measureTitle(text: string): number
  measureTech(text: string): number
  /** Зазор между главным и техникой. */
  gap: number
}

/**
 * Подогнать строку под ширину. Режем ТОЛЬКО имя: техника коротка и по ней
 * сравнивают, а урезанное «1024×15…» не значит ничего.
 */
export function fitInfoLine(input: FitInfoLineInput): InfoLineParts | null {
  const techWidth = input.tech ? input.measureTech(input.tech) : 0
  if (!input.title) {
    // Одна техника: если и она не влезла, показывать нечего.
    return techWidth <= input.maxTextWidth ? { title: '', tech: input.tech } : null
  }
  const available = input.maxTextWidth - techWidth - (input.tech ? input.gap : 0)
  if (available <= 0) {
    // Места под имя не осталось вовсе — техника важнее: она есть всегда и
    // отвечает на «какой он», а имя человек увидит, приблизив объект.
    return techWidth <= input.maxTextWidth ? { title: '', tech: input.tech } : null
  }
  if (input.measureTitle(input.title) <= available) return { title: input.title, tech: input.tech }

  // Подбираем длину: измерять каждый вариант дешевле, чем гадать по среднему
  // знаку — в имени файла бывают и «ш», и «i».
  let low = 1
  let high = input.title.length
  let best = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = middleTruncate(input.title, middle)
    if (input.measureTitle(candidate) <= available) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (!best) return techWidth <= input.maxTextWidth ? { title: '', tech: input.tech } : null
  return { title: best, tech: input.tech }
}

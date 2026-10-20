import { newId } from '../../../ui/ids'
import { CANVAS_SANS_FONT } from './fonts'
// Раскладка объектов на холсте: ширина отображения, зазоры, оценка высоты текста.
export { rectIntersects } from './geometry'

export const DISPLAY_WIDTH = 440
export const GAP = 60

/**
 * Скругление угла у картинки, видео и GIF — в ЭКРАННЫХ пикселях.
 *
 * ⚠️ Одно число на ВСЁ, что рисует угол медиа: сам кадр, подложку под ним,
 * рамку поверх и цветные полосы у кромки. Рамка была скруглена, а кадр —
 * нет, и его квадратный угол торчал из-за дуги (жалоба 21.09.2026 со
 * снимком: при приближении это видно сразу). Поэтому фигура считает радиус
 * ОДИН раз (`const radius = mediaCornerRadius(viewScale, …)`) и отдаёт его
 * каждой части угла.
 *
 * ⚠️ Масштаб — огрублённый `viewScale` из пропов (quantizeScale), а не
 * подписка на камеру в теле фигуры: та однажды стоила 246 мс на сдвиг (см.
 * cameraScale.ts). Ошибка огрубления — не больше 9%, то есть 3,7–4,4 px.
 * Обрезку группой с `clipFunc`, которая считала бы радиус при отрисовке,
 * пробовали: она дороже на 40% — 0,6 мс на кадр при 300 картинках.
 *
 * ⚠️ Раньше угол задавался в единицах доски (4), и при приближении он рос
 * вместе с рамкой: при ×8 кадр терял 32 px угла, рамка становилась полосой в
 * 8 px, а квадратная рамка выделения стояла снаружи неё — в углу выходило
 * несколько вложенных контуров (жалоба 30.09.2026 со снимками). Скругление
 * медиа — это смягчение края, а не форма объекта: на экране оно одно при
 * любом масштабе.
 */
export const MEDIA_CORNER_PX = 4

/**
 * Радиус в единицах доски, который на экране при масштабе `scale` даёт
 * `MEDIA_CORNER_PX`. ⚠️ Не больше шестой части меньшей стороны: при сильном
 * отдалении картинка бывает в несколько пикселей, и без потолка кадр
 * превратился бы в кружок.
 */
export function mediaCornerRadius(scale: number, w: number, h: number): number {
  const side = Math.min(Math.abs(w), Math.abs(h))
  if (!(scale > 0) || !Number.isFinite(scale) || !(side > 0)) return 0
  return Math.min(MEDIA_CORNER_PX / scale, side / 6)
}

// Кегль текстовой карточки по умолчанию (в старых досках поля fontSize нет).
export const DEFAULT_FONT_SIZE = 15

// Отступ текста от края карточки пропорционален кеглю: при фиксированных 12px
// масштабированная карточка росла, а поля — нет, и текст «прилипал» к рамке.
// 0.8 × 15 = 12 — прежний вид карточки по умолчанию сохраняется точь-в-точь.
export function textPadding(fontSize: number): number {
  return Math.round(fontSize * 0.8)
}

let canvasEl: HTMLCanvasElement | null = null
export function measureTextWidth(text: string, font: string): number {
  if (!canvasEl && typeof document !== 'undefined') {
    canvasEl = document.createElement('canvas')
  }
  const context = canvasEl?.getContext('2d')
  if (context) {
    context.font = font
    return context.measureText(text).width
  }
  return text.length * 7
}

export function computeAdaptiveTextDimensions(
  text: string,
  fontSize = DEFAULT_FONT_SIZE,
  userWidth?: number,
): { w: number; h: number } {
  const pad = textPadding(fontSize)
  const lineHeight = fontSize * 1.45
  const fontStr = `${fontSize}px ${CANVAS_SANS_FONT}`

  if (!text || !text.trim()) {
    const minH = Math.ceil(lineHeight + pad * 2 + 8)
    const defaultW = Math.round(fontSize * 16)
    return { w: userWidth && userWidth > 80 ? userWidth : defaultW, h: minH }
  }

  const paragraphs = text.split('\n')

  let maxSingleLineWidth = 0
  for (const p of paragraphs) {
    const pWidth = measureTextWidth(p, fontStr)
    if (pWidth > maxSingleLineWidth) maxSingleLineWidth = pWidth
  }

  let cardWidth: number
  if (userWidth && userWidth > 80) {
    cardWidth = userWidth
  } else {
    const rawNeededWidth = Math.ceil(maxSingleLineWidth + pad * 2 + 16)
    // Адаптивная ширина масштабируется от кегля (для 15px это от 120 до 480px)
    const minW = Math.round(fontSize * 8)
    const maxW = Math.round(fontSize * 32)
    cardWidth = Math.max(minW, Math.min(maxW, rawNeededWidth))
  }

  const innerWidth = Math.max(20, cardWidth - pad * 2)

  let totalLines = 0
  for (const p of paragraphs) {
    if (!p.trim()) {
      totalLines += 1
      continue
    }
    const words = p.split(/\s+/)
    let currentLine = ''
    let linesInP = 0
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word
      const testWidth = measureTextWidth(testLine, fontStr)
      if (testWidth > innerWidth && currentLine) {
        linesInP++
        currentLine = word
      } else {
        currentLine = testLine
      }
    }
    if (currentLine) linesInP++
    totalLines += Math.max(1, linesInP)
  }

  const contentHeight = Math.ceil(totalLines * lineHeight + pad * 2 + 8)
  const cardHeight = Math.max(Math.ceil(lineHeight + pad * 2 + 8), contentHeight)

  return { w: Math.ceil(cardWidth), h: Math.ceil(cardHeight) }
}

export function estimateTextHeight(
  text: string,
  width = DISPLAY_WIDTH,
  fontSize = DEFAULT_FONT_SIZE,
): number {
  return computeAdaptiveTextDimensions(text, fontSize, width).h
}

export function uid(): string {
  return newId()
}

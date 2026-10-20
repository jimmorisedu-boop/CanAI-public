import { Group, Rect, Text as KonvaText } from 'react-konva'
import type { CanvasStore } from './canvasStore'
import { measureTextWidth, useCameraScale } from './itemHelpers'
import { CANVAS_MONO_FONT, CANVAS_SANS_FONT } from './fonts'
import { INFO_LINE_MIN_WIDTH, fitInfoLine, type InfoLineParts } from './itemInfoLine'

const FONT_SIZE = 10
const BADGE_H = 18
const PAD_X = 6
const EDGE = 8
const GAP = 6

/**
 * Плашка сведений по наведению: имя (или модель) и техника в ОДНОЙ строке.
 *
 * Одна на картинку и на видео намеренно: раньше каждая рисовала её своим
 * куском кода, и третья копия разъехалась бы с ними при первой же правке.
 *
 * ⚠️ Масштаб берём подпиской ЗДЕСЬ, а не пропсом из фигуры: подписка в теле
 * фигуры однажды стоила 246 мс на сдвиг камеры (см. cameraScale.ts). Плашка
 * живёт только пока курсор на объекте, поэтому её подписка ничего не стоит.
 */
export function ItemInfoBadge({
  store,
  itemW,
  itemH,
  parts,
  bottomOffset = 0,
  rightReserved = 0,
}: {
  store: CanvasStore
  itemW: number
  itemH: number
  parts: InfoLineParts
  /** Сколько поднять плашку: у видео снизу полоса прогресса. */
  bottomOffset?: number
  /** Место, занятое соседней правой плашкой (например, временем видео). */
  rightReserved?: number
}) {
  const scale = useCameraScale(store)
  // Порог считаем в ЭКРАННЫХ пикселях: на отдалённой доске объект может быть
  // большим в мировых координатах и крошечным на экране.
  if (itemW * scale < INFO_LINE_MIN_WIDTH) return null

  const titleFont = `${FONT_SIZE}px ${CANVAS_SANS_FONT}`
  const techFont = `${FONT_SIZE}px ${CANVAS_MONO_FONT}`
  const fitted = fitInfoLine({
    ...parts,
    maxTextWidth: Math.max(0, itemW - EDGE * 2 - PAD_X * 2 - Math.max(0, rightReserved)),
    measureTitle: (text) => measureTextWidth(text, titleFont),
    measureTech: (text) => measureTextWidth(text, techFont),
    gap: GAP,
  })
  if (!fitted || (!fitted.title && !fitted.tech)) return null

  const titleWidth = fitted.title ? measureTextWidth(fitted.title, titleFont) : 0
  const techWidth = fitted.tech ? measureTextWidth(fitted.tech, techFont) : 0
  const bothShown = Boolean(fitted.title && fitted.tech)
  const badgeW = titleWidth + techWidth + (bothShown ? GAP : 0) + PAD_X * 2
  const badgeY = itemH - BADGE_H - EDGE - bottomOffset

  return (
    <Group listening={false}>
      <Rect
        x={EDGE}
        y={badgeY}
        width={badgeW}
        height={BADGE_H}
        fill="rgba(22, 24, 29, 0.76)"
        stroke="rgba(255, 255, 255, 0.12)"
        strokeWidth={1}
        cornerRadius={4}
        perfectDrawEnabled={false}
      />
      {fitted.title && (
        <KonvaText
          x={EDGE + PAD_X}
          y={badgeY + 4}
          text={fitted.title}
          fontSize={FONT_SIZE}
          fontFamily={CANVAS_SANS_FONT}
          fill="rgba(255, 255, 255, 0.95)"
          perfectDrawEnabled={false}
        />
      )}
      {fitted.tech && (
        // Техника тусклее: главное — чем этот объект отличается от соседнего.
        <KonvaText
          x={EDGE + PAD_X + titleWidth + (bothShown ? GAP : 0)}
          y={badgeY + 4}
          text={fitted.tech}
          fontSize={FONT_SIZE}
          fontFamily={CANVAS_MONO_FONT}
          fill="rgba(255, 255, 255, 0.55)"
          perfectDrawEnabled={false}
        />
      )}
    </Group>
  )
}

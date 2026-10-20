import { useState } from 'react'
import { Group, Rect, Text as KonvaText } from 'react-konva'
import { CANVAS_SANS_FONT } from './fonts'
import { LINK_ACTION_RADIUS, linkActionButtonStyle, setLinkActionButtonCursor } from './linkActionButton'
import { cardActionLabelY } from './cardActionButtonLayout'
import type { KEvent } from './itemHelpers'

/**
 * Кнопка внутри карточки на холсте.
 *
 * Konva не умеет HTML, поэтому кнопки рисуются вручную — и ровно поэтому их
 * легко развести по виду: у карточки ссылки была одна форма, у карточки
 * генерации другая (таблетка, без реакции на наведение). Компонент один на
 * оба места: наводишь — кнопка отзывается и курсор становится пальцем, как
 * везде в приложении.
 */
export function CardActionButton({
  x,
  y,
  width,
  height,
  label,
  primary,
  textColor,
  accent,
  accentHover,
  fontSize,
  onPress,
}: {
  x: number
  y: number
  width: number
  height: number
  label: string
  primary?: boolean
  textColor: string
  // Акцент передаём сверху, чтобы кнопка не читала палитру сама: она
  // рисуется на каждой карточке, и лишняя подписка на тему тут ни к чему.
  accent: string
  accentHover: string
  /** По умолчанию кегль считается от высоты кнопки: она растёт с карточкой. */
  fontSize?: number
  onPress(): void
}) {
  const [hovered, setHovered] = useState(false)
  const press = (event: KEvent) => {
    event.cancelBubble = true
    onPress()
  }
  const hover = (event: KEvent, next: boolean) => {
    setHovered(next)
    setLinkActionButtonCursor(event.target.getStage()?.container(), next)
  }
  const surface = linkActionButtonStyle(Boolean(primary), hovered, { base: accent, hover: accentHover })
  const size = fontSize ?? Math.round(height * 0.32)
  return (
    <Group
      x={x}
      y={y}
      width={width}
      height={height}
      onClick={press}
      onTap={(event) => press(event as unknown as KEvent)}
      onMouseEnter={(event) => hover(event as unknown as KEvent, true)}
      onMouseLeave={(event) => hover(event as unknown as KEvent, false)}
    >
      <Rect
        width={width}
        height={height}
        cornerRadius={LINK_ACTION_RADIUS}
        fill={surface.fill}
        stroke={surface.stroke}
        strokeWidth={1}
      />
      <KonvaText
        y={cardActionLabelY(height, size)}
        width={width}
        text={label}
        align="center"
        fontSize={size}
        fontStyle="600"
        fill={primary ? '#fff' : textColor}
        fontFamily={CANVAS_SANS_FONT}
        listening={false}
      />
    </Group>
  )
}

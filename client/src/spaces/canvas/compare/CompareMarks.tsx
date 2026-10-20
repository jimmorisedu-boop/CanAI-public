import { Group, Rect, Text } from 'react-konva'
import type { CanvasItem } from '../konva/types'
import { CANVAS_MONO_FONT } from '../konva/fonts'
import type { ComparePicking } from './compareBus'

// Подсветка на самих объектах во время набора — второй слой подсказок.
// Пользователь смотрит на холст, а не на плашку, поэтому роль («Исходник») и
// порядковый номер кандидата видны прямо на кадре. Номер — он же порядок
// панелей в просмотрщике.

const ACCENT = '#d33f21'
const BADGE_BG = '#ffffff'
const BADGE_TEXT = '#5b616b'

export function CompareMarks({
  session,
  items,
  scale,
}: {
  session: ComparePicking
  items: CanvasItem[]
  scale: number
}) {
  return (
    <Group listening={false}>
      {items.map((item) => {
        const isBaseline = item.id === session.baselineId
        const index = session.candidateIds.indexOf(item.id)
        if (!isBaseline && index < 0) return null

        const text = isBaseline ? 'Source' : String(index + 1)
        // читаемый экранный размер при отдалении — приём из MarkBadge
        const fontSize = Math.max(11, 13 / scale)
        const height = fontSize * 1.9
        const width = isBaseline ? text.length * fontSize * 0.62 + fontSize * 1.4 : height
        // по центру верхней кромки объекта, а не в углу
        const x = item.x + (item.w - width) / 2
        const y = item.y + fontSize * 0.6

        return (
          <Group key={item.id}>
            <Rect
              x={item.x}
              y={item.y}
              width={item.w}
              height={item.h}
              stroke={ACCENT}
              strokeWidth={2 / scale}
              cornerRadius={4}
              perfectDrawEnabled={false}
            />
            <Rect
              x={x}
              y={y}
              width={width}
              height={height}
              fill={BADGE_BG}
              cornerRadius={height / 2}
              shadowColor="rgba(20, 22, 26, 0.35)"
              shadowBlur={6 / scale}
              shadowOpacity={1}
              perfectDrawEnabled={false}
            />
            <Text
              x={x}
              y={y}
              width={width}
              height={height}
              text={text}
              fontSize={fontSize}
              fontStyle="bold"
              fontFamily={CANVAS_MONO_FONT}
              fill={BADGE_TEXT}
              align="center"
              verticalAlign="middle"
              perfectDrawEnabled={false}
            />
          </Group>
        )
      })}
    </Group>
  )
}

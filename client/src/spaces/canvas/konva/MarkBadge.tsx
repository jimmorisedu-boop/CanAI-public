import { Group, Rect, Text as KonvaText } from 'react-konva'
import { measureTextWidth, useCameraScale } from './itemHelpers'
import type { CanvasStore } from './canvasStore'
import { CANVAS_MONO_FONT } from './fonts'

// Минимальный размер на ЭКРАНЕ (не в мировых координатах) — та же идея, что
// у LeftAccentStrip в ImageItem: при отдалении домножаем на 1/scale, чтобы
// метку было видно издалека даже на сильно уменьшенной доске.
const MIN_SCREEN_PX = 12
const MIN_WORLD_PX = 12

// Метка группового экспорта (1..999, см. setMarks/zipExport) — вермилионовая
// пилюля в верхнем левом углу объекта. ВСЕГДА видна (не по ховеру, в отличие
// от бейджа разрешения) — вся её польза в том, чтобы разметку было видно
// сразу по всей доске. Цвет фиксированный (не из темы): бейдж ложится поверх
// произвольных фото/видео, а не нейтрального фона приложения.
export function MarkBadge({ mark, store, itemW }: { mark: number; store: CanvasStore; itemW: number }) {
  // подписка живёт в самом бейдже — зум не должен трогать фигуру целиком
  const scale = useCameraScale(store)
  const text = String(mark)
  const fontSize = Math.max(MIN_WORLD_PX, MIN_SCREEN_PX / scale)
  const font = `700 ${fontSize}px ${CANVAS_MONO_FONT}`
  const textWidth = measureTextWidth(text, font)
  const h = fontSize * 1.8
  const w = Math.max(h, textWidth + fontSize)

  return (
    <Group x={itemW - w - 8} y={8} listening={false}>
      <Rect
        width={w}
        height={h}
        cornerRadius={h / 2}
        fill="#d33f21"
        stroke="#ffffff"
        strokeWidth={Math.max(1, fontSize * 0.08)}
        shadowColor="rgba(0, 0, 0, 0.35)"
        shadowBlur={4}
        shadowOffsetY={1}
        perfectDrawEnabled={false}
      />
      <KonvaText
        width={w}
        height={h}
        text={text}
        align="center"
        verticalAlign="middle"
        fontSize={fontSize}
        fontStyle="700"
        fontFamily={CANVAS_MONO_FONT}
        fill="#ffffff"
        perfectDrawEnabled={false}
      />
    </Group>
  )
}

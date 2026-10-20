import { memo, useRef, useState } from 'react'
import { Group, Line, Rect, Text as KonvaText } from 'react-konva'
import type Konva from 'konva'
import { DEFAULT_FONT_SIZE, textPadding } from './canvasLayout'
import { CANVAS_SANS_FONT } from './fonts'
import {
  commitTextTransform,
  onCanvasItemDragMove,
  onCanvasItemDragStart,
  onDragEnd,
  onTransformPreview,
  selectOnClick,
  stepTextTransform,
  useThemeColors,
  type ItemProps,
  type KEvent,
  type TextTransformState,
} from './itemHelpers'
import { MarkBadge } from './MarkBadge'
import {
  canvasColorWithAlpha,
  overflowCueAppearance,
  overflowCueGeometry,
  overflowCueTone,
  textOverflowsFrame,
  transparentCanvasColor,
} from './textOverflow'

/** Скругление текстовой карточки — одно на её тело и на кольцо выделения. */
const TEXT_CARD_RADIUS = 10

export const TextItem = memo(function TextItem({
  item,
  store,
  draggable,
  selected,
  isEditing,
  onEditText,
}: ItemProps & { isEditing?: boolean; onEditText?: (id: string) => void }) {
  const ref = useRef<Konva.Group>(null)
  const tc = useThemeColors()
  // Размеры во время самой трансформации. Konva тянет группу через scale, из-за
  // чего буквы и рамка визуально растягиваются; пересчитываем раскладку на каждом
  // кадре, а в стор пишем только на отпускании (иначе кадр = шаг истории undo).
  // liveRef — источник истины (не зависит от батчинга setState), live — рендер.
  const liveRef = useRef<TextTransformState | null>(null)
  const [live, setLive] = useState<TextTransformState | null>(null)
  const [hovered, setHovered] = useState(false)

  const baseFont = item.fontSize ?? DEFAULT_FONT_SIZE
  const w = live?.w ?? item.w
  const h = live?.h ?? item.h
  const fontSize = live?.fontSize ?? baseFont
  const pad = textPadding(fontSize)
  const overflowing = textOverflowsFrame({ text: item.text, w, h, fontSize })
  const cue = overflowCueGeometry({ w, h, fontSize })
  const cueTone = overflowCueTone({ overflowing, selected: Boolean(selected), hovered })
  const cueColor = cueTone === 'accent' ? tc.textOverflowAccent : tc.textOverflowMuted
  const cueAppearance = overflowCueAppearance(cueTone)

  return (
    <Group
      id={item.id}
      // Размер и скругление — для кольца выделения (SelectionRings).
      selectionFrame={{ w, h, radius: TEXT_CARD_RADIUS }}
      ref={ref}
      x={item.x}
      y={item.y}
      rotation={item.rotation}
      visible={!isEditing}
      draggable={draggable}
      onDragStart={(e) => onCanvasItemDragStart(store, item.id, e)}
      onDragMove={(e) => onCanvasItemDragMove(store, item.id, e)}
      onClick={(e) => selectOnClick(store, item.id, e)}
      onTap={(e) => selectOnClick(store, item.id, e as unknown as KEvent)}
      onDblClick={() => onEditText?.(item.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragEnd={(e) => onDragEnd(store, item.id, e)}
      onTransformStart={() => {
        liveRef.current = { w: item.w, h: item.h, fontSize: baseFont }
        setLive(liveRef.current)
      }}
      onTransform={() => {
        if (!ref.current || !liveRef.current) return
        const transformer = ref.current.getStage()?.findOne<Konva.Transformer>('Transformer')
        liveRef.current = stepTextTransform(liveRef.current, ref.current, item.text, transformer?.getActiveAnchor())
        setLive(liveRef.current)
        onTransformPreview(store, item.id, ref.current, liveRef.current)
      }}
      onTransformEnd={() => {
        if (!ref.current) return
        commitTextTransform(store, item.id, ref.current, liveRef.current)
        liveRef.current = null
        setLive(null)
      }}
    >
      <Rect width={w} height={h} fill={tc.textBg} stroke={tc.textBorder} strokeWidth={1} strokeScaleEnabled={false} cornerRadius={TEXT_CARD_RADIUS} />
      <KonvaText
        text={item.text || ''}
        width={Math.max(1, w - pad * 2)}
        height={Math.max(1, h - pad * 2)}
        x={pad}
        y={pad}
        fontSize={fontSize}
        lineHeight={1.45}
        fill={tc.textColor}
        fontFamily={CANVAS_SANS_FONT}
        wrap="word"
        ellipsis={false}
      />
      {cueTone !== 'hidden' && (
        <Group listening={false}>
          <Rect
            x={0}
            y={cue.fadeY}
            width={w}
            height={cue.fadeH}
            fillLinearGradientStartPoint={{ x: 0, y: 0 }}
            fillLinearGradientEndPoint={{ x: 0, y: cue.fadeH }}
            fillLinearGradientColorStops={[0, transparentCanvasColor(tc.textBg), 1, tc.textBg]}
            listening={false}
          />
          <Rect
            x={0}
            y={cue.fadeY}
            width={w}
            height={cue.fadeH}
            fillLinearGradientStartPoint={{ x: 0, y: 0 }}
            fillLinearGradientEndPoint={{ x: 0, y: cue.fadeH }}
            fillLinearGradientColorStops={[
              0,
              canvasColorWithAlpha(tc.textOverflowAccent, 0),
              1,
              canvasColorWithAlpha(tc.textOverflowAccent, cueAppearance.tintOpacity),
            ]}
            perfectDrawEnabled={false}
            listening={false}
          />
          <Rect
            x={cue.badgeX}
            y={cue.badgeY}
            width={cue.badgeSize}
            height={cue.badgeSize}
            cornerRadius={cue.badgeSize / 2}
            fill={tc.dismissBg}
            opacity={cueAppearance.fillOpacity}
            stroke={cueColor}
            strokeWidth={cueAppearance.strokeWidth}
            shadowColor="rgba(0,0,0,0.32)"
            shadowBlur={5}
            shadowOffsetY={2}
            shadowOpacity={1}
            perfectDrawEnabled={false}
            listening={false}
          />
          <Line
            x={cue.chevronX}
            y={cue.chevronY}
            points={[0, 0, cue.chevronSize / 2, cue.chevronSize / 2, cue.chevronSize, 0]}
            stroke={cueColor}
            strokeWidth={Math.max(2, cue.chevronSize * 0.18)}
            lineCap="round"
            lineJoin="round"
            listening={false}
          />
        </Group>
      )}
      {item.mark != null && <MarkBadge mark={item.mark} store={store} itemW={item.w} />}
    </Group>
  )
})

// Карточка «будущего результата»: пока задача крутится — спиннер (вращающаяся
// дуга) + имя модели + счётчик секунд; при ошибке — красная карточка с текстом
// и крестиком. Позиция задаётся стором (ряд по нижнему краю).

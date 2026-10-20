import { useState } from 'react'
import type Konva from 'konva'
import { Circle, Group, Line, Rect, Text as KonvaText } from 'react-konva'
import { CANVAS_MONO_FONT } from './fonts'
import { measureTextWidth, type KEvent } from './itemHelpers'
import { VIDEO_CONTROL_CY, VIDEO_CONTROL_INSET, VIDEO_FRAME_CAPTURE_SIZE } from './videoFrameCapture'
import {
  MEDIA_TIME_BADGE_FONT,
  mediaTimeBadgeLayout,
  mediaTimeBadgeText,
} from './mediaBadgeLayout'

/**
 * Оболочка плеера на холсте — ОДНА на видео и GIF (просьба 22.09.2026
 * «плеер как для видео, только для гиф»). Кнопка по центру, время, полоса и
 * кнопка кадра вынесены сюда из VideoItem без изменений: одинаковые с виду
 * плееры обязаны и вести себя одинаково, а две копии разъехались бы при
 * первой же правке одной.
 */

/** ▶ по центру, пока не играет; ⏸ по наведению, пока играет. */
export function PlayPauseOverlay({
  w,
  h,
  playing,
  selected,
  hovered,
  onToggle,
}: {
  w: number
  h: number
  playing: boolean
  selected?: boolean
  hovered: boolean
  onToggle: (e: KEvent) => void
}) {
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(28, w / 6)
  if (!playing && (!selected || hovered)) {
    return (
      <Group onClick={onToggle} onTap={onToggle} listening opacity={hovered ? 1 : 0.75}>
        <Circle x={cx} y={cy} radius={r} fill="rgba(26,26,31,0.55)" />
        <Line
          points={[cx - r * 0.3, cy - r * 0.45, cx - r * 0.3, cy + r * 0.45, cx + r * 0.5, cy]}
          closed
          fill="#fff"
          perfectDrawEnabled={false}
        />
      </Group>
    )
  }
  if (playing && hovered) {
    return (
      <Group onClick={onToggle} onTap={onToggle} listening>
        <Circle x={cx} y={cy} radius={r} fill="rgba(26,26,31,0.55)" />
        <Rect
          x={cx - r * 0.25}
          y={cy - r * 0.4}
          width={r * 0.2}
          height={r * 0.8}
          fill="#fff"
          perfectDrawEnabled={false}
        />
        <Rect
          x={cx + r * 0.05}
          y={cy - r * 0.4}
          width={r * 0.2}
          height={r * 0.8}
          fill="#fff"
          perfectDrawEnabled={false}
        />
      </Group>
    )
  }
  return null
}

/** Плашка «текущее / всего» у правого нижнего угла, над полосой. */
export function MediaTimeBadge({
  w,
  h,
  bottomOffset,
  currentTime,
  duration,
}: {
  w: number
  h: number
  bottomOffset: number
  currentTime: number
  duration: number
}) {
  const timeText = mediaTimeBadgeText(currentTime, duration)
  const textWidth = measureTextWidth(timeText, MEDIA_TIME_BADGE_FONT)
  const badge = mediaTimeBadgeLayout(w, h, bottomOffset, textWidth)
  if (!badge) return null
  return (
    <>
      <Rect
        x={badge.x}
        y={badge.y}
        width={badge.w}
        height={badge.h}
        fill="rgba(22, 24, 29, 0.76)"
        stroke="rgba(255, 255, 255, 0.12)"
        strokeWidth={1}
        cornerRadius={4}
        perfectDrawEnabled={false}
      />
      <KonvaText
        x={badge.x + 6}
        y={badge.y + 4}
        text={timeText}
        fontSize={10}
        fontFamily={CANVAS_MONO_FONT}
        fill="rgba(255, 255, 255, 0.9)"
        perfectDrawEnabled={false}
      />
    </>
  )
}

/**
 * Полоса прогресса по нижнему краю; за неё перематывают (useProgressScrub).
 * Нижние углы — скругление самого кадра: `cornerRadius` отдаёт фигура, одним
 * числом с кадром и рамкой (mediaCornerRadius в canvasLayout).
 */
export function MediaProgressBar({
  w,
  h,
  height,
  progress,
  color,
  cornerRadius,
  onScrubStart,
}: {
  w: number
  h: number
  height: number
  progress: number
  color: string
  cornerRadius: number
  onScrubStart: (e: Konva.KonvaEventObject<any>) => void
}) {
  return (
    <Group>
      <Rect
        x={0}
        y={h - height}
        width={w}
        height={height}
        fill="rgba(26, 26, 31, 0.4)"
        cornerRadius={[0, 0, cornerRadius, cornerRadius]}
        listening={true}
        onMouseDown={onScrubStart}
        onTouchStart={onScrubStart}
        onClick={(e) => {
          e.cancelBubble = true
        }}
        onTap={(e) => {
          e.cancelBubble = true
        }}
      />
      <Rect
        x={0}
        y={h - height}
        width={w * Math.max(0, Math.min(1, progress))}
        height={height}
        fill={color}
        cornerRadius={[0, 0, cornerRadius, cornerRadius]}
        listening={false}
      />
    </Group>
  )
}

/** Кнопка «кадр из ролика» — кружок с фотоаппаратом, в ряду у угла. */
export function CaptureFrameButton({
  cx,
  scale,
  capturing,
  onCapture,
}: {
  cx: number
  scale: number
  capturing: boolean
  onCapture: (e: Konva.KonvaEventObject<any>) => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <Group
      scaleX={scale}
      scaleY={scale}
      onClick={onCapture}
      onTap={onCapture}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      opacity={capturing ? 0.5 : 1}
      listening={!capturing}
    >
      <Rect
        x={cx - VIDEO_FRAME_CAPTURE_SIZE / 2}
        y={VIDEO_CONTROL_INSET}
        width={VIDEO_FRAME_CAPTURE_SIZE}
        height={VIDEO_FRAME_CAPTURE_SIZE}
        fill="rgba(0,0,0,0.001)"
        perfectDrawEnabled={false}
      />
      <Circle
        x={cx}
        y={VIDEO_CONTROL_CY}
        radius={19}
        fill={hovered ? 'rgba(224, 60, 48, 0.95)' : 'rgba(22, 24, 29, 0.8)'}
        stroke="rgba(255, 255, 255, 0.15)"
        strokeWidth={1}
        perfectDrawEnabled={false}
      />
      {/* Верхний выступ вспышки */}
      <Rect
        x={cx - 4}
        y={VIDEO_CONTROL_CY - 9}
        width={8}
        height={3}
        fill="#fff"
        cornerRadius={0.5}
        perfectDrawEnabled={false}
      />
      {/* Корпус фотоаппарата */}
      <Rect
        x={cx - 9}
        y={VIDEO_CONTROL_CY - 6}
        width={18}
        height={13}
        fill="#fff"
        cornerRadius={1.5}
        perfectDrawEnabled={false}
      />
      {/* Линза/объектив */}
      <Circle
        x={cx}
        y={VIDEO_CONTROL_CY + 0.5}
        radius={4.5}
        fill={hovered ? 'rgba(224, 60, 48, 0.95)' : 'rgba(22, 24, 29, 0.8)'}
        stroke="#fff"
        strokeWidth={1.5}
        perfectDrawEnabled={false}
      />
    </Group>
  )
}

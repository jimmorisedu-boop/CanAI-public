import Konva from 'konva'
import { memo, useEffect, useRef, useState } from 'react'
import { Group, Line, Rect, Text as KonvaText } from 'react-konva'
import { MarkBadge } from './MarkBadge'
import { CANVAS_MONO_FONT, CANVAS_SANS_FONT } from './fonts'
import { AUDIO_ITEM_MIN_WIDTH, audioTitle, formatDuration } from './audioMeta'
import { nextAudioTime, timeFromWaveRatio } from './audioSeek'
import { getCompareSession } from '../compare/compareBus'
import { timelineBlocksCanvas } from '../timeline/timelineBus'
import {
  onCanvasItemDragMove,
  onCanvasItemDragStart,
  onDragEnd,
  onTransformEnd,
  onTransformPreview,
  selectOnClick,
  useArrival,
  useThemeColors,
  type ItemProps,
  type KEvent,
} from './itemHelpers'

// Звук на холсте — плашка, а не прямоугольник с картинкой: у дорожки нет
// кадра, который можно показать. Волну считает сервер один раз при импорте
// (audioPeaks.ts): декодировать весь файл в памяти вкладки ради картинки
// высотой в три десятка пикселей — плохая сделка. По волне можно кликать,
// а стрелками перематывать, когда плашка выделена.

const PAD = 14
const ICON = 30
const WAVE_HEIGHT = 22
/** Скругление плашки звука — одно на её тело и на кольцо выделения. */
const AUDIO_CARD_RADIUS = 10

function playIconPoints(cx: number, cy: number, size: number): number[] {
  const h = size / 2
  return [cx - h * 0.62, cy - h, cx - h * 0.62, cy + h, cx + h * 0.8, cy]
}

export const AudioItem = memo(function AudioItem({ item, store, draggable, selected }: ItemProps) {
  const groupRef = useRef<Konva.Group>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const tc = useThemeColors()
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  useArrival(store, item.id, () => groupRef.current, true)

  // Элемент создаём лениво — доска может держать сотню дорожек, и заводить на
  // каждую <audio> при монтировании значит держать сотню открытых потоков.
  useEffect(() => () => {
    audioRef.current?.pause()
    audioRef.current = null
  }, [])

  useEffect(() => {
    // сменился файл (например, объект вернули из архива) — старое воспроизведение
    // к нему уже не относится
    audioRef.current?.pause()
    audioRef.current = null
    setPlaying(false)
    setProgress(0)
  }, [item.src])

  /** Элемент создаётся лениво: доска может держать сотню дорожек, и заводить
   *  <audio> на каждую при монтировании значит держать сотню потоков. */
  function ensureAudio(): HTMLAudioElement | null {
    if (!item.src) return null
    let el = audioRef.current
    if (!el) {
      el = new Audio(item.src)
      el.addEventListener('timeupdate', () => {
        const total = el?.duration ?? item.duration ?? 0
        setProgress(total > 0 ? Math.min(1, (el?.currentTime ?? 0) / total) : 0)
      })
      el.addEventListener('ended', () => {
        setPlaying(false)
        setProgress(0)
      })
      el.addEventListener('error', () => setPlaying(false))
      audioRef.current = el
    }
    return el
  }

  /** Перемотка: и клик по волне, и стрелки приходят сюда. Если звук ещё не
   *  играл, элемент создаётся здесь же — перемотать можно до запуска. */
  function seekTo(time: number): void {
    const el = ensureAudio()
    if (!el) return
    const total = el.duration || item.duration || 0
    el.currentTime = time
    setProgress(total > 0 ? Math.min(1, time / total) : 0)
  }

  // Стрелки перематывают выделенную дорожку. Слушатель обычный (не capture) и
  // молчит при открытых режимах, которые сами работают с клавишами, — иначе
  // повторилась бы история с видео, съедавшим стрелки у таймлайна.
  useEffect(() => {
    if (!selected || !item.src) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const target = e.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
      if (document.querySelector('.settings-backdrop')) return
      if (getCompareSession() || timelineBlocksCanvas()) return
      e.preventDefault()
      const el = ensureAudio()
      if (!el) return
      seekTo(nextAudioTime({
        current: el.currentTime,
        duration: el.duration || item.duration || 0,
        direction: e.key === 'ArrowLeft' ? -1 : 1,
        shiftKey: e.shiftKey,
      }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, item.src, item.duration])

  /** Клик по волне: доля ширины дорожки → время. Позицию берём у сцены и
   *  переводим в координаты плашки — она может быть повёрнута и растянута. */
  function seekFromWave(e: KEvent): void {
    e.cancelBubble = true
    if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return
    store.select(item.id, e.evt.shiftKey)
    const node = groupRef.current
    const pos = node?.getStage()?.getPointerPosition()
    if (!node || !pos) return
    const local = node.getAbsoluteTransform().copy().invert().point(pos)
    const ratio = (local.x - textX) / Math.max(1, textW)
    seekTo(timeFromWaveRatio(ratio, audioRef.current?.duration || item.duration || 0))
  }

  function togglePlay(e: KEvent): void {
    e.cancelBubble = true
    if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return
    store.select(item.id, e.evt.shiftKey)
    const el = ensureAudio()
    if (!el) return
    if (playing) {
      el.pause()
      setPlaying(false)
      return
    }
    void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
  }

  const w = Math.max(AUDIO_ITEM_MIN_WIDTH, item.w)
  const h = item.h
  const iconCx = PAD + ICON / 2
  const iconCy = h / 2
  const textX = PAD + ICON + 12
  const textW = Math.max(20, w - textX - PAD)
  const barY = h - PAD - 4

  return (
    <Group
      ref={groupRef}
      id={item.id}
      // Размер и скругление — для кольца выделения (SelectionRings).
      selectionFrame={{ w, h, radius: AUDIO_CARD_RADIUS }}
      name="canvas-item"
      x={item.x}
      y={item.y}
      rotation={item.rotation}
      draggable={draggable}
      onDragStart={(e) => onCanvasItemDragStart(store, item.id, e)}
      onDragMove={(e) => onCanvasItemDragMove(store, item.id, e)}
      onDragEnd={(e) => onDragEnd(store, item.id, e)}
      onTransform={() => groupRef.current && onTransformPreview(store, item.id, groupRef.current)}
      onTransformEnd={() => groupRef.current && onTransformEnd(store, item.id, groupRef.current)}
      onClick={(e) => selectOnClick(store, item.id, e)}
      onTap={(e) => selectOnClick(store, item.id, e as unknown as KEvent)}
    >
      <Rect
        width={w}
        height={h}
        fill={tc.textBg}
        // Выделение показывает кольцо (SelectionRings) — своя рамка карточки
        // при выделении не краснеет, иначе вышла бы двойная красная линия.
        stroke={tc.textBorder}
        strokeWidth={1}
        strokeScaleEnabled={false}
        cornerRadius={AUDIO_CARD_RADIUS}
        perfectDrawEnabled={false}
      />

      <Group onClick={togglePlay} onTap={togglePlay}>
        <Rect
          x={PAD}
          y={iconCy - ICON / 2}
          width={ICON}
          height={ICON}
          fill={playing ? tc.spinnerColor : 'transparent'}
          stroke={playing ? tc.spinnerColor : tc.textBorder}
          strokeWidth={1}
          cornerRadius={ICON / 2}
          perfectDrawEnabled={false}
        />
        {playing ? (
          <>
            <Rect x={iconCx - 5} y={iconCy - 6} width={3.5} height={12} fill={tc.textBg} cornerRadius={1} />
            <Rect x={iconCx + 1.5} y={iconCy - 6} width={3.5} height={12} fill={tc.textBg} cornerRadius={1} />
          </>
        ) : (
          <Line points={playIconPoints(iconCx + 1, iconCy, 13)} closed fill={tc.textColor} perfectDrawEnabled={false} />
        )}
      </Group>

      <KonvaText
        x={textX}
        y={PAD}
        width={textW}
        text={audioTitle(item.name)}
        fontSize={14}
        fontFamily={CANVAS_SANS_FONT}
        fontStyle="500"
        fill={tc.textColor}
        ellipsis
        wrap="none"
        listening={false}
      />
      <KonvaText
        x={textX}
        y={PAD + 19}
        text={formatDuration(item.duration)}
        fontSize={12}
        fontFamily={CANVAS_MONO_FONT}
        fill={tc.timerColor}
        listening={false}
      />

      {/* Прозрачная полоса поверх волны ловит клики: сами столбики не
          слушают события, иначе попадать пришлось бы точно в столбик, а
          между ними — промах. Захватывает и подпись длительности сверху,
          чтобы область была пальцу по размеру. */}
      <Rect
        x={textX}
        y={barY - WAVE_HEIGHT / 2 - 4}
        width={textW}
        height={WAVE_HEIGHT + 12}
        fill="transparent"
        onClick={seekFromWave}
        onTap={seekFromWave}
        onMouseEnter={(e) => { const c = e.target.getStage()?.container(); if (c) c.style.cursor = 'pointer' }}
        onMouseLeave={(e) => { const c = e.target.getStage()?.container(); if (c) c.style.cursor = '' }}
      />

      {/* Волна вместо полосы, когда сервер успел её посчитать. Проигранная
          часть красится акцентом — это и есть индикатор позиции, отдельная
          полоска рядом с волной была бы вторым способом сказать то же самое. */}
      {item.peaks && item.peaks.length > 0 ? (
        <Group listening={false}>
          {item.peaks.map((peak, index) => {
            const step = textW / item.peaks!.length
            const height = Math.max(1.5, (peak / 100) * (WAVE_HEIGHT - 2))
            return (
              <Rect
                key={index}
                x={textX + index * step}
                y={barY + 3 - height / 2}
                width={Math.max(1, step - 1)}
                height={height}
                fill={index / item.peaks!.length <= progress ? tc.spinnerColor : tc.textBorder}
                cornerRadius={0.5}
                perfectDrawEnabled={false}
              />
            )
          })}
        </Group>
      ) : (
        <>
          <Rect x={textX} y={barY} width={textW} height={3} fill={tc.textBorder} cornerRadius={1.5} listening={false} />
          {progress > 0 && (
            <Rect
              x={textX}
              y={barY}
              width={textW * progress}
              height={3}
              fill={tc.spinnerColor}
              cornerRadius={1.5}
              listening={false}
            />
          )}
        </>
      )}

      {item.mark != null && <MarkBadge mark={item.mark} store={store} itemW={w} />}
    </Group>
  )
})

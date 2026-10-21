import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Image as KonvaImage, Rect } from 'react-konva'
import type Konva from 'konva'
import { getCompareSession, toggleCompareCandidate } from '../compare/compareBus'
import { onTimelineTarget } from '../timeline/timelineBus'
import { requestPromptFill } from '../promptFillBus'
import { showErrorToast } from '../toastBus'
import { MarkBadge } from './MarkBadge'
import { ItemInfoBadge } from './ItemInfoBadge'
import { infoLineParts } from './itemInfoLine'
import { modelDisplayName } from '../genOptions'
import { isImageLoadedFrom, useImageEl } from './media'
import { mediaCornerRadius } from './canvasLayout'
import { LeftAccentStrip } from './ImageItem'
import { boardMediaUploader } from './boardUploader'
import { captureFrameToCanvas, MUTE_CX, videoControlScale } from './videoFrameCapture'
import { createCanvasVideoPlaybackCommands, shouldTogglePlaybackOnClick } from './videoPlaybackCoordinator'
import { canPlayGif, useGifPlayer } from './gifPlayer'
import { screenPreviewSrc, stickyPreviewStep } from './screenPreview'
import { CaptureFrameButton, MediaProgressBar, MediaTimeBadge, PlayPauseOverlay } from './mediaPlayerChrome'
import { formatMediaTime } from './mediaTime'
import { MEDIA_TIME_BADGE_FONT, mediaTimeBadgeRightReservation, mediaTimeBadgeText } from './mediaBadgeLayout'
import { useMediaPlayerHotkeys, useProgressScrub } from './useMediaPlayerInput'
import { useT } from '../../../i18n/context.js'
import {
  onCanvasItemDragMove,
  onCanvasItemDragStart,
  onDragEnd,
  onTransformEnd,
  onTransformPreview,
  useArrival,
  useMediaSize,
  measureTextWidth,
  useThemeColors,
  type ItemProps,
  type KEvent,
} from './itemHelpers'

/**
 * GIF на холсте — картинка с плеером, как у видео (просьба 22.09.2026
 * «плеер как для видео, только для гиф»).
 *
 * Для доски GIF остаётся картинкой: референс, обрезка, скетч и экспорт видят
 * его так же, как любую картинку. Различие только в показе: первый кадр с ▶,
 * играет вторым кликом по выделенному, полоса с перемоткой, время, кнопка
 * кадра; клавиши — пробел и стрелки (кадр, с Shift — секунда). Оболочка плеера
 * общая с видео (mediaPlayerChrome), звука у GIF нет — кнопка кадра стоит
 * первой, у самого угла.
 *
 * ⚠️ Неподвижный кадр — ЭКРАННОЕ ПРЕВЬЮ, как у любой картинки. Холст рисует
 * через canvas, а он у <img> с GIF берёт только первый кадр, то есть ровно то,
 * что лежит в превью (WebP из первого кадра). Движение даёт плеер, а не <img>.
 * Раньше здесь грузился оригинал: восемь GIF по 0,4–15 МБ на доске
 * пользователя занимали очередь картинок, пока грузились и разбирались
 * целиком (жалоба 27.09.2026 «сетевая доска всё равно медленно»).
 * Нет ImageDecoder (Firefox, Safari) — остаётся неподвижный первый кадр.
 *
 * ⚠️ Оригинал для кадров плеер качает, только когда к GIF ОБРАТИЛИСЬ:
 * выделили его или попросили играть. Иначе каждый GIF в кадре тянул файл
 * целиком при каждом появлении на экране — на сетевой доске это десятки
 * мегабайт через VPN ради анимации, которую никто не запускал.
 */
export const GifItem = memo(function GifItem({
  item,
  store,
  draggable,
  selected,
  persistNaturalSize = true,
  viewScale = 1,
}: ItemProps & { persistNaturalSize?: boolean; viewScale?: number }) {
  const t = useT()
  // Ступень превью — тем же правилом, что у картинки (см. ImageItem).
  const previewWidth = useRef<number>()
  previewWidth.current = stickyPreviewStep(previewWidth.current, item.w * viewScale * devicePixelRatio)
  const shownSrc = screenPreviewSrc(item.src, previewWidth.current)
  const showingPreview = shownSrc !== item.src
  // Одно скругление на кадр, подложку, рамку и полосы — постоянное на экране.
  const radius = mediaCornerRadius(viewScale, item.w, item.h)
  const img = useImageEl(shownSrc, item.src, { x: item.x + item.w / 2, y: item.y + item.h / 2 })
  const [wantPlayer, setWantPlayer] = useState(false)
  useEffect(() => {
    if (selected) setWantPlayer(true)
  }, [selected])
  const { player, still } = useGifPlayer(item.src, wantPlayer)
  // Играть попросили раньше, чем кадры разобраны, — запустим, как только будут.
  const playWhenReady = useRef(false)
  const ref = useRef<Konva.Image>(null)
  const groupRef = useRef<Konva.Group>(null)
  const tc = useThemeColors()
  const [hovered, setHovered] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [capturing, setCapturing] = useState(false)
  const fileSize = useMediaSize(item.src, hovered)
  const redraw = useCallback(() => ref.current?.getLayer()?.batchDraw(), [])

  useArrival(store, item.id, () => groupRef.current, Boolean(img))

  useEffect(() => {
    if (!img) return
    redraw()
    // Размеры превью — НЕ размеры GIF: на них держатся обрезка и экспорт.
    if (persistNaturalSize && !showingPreview && isImageLoadedFrom(img, item.src)
      && (item.naturalWidth !== img.naturalWidth || item.naturalHeight !== img.naturalHeight)) {
      store.updateItem(item.id, { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }, false)
    }
  }, [img, item.id, item.src, item.naturalWidth, item.naturalHeight, persistNaturalSize, showingPreview, redraw, store])

  // Кадр сменился — время для полосы и перерисовка слоя.
  useEffect(() => player?.onFrame(() => {
    setCurrentTime(player.currentTime)
    redraw()
  }), [player, redraw])

  const playback = useMemo(() => player
    ? createCanvasVideoPlaybackCommands(store, item.id, player, { setPlaying, setCurrentTime, redraw })
    : undefined, [player, store, item.id, redraw])

  useEffect(() => () => playback?.release(), [playback])

  useEffect(() => {
    if (!playback || !playWhenReady.current) return
    playWhenReady.current = false
    playback.start()
  }, [playback])

  useEffect(() => {
    if (still) playWhenReady.current = false
  }, [still])

  // Ушли из вкладки — пауза, как у видео: крутить кадры некому смотреть.
  useEffect(() => {
    if (!playing) return
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') playback?.pause()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [playing, playback])

  // Вход в правку клипа останавливает всё, что играет на холсте.
  useEffect(() => onTimelineTarget((target) => {
    if (target) playback?.pause()
  }), [playback])

  const seek = (seconds: number) => {
    if (!player) return
    const clamped = Math.max(0, Math.min(player.duration, seconds))
    player.currentTime = clamped
    setCurrentTime(clamped)
  }

  const togglePlayback = () => {
    if (!player) {
      playWhenReady.current = true
      setWantPlayer(true)
      return
    }
    if (playing) playback?.pause()
    else playback?.start()
  }

  /** Есть что играть — или ещё не знаем: ▶ показываем, как у видео. */
  const playable = Boolean(player) || (canPlayGif() && !still)

  const onScrubStart = useProgressScrub({
    groupRef,
    itemW: item.w,
    draggable,
    seekRatio: (ratio) => { if (player) seek(ratio * player.duration) },
  })

  useMediaPlayerHotkeys({
    enabled: Boolean(selected && playable),
    onToggle: togglePlayback,
    onStep: (direction, big) => {
      if (!player) return
      if (big) seek(player.currentTime + direction)
      else player.step(direction)
    },
  })

  function togglePlay(e: KEvent): void {
    e.cancelBubble = true
    if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return
    // В наборе сравнения клик добавляет объект в сравнение, а не запускает.
    if (getCompareSession()?.phase === 'picking') {
      toggleCompareCandidate(item.id)
      return
    }
    // Первый клик ТОЛЬКО выделяет, играть просят вторым — как у видео.
    const wasSelected = Boolean(selected)
    store.select(item.id, e.evt.shiftKey)
    if (!shouldTogglePlaybackOnClick({ wasSelected, shiftKey: e.evt.shiftKey })) return
    if (playable) togglePlayback()
  }

  const captureFrame = async (e: Konva.KonvaEventObject<any>) => {
    e.cancelBubble = true
    if (!player || capturing) return
    setCapturing(true)
    try {
      // На сетевой доске файл обязан уехать на сервер команды (boardUploader).
      await captureFrameToCanvas(store, item, async () => {
        const canvas = document.createElement('canvas')
        canvas.width = player.canvas.width
        canvas.height = player.canvas.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Failed to get the canvas 2D context')
        context.drawImage(player.canvas, 0, 0)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (!blob) throw new Error('Failed to capture the frame')
        return { blob, width: canvas.width, height: canvas.height, name: `frame${formatMediaTime(player.currentTime)}.png` }
      }, boardMediaUploader())
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : t('Failed to extract a frame from the GIF'))
    } finally {
      setCapturing(false)
    }
  }

  const progressHeight = hovered ? 12 : 6
  const duration = player?.duration ?? 0
  const timeBadgeRightReserved = hovered
    ? mediaTimeBadgeRightReservation(
        measureTextWidth(mediaTimeBadgeText(currentTime, duration), MEDIA_TIME_BADGE_FONT),
        item.w,
      )
    : 0

  return (
    <Group
      id={item.id}
      // Размер и скругление — для кольца выделения (SelectionRings).
      selectionFrame={{ w: item.w, h: item.h, radius }}
      ref={groupRef}
      x={item.x}
      y={item.y}
      rotation={item.rotation}
      draggable={draggable}
      onDragStart={(e) => onCanvasItemDragStart(store, item.id, e)}
      onDragMove={(e) => onCanvasItemDragMove(store, item.id, e)}
      onDragEnd={(e) => onDragEnd(store, item.id, e)}
      onTransform={() => groupRef.current && onTransformPreview(store, item.id, groupRef.current)}
      onTransformEnd={() => groupRef.current && onTransformEnd(store, item.id, groupRef.current)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {!img && (
        <Rect
          width={item.w}
          height={item.h}
          fill="#e7e4de"
          cornerRadius={radius}
          perfectDrawEnabled={false}
          listening={false}
        />
      )}
      <KonvaImage
        ref={ref}
        image={player?.canvas ?? img}
        width={item.w}
        height={item.h}
        cornerRadius={radius}
        perfectDrawEnabled={false}
        onClick={togglePlay}
        onTap={(e) => togglePlay(e as unknown as KEvent)}
        onDblClick={() => {
          requestPromptFill({ shapeId: item.id, prompt: item.prompt, modelId: item.modelId, referenceIds: item.referenceIds })
          const validRefs = (item.referenceIds || []).filter((id) => Boolean(store.getItem(id)))
          store.setSelection(validRefs)
        }}
      />
      {playable && (
        <PlayPauseOverlay
          w={item.w}
          h={item.h}
          playing={playing}
          selected={selected}
          hovered={hovered}
          onToggle={togglePlay}
        />
      )}
      <Rect
        width={item.w}
        height={item.h}
        stroke={tc.itemBorder}
        strokeWidth={1}
        strokeScaleEnabled={false}
        cornerRadius={radius}
        perfectDrawEnabled={false}
        listening={false}
      />
      {item.prompt && <LeftAccentStrip itemH={item.h} radius={radius} store={store} />}
      {item.mark != null && <MarkBadge mark={item.mark} store={store} itemW={item.w} />}
      {img && hovered && (
        <Group listening={false}>
          <ItemInfoBadge
            store={store}
            itemW={item.w}
            itemH={item.h}
            bottomOffset={player ? progressHeight : 0}
            rightReserved={player ? timeBadgeRightReserved : 0}
            parts={infoLineParts({
              name: item.name,
              modelName: modelDisplayName(item.modelId),
              naturalWidth: item.naturalWidth ?? img.naturalWidth,
              naturalHeight: item.naturalHeight ?? img.naturalHeight,
              fileSize,
            })}
          />
          {player && (
            <MediaTimeBadge
              w={item.w}
              h={item.h}
              bottomOffset={progressHeight}
              currentTime={currentTime}
              duration={duration}
            />
          )}
        </Group>
      )}
      {player && hovered && (
        <CaptureFrameButton
          cx={MUTE_CX}
          scale={videoControlScale(item.w, item.h)}
          capturing={capturing}
          onCapture={captureFrame}
        />
      )}
      {player && (
        <MediaProgressBar
          w={item.w}
          h={item.h}
          height={progressHeight}
          progress={duration ? currentTime / duration : 0}
          color={tc.spinnerColor}
          cornerRadius={radius}
          onScrubStart={onScrubStart}
        />
      )}
    </Group>
  )
})

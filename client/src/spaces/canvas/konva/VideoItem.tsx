import Konva from 'konva'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Circle, Group, Image as KonvaImage, Line, Rect } from 'react-konva'
import { useVideoEl } from './media'
import { getCompareSession, toggleCompareCandidate } from '../compare/compareBus'
import { onTimelineTarget } from '../timeline/timelineBus'
import { requestPromptFill } from '../promptFillBus'
import { MarkBadge } from './MarkBadge'
import { ItemInfoBadge } from './ItemInfoBadge'
import { infoLineParts } from './itemInfoLine'
import { modelDisplayName } from '../genOptions'
import { mediaCornerRadius } from './canvasLayout'
import {
  measureTextWidth,
  onCanvasItemDragMove,
  onCanvasItemDragStart,
  onDragEnd,
  onTransformEnd,
  onTransformPreview,
  selectOnClick,
  useArrival,
  useMediaSize,
  useThemeColors,
  type ItemProps,
  type KEvent,
} from './itemHelpers'
import { LeftAccentStrip } from './ImageItem'
import { showErrorToast } from '../toastBus'
import { boardMediaUploader } from './boardUploader'
import {
  CAPTURE_CX,
  captureFrameToCanvas,
  MUTE_CX,
  VIDEO_CONTROL_CY,
  VIDEO_CONTROL_INSET,
  VIDEO_FRAME_CAPTURE_SIZE,
  videoControlScale,
} from './videoFrameCapture'
import { createCanvasVideoPlaybackCommands, shouldTogglePlaybackOnClick } from './videoPlaybackCoordinator'
import { CaptureFrameButton, MediaProgressBar, MediaTimeBadge, PlayPauseOverlay } from './mediaPlayerChrome'
import { useMediaPlayerHotkeys, useProgressScrub } from './useMediaPlayerInput'
import { usePausedVideoStill } from './videoStillFrame'
import {
  MEDIA_TIME_BADGE_FONT,
  mediaTimeBadgeRightReservation,
  mediaTimeBadgeText,
} from './mediaBadgeLayout'
import { useT } from '../../../i18n/context.js'

const warmCloudVideo = (_src?: string): void => {}

export const VideoItem = memo(function VideoItem({
  item,
  store,
  draggable,
  selected,
  viewScale = 1,
}: ItemProps & { viewScale?: number }) {
  const t = useT()
  // Одно скругление на кадр, подложку, рамку и полосы — постоянное на экране.
  const radius = mediaCornerRadius(viewScale, item.w, item.h)
  const video = useVideoEl(item.src)
  const ref = useRef<Konva.Image>(null)
  const groupRef = useRef<Konva.Group>(null)
  const tc = useThemeColors()
  const [playing, setPlaying] = useState(false)
  const [hovered, setHovered] = useState(false)
  const fileSize = useMediaSize(item.src, hovered)
  useArrival(store, item.id, () => groupRef.current, Boolean(video))

  // Стоящий ролик рисуется снимком кадра: из самого <video> браузер достаёт
  // кадр заново на каждой перерисовке холста (см. videoStillFrame).
  const still = usePausedVideoStill(video, playing, () => ref.current?.getLayer()?.batchDraw(), item.src)

  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muteHovered, setMuteHovered] = useState(false)
  const [capturing, setCapturing] = useState(false)

  /** Выключить или вернуть звук этого видео. Пишем в объект без шага истории:
   *  Ctrl+Z должен отменять правки холста, а не приглушение соседнего клипа. */
  const toggleMuted = (e: Konva.KonvaEventObject<unknown>) => {
    e.cancelBubble = true
    store.updateItem(item.id, { muted: !item.muted }, false)
  }
  const playback = useMemo(() => video
    ? createCanvasVideoPlaybackCommands(store, item.id, video, {
        setPlaying,
        setCurrentTime,
        redraw: () => ref.current?.getLayer()?.batchDraw(),
      })
    : undefined, [video, store, item.id])

  useEffect(() => () => playback?.release(), [playback])

  // Ролик сетевой доски качается целиком, только когда его СМОТРЯТ: для кадра
  // на холсте браузеру хватает куска (см. cloudVideoWarm).
  useEffect(() => {
    if (playing) warmCloudVideo(item.src)
  }, [playing, item.src])

  useEffect(() => {
    if (video && video.videoWidth && video.videoHeight && (item.naturalWidth !== video.videoWidth || item.naturalHeight !== video.videoHeight)) {
      store.updateItem(item.id, {
        naturalWidth: video.videoWidth,
        naturalHeight: video.videoHeight,
      }, false)
    }
  }, [video, item.id, item.naturalWidth, item.naturalHeight, store])

  // Звук объекта. Поле живёт в самом item, поэтому состояние переживает и
  // культинг (фигура за краем экрана размонтируется), и перезагрузку доски.
  useEffect(() => {
    if (video) video.muted = item.muted === true
  }, [video, item.muted])

  // Синхронизация времени и общей длительности
  useEffect(() => {
    if (!video) return
    video.loop = true
    const updateTime = () => setCurrentTime(video.currentTime)
    const updateDuration = () => setDuration(video.duration || 0)

    video.addEventListener('timeupdate', updateTime)
    video.addEventListener('durationchange', updateDuration)
    video.addEventListener('loadedmetadata', updateDuration)

    setCurrentTime(video.currentTime)
    setDuration(video.duration || 0)

    return () => {
      video.removeEventListener('timeupdate', updateTime)
      video.removeEventListener('durationchange', updateDuration)
      video.removeEventListener('loadedmetadata', updateDuration)
    }
  }, [video])

  // как только готов кадр-постер — перерисовываем слой, иначе Konva рисует чёрное.
  useEffect(() => {
    if (!video) return
    const redraw = () => ref.current?.getLayer()?.batchDraw()
    video.addEventListener('seeked', redraw)
    video.addEventListener('loadeddata', redraw)
    const onEnded = () => playback?.finish()
    video.addEventListener('ended', onEnded)
    const timers = [0, 120, 350, 700].map((ms) => window.setTimeout(redraw, ms))
    return () => {
      video.removeEventListener('seeked', redraw)
      video.removeEventListener('loadeddata', redraw)
      video.removeEventListener('ended', onEnded)
      timers.forEach((t) => window.clearTimeout(t))
    }
  }, [video, playback])

  // пока играет — перерисовываем слой под НОВЫЙ КАДР видео
  // (requestVideoFrameCallback, ~24–30fps у типичного клипа), а не гоним
  // пустую Konva.Animation на 60fps; без поддержки API — прежний фолбэк
  type VideoFrameCapable = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number
    cancelVideoFrameCallback?: (handle: number) => void
  }
  useEffect(() => {
    if (!playing || !video || !ref.current) return
    const layer = ref.current.getLayer()
    if (!layer) return
    const frameVideo = video as VideoFrameCapable
    if (typeof frameVideo.requestVideoFrameCallback !== 'function') {
      const anim = new Konva.Animation(() => {}, layer)
      anim.start()
      return () => {
        anim.stop()
      }
    }
    let handle = 0
    let cancelled = false
    const step = () => {
      if (cancelled) return
      layer.batchDraw()
      handle = frameVideo.requestVideoFrameCallback!(step)
    }
    handle = frameVideo.requestVideoFrameCallback!(step)
    return () => {
      cancelled = true
      frameVideo.cancelVideoFrameCallback?.(handle)
    }
  }, [playing, video])

  // сворачивание/уход во вкладку — автопауза видео для экономии CPU/GPU
  useEffect(() => {
    if (!video || !playing) return
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        playback?.pause()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [video, playing, playback])

  // Перемотка за полосу — общая с GIF (useMediaPlayerInput): слушатели на
  // window живут только пока тянем полосу.
  const handleScrubStart = useProgressScrub({
    groupRef,
    itemW: item.w,
    draggable,
    seekRatio: (ratio) => {
      if (!video) return
      video.currentTime = ratio * (video.duration || 0)
      setCurrentTime(video.currentTime)
      ref.current?.getLayer()?.batchDraw()
    },
  })

  // Вход в режим правки останавливает воспроизведение на холсте: клип
  // начинает играть в оверлее, и два звука одновременно — просто каша.
  useEffect(() => onTimelineTarget((target) => {
    // Без проверки playing: она держится в состоянии React, а состояние
    // может отстать. Пауза уже поставленного на паузу видео безвредна, а
    // вот пропущенная — это два звука одновременно.
    if (target) playback?.pause()
  }), [playback])

  // Клавиши выделенного клипа — общие с GIF (useMediaPlayerInput).
  useMediaPlayerHotkeys({
    enabled: Boolean(selected && video),
    onToggle: () => {
      if (playing) playback?.pause()
      else playback?.start()
    },
    onStep: (direction, big) => {
      if (!video) return
      const step = big ? 1.0 : 0.04
      video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + direction * step))
      setCurrentTime(video.currentTime)
      ref.current?.getLayer()?.batchDraw()
    },
  })

  const captureFrame = async (e: Konva.KonvaEventObject<any>) => {
    e.cancelBubble = true
    if (!video || capturing) return
    setCapturing(true)
    try {
      // ⚠️ Не общая заливка на свой сервер: на сетевой доске файл обязан уехать
      // команды и получить assetId, иначе правка не пройдёт разбор и положит
      // связь целиком (см. boardUploader). Ожидание при этом видно карточкой.
      await captureFrameToCanvas(store, item, async () => {
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth || 640
        canvas.height = video.videoHeight || 360
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Failed to get the canvas 2D context')
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (!blob) throw new Error('Failed to get the frame capture Blob')
        return { blob, width: canvas.width, height: canvas.height, name: `frame_${Date.now()}.png` }
      }, boardMediaUploader())
    } catch (err) {
      console.error('[VideoItem] Frame capture error:', err)
      showErrorToast(err instanceof Error ? err.message : t('Failed to extract a frame from the video'))
    } finally {
      setCapturing(false)
    }
  }

  function togglePlay(e: KEvent): void {
    e.cancelBubble = true
    if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return
    // в режиме набора сравнения клик по видео добавляет его в сравнение,
    // а не запускает воспроизведение
    if (getCompareSession()?.phase === 'picking') {
      toggleCompareCandidate(item.id)
      return
    }
    // Первый клик ТОЛЬКО выделяет. Раньше он сразу запускал воспроизведение,
    // и любое обращение к клипу — выделить, чтобы перетащить, взять
    // референсом или открыть правку — начиналось со звука, который потом
    // приходилось гасить. Играть просят вторым кликом по уже выделенному.
    const wasSelected = Boolean(selected)
    store.select(item.id, e.evt.shiftKey)
    if (!shouldTogglePlaybackOnClick({ wasSelected, shiftKey: e.evt.shiftKey })) return
    if (!video) return
    if (playing) playback?.pause()
    else playback?.start()
  }

  // Кнопки кадра и звука растут и уменьшаются вместе с клипом, как кнопка
  // «играть»: иначе на маленьком ролике они закрывают кадр, а на большом по
  // ним не попасть.
  const controlScale = videoControlScale(item.w, item.h)
  const progressHeight = hovered ? 12 : 6
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
      <Rect width={item.w} height={item.h} fill="#1a1a1f" cornerRadius={radius} perfectDrawEnabled={false} listening={false} />
      <KonvaImage
        ref={ref}
        image={still ?? video}
        width={item.w}
        height={item.h}
        cornerRadius={radius}
        perfectDrawEnabled={false}
        onClick={togglePlay}
        onTap={togglePlay}
        onDblClick={() => {
          requestPromptFill({ shapeId: item.id, prompt: item.prompt, modelId: item.modelId, referenceIds: item.referenceIds })
          const validRefs = (item.referenceIds || []).filter((id) => Boolean(store.getItem(id)))
          store.setSelection(validRefs)
        }}
      />
      <PlayPauseOverlay w={item.w} h={item.h} playing={playing} selected={selected} hovered={hovered} onToggle={togglePlay} />
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
      {video && hovered && (
        <Group listening={false}>
          <ItemInfoBadge
            store={store}
            itemW={item.w}
            itemH={item.h}
            bottomOffset={progressHeight}
            rightReserved={timeBadgeRightReserved}
            parts={infoLineParts({
              name: item.name,
              modelName: modelDisplayName(item.modelId),
              naturalWidth: item.naturalWidth ?? video.videoWidth,
              naturalHeight: item.naturalHeight ?? video.videoHeight,
              fileSize,
            })}
          />
          <MediaTimeBadge w={item.w} h={item.h} bottomOffset={progressHeight} currentTime={currentTime} duration={duration} />
        </Group>
      )}
      {/* Кнопка звука — первая, у самого угла (просьба 21.09.2026). Слышно
          видео только пока оно играет, поэтому кнопка живёт по ховеру. */}
      {video && hovered && (
        <Group
          scaleX={controlScale}
          scaleY={controlScale}
          onClick={toggleMuted}
          onTap={toggleMuted}
          onMouseEnter={() => setMuteHovered(true)}
          onMouseLeave={() => setMuteHovered(false)}
        >
          <Rect
            x={MUTE_CX - VIDEO_FRAME_CAPTURE_SIZE / 2}
            y={VIDEO_CONTROL_INSET}
            width={VIDEO_FRAME_CAPTURE_SIZE}
            height={VIDEO_FRAME_CAPTURE_SIZE}
            fill="rgba(0,0,0,0.001)"
            perfectDrawEnabled={false}
          />
          <Circle
            x={MUTE_CX}
            y={VIDEO_CONTROL_CY}
            radius={19}
            fill={muteHovered ? 'rgba(224, 60, 48, 0.95)' : 'rgba(22, 24, 29, 0.8)'}
            stroke="rgba(255, 255, 255, 0.15)"
            strokeWidth={1}
            perfectDrawEnabled={false}
          />
          {/* корпус динамика */}
          <Rect
            x={MUTE_CX - 8}
            y={VIDEO_CONTROL_CY - 3}
            width={4}
            height={6}
            fill="#fff"
            cornerRadius={1}
            perfectDrawEnabled={false}
          />
          {/* конус динамика */}
          <Line
            points={[MUTE_CX - 4, VIDEO_CONTROL_CY - 3, MUTE_CX, VIDEO_CONTROL_CY - 8, MUTE_CX, VIDEO_CONTROL_CY + 8, MUTE_CX - 4, VIDEO_CONTROL_CY + 3]}
            closed
            fill="#fff"
            perfectDrawEnabled={false}
          />
          {item.muted ? (
            /* перечёркнут — звука нет */
            <Line
              points={[MUTE_CX + 3, VIDEO_CONTROL_CY - 5, MUTE_CX + 10, VIDEO_CONTROL_CY + 5]}
              stroke="#fff"
              strokeWidth={2}
              lineCap="round"
              perfectDrawEnabled={false}
            />
          ) : (
            /* волна — звук идёт */
            <Line
              points={[MUTE_CX + 4, VIDEO_CONTROL_CY - 4, MUTE_CX + 7, VIDEO_CONTROL_CY, MUTE_CX + 4, VIDEO_CONTROL_CY + 4]}
              stroke="#fff"
              strokeWidth={1.8}
              lineCap="round"
              lineJoin="round"
              perfectDrawEnabled={false}
            />
          )}
        </Group>
      )}
      {/* Кнопка захвата кадра — следом за звуком, тем же кружком */}
      {video && hovered && (
        <CaptureFrameButton cx={CAPTURE_CX} scale={controlScale} capturing={capturing} onCapture={captureFrame} />
      )}
      {video && (
        <MediaProgressBar
          w={item.w}
          h={item.h}
          height={progressHeight}
          progress={duration ? currentTime / duration : 0}
          color={tc.spinnerColor}
          cornerRadius={radius}
          onScrubStart={handleScrubStart}
        />
      )}
    </Group>
  )
})

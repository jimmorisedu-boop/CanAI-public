import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { notify } from '../spaces/canvas/notifications'
import {
  isLostLocalLaunch,
  isOrphanedLaunch,
  LOST_LOCAL_LAUNCH,
  ORPHANED_LAUNCH,
} from '../spaces/canvas/pendingLaunchState'
import { PENDING_LEASE_REFUSED, withBoardLease } from '../spaces/canvas/konva/boardLeaseActions'
import { canRetryCard, forgetCardRetry, retryCard } from '../spaces/canvas/konva/transientCardRetry'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import {
  cancelGeneration,
  generationConnectionLabel,
  getGenerationTasks,
  subscribeGenerationTasks,
} from '../spaces/canvas/generationRegistry'
import { DEFAULT_FONT_SIZE, textPadding } from '../spaces/canvas/konva/canvasLayout'
import { isPlaceholder, type BoardItem } from './boardGestures'
import { previewSrc } from './remoteSession'
import { isAnimatedImageItem } from '../spaces/canvas/konva/animatedImageItem'
import { IconCamera, IconClose, IconMute, IconSound, IconRun, IconPause } from '../ui/icons'
import { captureVideoFrameAt } from '../spaces/canvas/timeline/captureFrame'
import type { TabletMediaUploader } from './runtime'
import { boardObjectLabel } from './boardObjectNavigation'
import { watchTabletVideo, type TabletVideoState } from './tabletVideoRecovery'
import { tabletVideoActionsStyle } from './tabletVideoActions'
import { tabletSystemMessage, tabletSystemStatus } from './tabletSystemMessage'
import { MediaPlaybackControls } from '../ui/MediaPlaybackControls'
import { cachedVideoStillDataUrl, rememberVideoStill } from '../spaces/canvas/konva/videoStillFrame'
import { useT } from '../i18n/context.js'


// Один объект доски. Простые теги вместо холста: картинка — <img>, видео —
// <video playsinline>, звук — <audio>. Так браузер сам занимается декодом,
// памятью и энергосбережением, а нам не приходится держать всё это в одном
// растре, как на компьютере.

function PendingCard({ item, scale, store, readOnly }: {
  item: Extract<BoardItem, { status: unknown }>
  scale: number
  store: CanvasStore
  readOnly?: boolean
}) {
  const t = useT()
  const generationTasks = useSyncExternalStore(
    subscribeGenerationTasks,
    getGenerationTasks,
    getGenerationTasks,
  )
  const generationTask = item.jobId
    ? generationTasks.find((task) => task.jobId === item.jobId)
    : undefined
  const connectionLabel = generationConnectionLabel(generationTask?.connection)
  const displayedConnectionLabel = connectionLabel
    ? tabletSystemStatus(connectionLabel)
    : null
  // При подтверждённом 404 sink может быть не смонтирован (например, доска
  // открыта только для чтения). В таком случае карточка всё равно должна
  // закончиться сообщением, а не продолжать крутиться бесконечно.
  const deliveryFailed = generationTask?.connection === 'delivery-error'
  const lostLocalLaunch = isLostLocalLaunch(item)
  // Брошенный запуск (номер задачи так и не пришёл) планшет сам не чинит —
  // только показывает сбоем, как и потерянный местный запуск.
  const orphanedLaunch = isOrphanedLaunch(item, Date.now())
  const loading = item.status === 'loading' && !deliveryFailed && !lostLocalLaunch && !orphanedLaunch
  const [seconds, setSeconds] = useState(() => Math.floor((Date.now() - item.startedAt) / 1000))
  useEffect(() => {
    if (!loading) return
    const timer = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - item.startedAt) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [loading, item.startedAt])

  const failed = item.status === 'error' || deliveryFailed || lostLocalLaunch || orphanedLaunch
  // Карточка переноса файла при вставке с другой доски живёт только в этой
  // вкладке: ход переноса у неё в `stage`, а повтор — в реестре вкладки
  // (transientCardRetry). Правило то же, что у карточки на компьютере.
  const transientStage = item.transient && item.stage ? item.stage : null
  const cardRetry = failed && canRetryCard(item.id)
  const visibleError = item.error ?? (lostLocalLaunch
    ? LOST_LOCAL_LAUNCH
    : orphanedLaunch
      ? ORPHANED_LAUNCH
      : deliveryFailed ? generationTask?.error ?? 'Task not found' : undefined)
  const displayedError = visibleError
    ? tabletSystemMessage(visibleError, t('Generation failed.'))
    : undefined
  const displayedStage = transientStage
    ? tabletSystemStatus(transientStage)
    : null
  // ⚠️ Крестик держит ЭКРАННЫЙ размер — тем же приёмом, что метка и кнопки
  // видео. Карточка живёт в мировых координатах доски, и на отдалённом плане
  // от кнопки оставалась точка, в которую пальцем не попасть (жалоба
  // 09.09.2026 «очень маленький крестик у плашки, которая появляется, если
  // генерация не получилась»). А убрать упавшую карточку надо ровно там, где
  // её увидели, — не приближаясь к ней специально.
  const screenScale = 1 / Math.max(scale, 0.15)
  return (
    <div className={`tablet-pending ${failed ? 'failed' : ''}`}>
      {!failed && <span className="tablet-spinner" aria-hidden="true" />}
      <strong>{item.label}</strong>
      <span className="tablet-pending-note">
        {failed ? displayedError ?? t('Generation failed.') : displayedStage ?? displayedConnectionLabel ?? `${seconds}  s`}
      </span>
      {!readOnly && cardRetry && <button
        type="button"
        className="ui-btn tablet-pending-retry"
        data-tablet-interactive
        style={{ transform: `translateX(-50%) scale(${screenScale})` }}
        onClick={() => { retryCard(item.id) }}
      >

        {t('Retry')}
      </button>}
      {!readOnly && <button
        type="button"
        className="ui-icon-btn tablet-pending-close"
        data-tablet-interactive
        style={{ transform: `scale(${screenScale})` }}
        aria-label={failed ? t('Remove card') : t('Cancel generation')}
        onClick={() => {
          if (item.jobId && !failed) void cancelGeneration(item.jobId)
          // ⚠️ Убрать карточку на сетевой доске можно только с арендой — без
          // неё стор молча возвращается, и крестик не делает ничего.
          forgetCardRetry(item.id)
          void withBoardLease(store, item.id, () => store.dismissPendingById(item.id))
            .then((admitted) => { if (!admitted) notify({ kind: 'error', message: t(PENDING_LEASE_REFUSED) }) })
        }}
      >
        <IconClose size={18} />
      </button>}
    </div>
  )
}

export function BoardItemView({
  item,
  selected,
  scale,
  pixelRatio = 1,
  selectionMode = false,
  groupSelected = false,
  controlsHidden = false,
  onDetails,
  readOnly = false,
  playbackOnly = readOnly,
  upload,
  store,
}: {
  item: BoardItem
  selected: boolean
  scale: number
  pixelRatio?: number
  selectionMode?: boolean
  groupSelected?: boolean
  controlsHidden?: boolean
  onDetails?(id: string): void
  readOnly?: boolean
  playbackOnly?: boolean
  upload?: TabletMediaUploader
  store: CanvasStore
}) {
  const t = useT()
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const videoRecovery = useRef<ReturnType<typeof watchTabletVideo> | null>(null)
  const [videoState, setVideoState] = useState<TabletVideoState>('loading')
  const [playback, setPlayback] = useState({ playing: false, time: 0, duration: 0 })
  const placeholder = isPlaceholder(item)
  const videoSrc = !placeholder && item.kind === 'video' ? item.src : undefined
  const [videoPoster, setVideoPoster] = useState<string | undefined>(() => cachedVideoStillDataUrl(videoSrc))
  useEffect(() => {
    setVideoPoster(cachedVideoStillDataUrl(videoSrc))
  }, [videoSrc])
  const rememberPoster = () => {
    const video = videoRef.current
    if (!video || !videoSrc) return
    if (rememberVideoStill(videoSrc, video)) setVideoPoster(cachedVideoStillDataUrl(videoSrc))
  }
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoSrc) return
    const recovery = watchTabletVideo(video, setVideoState)
    videoRecovery.current = recovery
    return () => { recovery.dispose(); videoRecovery.current = null }
  }, [videoSrc])
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoSrc || !selected) return
    const update = () => setPlayback({ playing: !video.paused && !video.ended, time: video.currentTime || 0, duration: Number.isFinite(video.duration) ? video.duration : 0 })
    const events = ['play', 'pause', 'ended', 'timeupdate', 'durationchange', 'loadedmetadata']
    events.forEach((name) => video.addEventListener(name, update))
    update()
    return () => events.forEach((name) => video.removeEventListener(name, update))
  }, [videoSrc, selected])

  return (
    <div
      className={`tablet-item ${selected ? 'selected' : ''}`}
      data-item-id={item.id}
      role="group"
      aria-label={`${placeholder ? item.label : boardObjectLabel(item)}${selected ? `, ${t('selected')}` : ''}`}
      style={{ left: item.x, top: item.y, width: item.w, height: item.h }}
    >
      {!placeholder && item.kind === 'image' && (item.prompt || item.modelId) && <button type="button" data-tablet-interactive className="tablet-generation-corner" aria-label={t('Generation settings')} onClick={() => onDetails?.(item.id)} style={{ transform: `scale(${1 / Math.max(scale, .15)})` }} />}
      <div
        className="tablet-item-inner"
        style={{ transform: `rotate(${('rotation' in item ? item.rotation : 0) ?? 0}deg)` }}
      >
        {placeholder ? (
          <PendingCard item={item} scale={scale} store={store} readOnly={readOnly} />
        ) : item.kind === 'image' ? (
          <img
            // ⚠️ Превью GIF — застывший первый кадр (WebP): берём оригинал,
            // и <img> браузер проигрывает сам (см. animatedImageItem).
            src={isAnimatedImageItem(item) ? item.src : previewSrc(item.src, Math.max(item.w, item.h) * scale * pixelRatio)}
            alt={item.name ?? ''}
            // ⚠️ Не отдалось превью — показываем ОРИГИНАЛ, а не дыру. Превью
            // это удобство: сервер мог не успеть его собрать, запрос мог
            // оборваться на переполненной очереди, файл мог оказаться не
            // картинкой. На месте объекта оставался значок битого файла, и со
            // стороны это читалось как «картинки пропадают» (жалоба
            // 08.09.2026). На компьютере такой запасной путь есть давно
            // (useImageEl со вторым адресом) — планшет остался без него.
            onError={(event) => {
              const image = event.currentTarget
              if (item.src && image.getAttribute('src') !== item.src) image.src = item.src
            }}
            // loading="lazy" здесь ВРЕДЕН: culling и так рисует только то, что
            // в кадре, а браузер внутри трансформированного слоя нередко
            // считает картинку невидимой и не грузит её вовсе — на месте
            // объекта остаётся пустой прямоугольник (поймано живым прогоном).
            decoding="async"
            draggable={false}
          />
        ) : item.kind === 'video' ? (
          <div
            className="tablet-media-player"
            data-tablet-interactive={playbackOnly && selected && !selectionMode ? '' : undefined}
          >
            <video
              ref={videoRef}
              src={item.src}
              poster={videoPoster}
              playsInline
              crossOrigin="anonymous"
              preload="metadata"
              muted={item.muted ?? false}
              // Пока видео не тронули, браузер показывает ЧЁРНЫЙ прямоугольник —
              // по нему не понять, что это за клип. Перемотка на десятую долю
              // секунды даёт настоящий кадр (тот же приём, что на компьютере,
              // где постер рисуется через seek + перерисовку слоя).
              onLoadedData={rememberPoster}
              onPause={rememberPoster}
            />
            {playbackOnly && selected && !selectionMode && <MediaPlaybackControls key={`${item.id}:${item.src}`} mediaRef={videoRef} />}
            {videoState === 'loading' && <div className="tablet-video-recovery tablet-video-loading" role="status">
              <span className="tablet-spinner" aria-hidden="true" />
              <span>{t('Loading video…')}</span>
            </div>}
            {videoState === 'error' && <div className="tablet-video-recovery" data-tablet-interactive>
              <span role="status">{t('Video did not load')}</span>
              <button type="button" className="ui-btn" onClick={() => videoRecovery.current?.retry()}>{t('Retry loading')}</button>
            </div>}
          </div>
        ) : item.kind === 'audio' ? (
          <div className="tablet-audio" data-tablet-interactive={selected && !selectionMode ? '' : undefined}>
            <strong>{item.name ?? 'track'}</strong>
            <audio
              ref={audioRef}
              src={item.src}
              preload="metadata"
            />
            {selected && !selectionMode && <MediaPlaybackControls key={`${item.id}:${item.src}`} mediaRef={audioRef} />}
          </div>
        ) : item.kind === 'link' ? (
          <div className="tablet-link">
            <strong>{item.link?.title ?? item.link?.url ?? 'link'}</strong>
            <span>{item.link?.provider ?? ''}</span>
          </div>
        ) : (
          <div
            className="tablet-text"
            style={{
              fontSize: item.fontSize ?? DEFAULT_FONT_SIZE,
              // Отступ пропорционален кеглю — то же правило, что на компьютере
              // (canvasLayout.textPadding), иначе текст прилипает к рамке.
              padding: textPadding(item.fontSize ?? DEFAULT_FONT_SIZE),
            }}
          >
            {item.text}
          </div>
        )}
      </div>
      {!controlsHidden && !readOnly && !placeholder && selected && !selectionMode && !groupSelected && item.kind === 'video' && (
        <div
          className="tablet-video-actions"
          data-tablet-interactive
          style={tabletVideoActionsStyle(scale)}
        >
          <button
            type="button"
            className="tablet-video-action"
            aria-label={playback.playing ? t('Pause video') : t('Play video')}
            title={playback.playing ? t('Pause') : t('Play')}
            onClick={() => {
              const video = videoRef.current
              if (!video) return
              if (!video.paused && !video.ended) video.pause()
              else {
                if (video.ended) video.currentTime = 0
                void video.play().catch(() => notify({ kind: 'error', message: t('Could not play video') }))
              }
            }}
          >{playback.playing ? <IconPause size={20} /> : <IconRun size={20} />}</button>
          <input
            className="tablet-video-seek"
            type="range"
            aria-label={t('Video position')}
            min={0}
            max={playback.duration || 1}
            step={0.05}
            value={Math.min(playback.time, playback.duration || 1)}
            disabled={playback.duration <= 0}
            onChange={(event) => {
              const video = videoRef.current
              if (!video) return
              const time = Number(event.currentTarget.value)
              video.currentTime = time
              setPlayback((current) => ({ ...current, time }))
            }}
          />
          <button
            type="button"
            className="tablet-video-action"
            aria-label={item.muted ? t('Turn sound on') : t('Turn sound off')}
            title={item.muted ? t('Turn sound on') : t('Turn sound off')}
            onClick={() => {
              const muted = !(item.muted ?? false)
              if (videoRef.current) videoRef.current.muted = muted
              store.updateItem(item.id, { muted })
            }}
          >
            {item.muted ? <IconMute size={20} /> : <IconSound size={20} />}
          </button>
          <button
            type="button"
            className="tablet-video-action"
            aria-label={t('Capture frame')}
            title={t('Capture frame')}
            onClick={() => void captureVideoFrameAt(store, item, videoRef.current?.currentTime ?? 0, videoRef.current, upload)}
          >
            <IconCamera size={20} />
          </button>
        </div>
      )}
      {!placeholder && item.mark !== undefined && (
        // Метка держит экранный размер при отдалении: иначе на общем плане
        // от неё остаётся точка.
        <span className="tablet-mark" style={{ transform: `scale(${1 / Math.max(scale, 0.15)})` }}>
          {item.mark}
        </span>
      )}
      {!placeholder && selectionMode && (
        <span
          className={`tablet-selection-check ${selected ? 'on' : ''}`}
          style={{ transform: `scale(${1 / Math.max(scale, 0.15)})` }}
          aria-hidden="true"
        >
          {selected ? '✓' : ''}
        </span>
      )}
    </div>
  )
}

/**
 * Объект доски без лишних перерисовок (пункт 3.8, С-9): панорама меняет
 * только камеру, и объектам с прежними пропсами перерисовываться незачем —
 * стор неизменяемый, ссылка на объект меняется только вместе с ним.
 */
export const MemoBoardItemView = memo(BoardItemView)

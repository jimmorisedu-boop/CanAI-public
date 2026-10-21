import { useEffect, useRef, useState } from 'react'
import { IconBack } from '../../../ui/icons'
import { useDialogFocus } from '../../../ui/dialogFocus'
import { extractAudioFromItem } from '../konva/extractAudio'
import type { CanvasStore } from '../konva/canvasStore'
import { TimelineFramesShelf } from './TimelineFramesShelf'
import { TimelineMontage } from './TimelineMontage'
import { TimelinePreview } from './TimelinePreview'
import { TimelineTrack } from './TimelineTrack'
import { TimelineTransport } from './TimelineTransport'
import { runTimelineCommand } from './timelineCommands'
import { setTimelinePresentation } from './timelineBus'
import { dispatchTimelineKey } from './timelineKeys'
import { notifyInTimeline } from './timelineNotice'
import { timecode } from './timelineTimecode'
import type { FrameCaptureRecord } from './frameCaptureQueue'
import type { TimelineSession } from './useTimelineSession'
import { useFrameCapture } from './useFrameCapture'
import { useTimelineFrameActions } from './useTimelineFrameActions'
import { useTimelinePlayback } from './useTimelinePlayback'
import { useTimelineStatus } from './useTimelineStatus'
import { useTimelineZoom } from './useTimelineZoom'
import { useWindowKeydown } from './useWindowKeydown'
import { useT } from '../../../i18n/context.js'


// Оверлей правки клипа. Вся арифметика — в timelineModel и useTimelineSession,
// здесь только сборка: плеер (превью + транспорт), плёнка и ряд монтажа.
// Раскладка сверху вниз — по утверждённому макету: видео занимает всё свободное
// место, полка кадров лежит поверх него и видео не сжимает, а плёнка и монтаж
// стоят одним столбцом под плеером.

export function TimelineOverlay({ session, store }: { session: TimelineSession; store: CanvasStore }) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const shelfToggleRef = useRef<HTMLButtonElement>(null)
  // Что показывает превью, пока тянут ручку или стык (null — голову).
  const [previewTime, setPreviewTime] = useState<number | null>(null)
  // Презентация режима (§9.1 ТЗ). overlay — видимая правка клипа; canvas —
  // оверлей спрятан, и человек видит настоящий CanvasItem на доске. Сеанс при
  // этом ЖИВОЙ: очередь кадров, резы, кроп и зум никуда не деваются, Escape
  // возвращает в оверлей с тем же моментом.
  const [presentation, setPresentation] = useState<'overlay' | 'canvas'>('overlay')
  const inCanvas = presentation === 'canvas'

  const { facts, inPoint, outPoint, head } = session
  const duration = facts?.duration || 1
  // Шаг стрелки — ровно кадр. Без известной частоты берём 25: это ближе к
  // правде, чем произвольная доля секунды, и хотя бы предсказуемо.
  const frameStep = 1 / (facts?.fps || 25)
  const shownTime = previewTime ?? head

  const frames = useFrameCapture(store, session.item)
  const status = useTimelineStatus(frames.records)
  const playback = useTimelinePlayback(videoRef, session, shownTime)
  const zoom = useTimelineZoom(viewportRef, stageRef)

  function backToVideo(): void {
    setPresentation('overlay')
    dialogRef.current?.focus({ preventScroll: true })
  }

  const frameActions = useTimelineFrameActions({
    store,
    frames,
    openOnCanvas: () => setPresentation('canvas'),
  })

  // Презентацию публикуем в шину, чтобы канвас снял режимную рамку (prompt-dock
  // и остальные плашки холста снова видны), пока человек смотрит на CanvasItem.
  useEffect(() => {
    setTimelinePresentation(inCanvas ? 'canvas' : 'overlay')
    return () => setTimelinePresentation('overlay')
  }, [inCanvas])

  // Фокус не должен уходить из режима по Tab на кнопки холста под затемнением:
  // они там есть, но нажимать их сейчас нельзя. Пока презентация «canvas»,
  // Escape принадлежит возврату на оверлей (см. обработчик клавиш), а закрытию
  // режима — нет.
  useDialogFocus(dialogRef, () => {
    if (inCanvas) return
    session.close()
  })
  // Окно берёт фокус на себя, а не на первую кнопку: первой в разметке стоит
  // «Вписать кадр», и при входе с клавиатуры она встречала бы кольцом фокуса и
  // подсказкой, которых никто не просил. Эффект стоит ПОСЛЕ useDialogFocus —
  // тот ставит фокус на первую кнопку, этот его перебивает.
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true })
  }, [])

  function toggleShelf(): void {
    const next = !frames.open
    frames.setOpen(next)
    // Закрыли — фокус остаётся на шевроне: он и открывалка, и закрывалка, а
    // карточка, на которой мог стоять фокус, исчезает вместе с лентой.
    if (!next) shelfToggleRef.current?.focus({ preventScroll: true })
  }

  function captureHere(): void {
    const outcome = frames.capture(head)
    if (!outcome) return
    const at = timecode(outcome.record.requestedTime)
    notifyInTimeline(outcome.kind === 'duplicate'
      ? { kind: 'info', tone: 'warn', message: `This moment is already saved: ${at}`, replaceKey: 'timeline-capture' }
      : { kind: 'info', message: `Frame ${at} — saving…`, replaceKey: 'timeline-capture' })
  }

  function toggleCrop(): void {
    const willBeOn = !session.crop
    session.toggleCrop()
    notifyInTimeline({
      kind: 'info',
      message: willBeOn ? 'Crop frame enabled' : 'Cropping disabled',
      replaceKey: 'timeline-crop',
    })
  }

  /** Клик по метке на плёнке или по миниатюре на полке: выбрать кадр и поставить
   *  головку ровно в его время. */
  function selectFrame(record: FrameCaptureRecord): void {
    playback.pause()
    session.setHead(record.requestedTime)
    frames.select(record.id)
  }

  function stepBy(seconds: number): void {
    playback.pause()
    session.setHead(head + seconds)
  }

  function extractAudio(): void {
    void extractAudioFromItem(store, session.item.id)
  }

  useWindowKeydown((event) => {
    // Пока человек в «показано на холсте», таймлайн-клавиши молчат — иначе F
    // съедал бы кадр, а Enter применял, невидимо для полуприкрытой доски.
    // Живой только Escape: он возвращает презентацию в overlay (§9.1 ТЗ).
    if (inCanvas) {
      if (event.code === 'Escape' || event.key === 'Escape') {
        event.preventDefault()
        backToVideo()
      }
      return
    }
    const target = event.target as HTMLElement | null
    const command = dispatchTimelineKey({
      code: event.code,
      key: event.key,
      context: {
        defaultPrevented: event.defaultPrevented,
        repeat: event.repeat,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
        inInput: Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)),
        onNativeButton: Boolean(target && target.tagName === 'BUTTON'),
      },
    })
    if (!command) return
    runTimelineCommand(command, {
      head,
      inPoint,
      outPoint,
      duration,
      frameStep,
      targetIsButton: Boolean(target && target.tagName === 'BUTTON'),
      prevent: () => event.preventDefault(),
      close: session.close,
      apply: () => void session.apply(),
      togglePlay: playback.togglePlay,
      pause: playback.pause,
      setHead: session.setHead,
      cut: session.addCut,
      toggleDrop: session.toggleDropAtHead,
      markIn: session.moveIn,
      markOut: session.moveOut,
      capture: captureHere,
      crop: toggleCrop,
      audio: extractAudio,
      toggleShelf,
      fit: zoom.reset,
      showFrame: () => frameActions.show(null),
      downloadFrame: () => frameActions.download(null),
    })
  })

  return (
    <div
      className={`timeline-overlay${inCanvas ? ' canvas' : ''}`}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('Clip editing')}
      tabIndex={-1}
    >
      <div className="tl-player">
        <TimelinePreview
          session={session}
          videoRef={videoRef}
          viewportRef={viewportRef}
          stageRef={stageRef}
          zoom={zoom.zoom}
          zoomed={zoom.zoomed}
          viewportProps={zoom.viewportProps}
          onFit={zoom.reset}
        >
          <TimelineFramesShelf
            records={frames.records}
            selectedId={frames.selectedId}
            open={frames.open}
            toggleRef={shelfToggleRef}
            onToggle={toggleShelf}
            onSelect={selectFrame}
            onRetry={frames.retry}
            onCancel={frames.cancel}
            onRemove={frameActions.remove}
            onShow={frameActions.show}
            onDownload={frameActions.download}
          />
        </TimelinePreview>
        <TimelineTransport
          playing={playback.playing}
          muted={playback.muted}
          ready={Boolean(facts)}
          time={shownTime}
          status={status}
          onStepBack={() => stepBy(-frameStep)}
          onPlay={playback.togglePlay}
          onStepForward={() => stepBy(frameStep)}
          onToggleMute={playback.toggleMute}
          onCapture={captureHere}
        />
      </div>

      <TimelineTrack
        session={session}
        frames={frames.records}
        selectedFrameId={frames.selectedId}
        playing={playback.playing}
        onPause={playback.pause}
        onPreview={setPreviewTime}
        onSelectFrame={selectFrame}
      />

      <TimelineMontage session={session} onToggleCrop={toggleCrop} onExtractAudio={extractAudio} />

      {/* После «показать на холсте» оверлей спрятан целиком, а вернуться из
          презентации иначе нечем, кроме клавиши. Плашка — единственное, что
          остаётся видимым (см. .tl-back в timeline.css). */}
      {inCanvas && (
        <button type="button" className="ui-btn tl-back" aria-keyshortcuts="Escape" onClick={backToVideo}>
          <IconBack size={14} />{t('Return to video · Esc')}
        </button>
      )}
    </div>
  )
}

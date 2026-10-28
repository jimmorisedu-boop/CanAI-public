import { useEffect, useRef, useState } from 'react'
import { IconBack } from '../../../ui/icons'
import { useDialogFocus } from '../../../ui/dialogFocus'
import { extractAudioFromItem } from '../konva/extractAudio'
import type { CanvasStore } from '../konva/canvasStore'
import { TimelineMontage } from './TimelineMontage'
import { TimelinePreview } from './TimelinePreview'
import { TimelineTrack } from './TimelineTrack'
import { TimelineTransport } from './TimelineTransport'
import { runTimelineCommand } from './timelineCommands'
import { setTimelinePresentation } from './timelineBus'
import { dispatchTimelineKey } from './timelineKeys'
import { keptSegments, totalLength } from './timelineModel'
import { notifyInTimeline } from './timelineNotice'
import { timecode } from './timelineTimecode'
import type { FrameCaptureRecord } from './frameCaptureQueue'
import type { TimelineSession } from './useTimelineSession'
import { useClipAudioPeaks } from './useClipAudioPeaks'
import { useFrameCapture } from './useFrameCapture'
import { useTimelineFrameActions } from './useTimelineFrameActions'
import { useTimelinePlayback } from './useTimelinePlayback'
import { useTimelineStatus } from './useTimelineStatus'
import { useTimelineTimeZoom } from './useTimelineTimeZoom'
import { useTimelineZoom } from './useTimelineZoom'
import { useWindowKeydown } from './useWindowKeydown'
import { useT } from '../../../i18n/context.js'

// Оверлей правки клипа. Вся арифметика — в timelineModel и useTimelineSession,
// здесь только сборка: единый плеер (превью со всплывающей полкой + центрированный
// транспорт), двухэтажная дорожка с зумом времени (Alt + колесо) и ряд монтажа.

export function TimelineOverlay({ session, store }: { session: TimelineSession; store: CanvasStore }) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const shelfToggleRef = useRef<HTMLButtonElement>(null)
  const [previewTime, setPreviewTime] = useState<number | null>(null)
  const [presentation, setPresentation] = useState<'overlay' | 'canvas'>('overlay')
  const inCanvas = presentation === 'canvas'

  const { facts, inPoint, outPoint, head } = session
  const duration = facts?.duration || 1
  const frameStep = 1 / (facts?.fps || 25)
  const shownTime = previewTime ?? head
  const keptDuration = totalLength(keptSegments(session.segments, session.dropped))

  const frames = useFrameCapture(store, session.item)
  const status = useTimelineStatus(frames.records)
  const playback = useTimelinePlayback(videoRef, session, shownTime)
  const zoom = useTimelineZoom(viewportRef, stageRef)
  const timeZoom = useTimelineTimeZoom(dialogRef, trackRef, duration, head)
  const peaks = useClipAudioPeaks(session.item.src, facts?.hasAudio, session.item.peaks)

  function backToVideo(): void {
    setPresentation('overlay')
    dialogRef.current?.focus({ preventScroll: true })
  }

  const frameActions = useTimelineFrameActions({
    store,
    frames,
    openOnCanvas: () => setPresentation('canvas'),
  })

  useEffect(() => {
    setTimelinePresentation(inCanvas ? 'canvas' : 'overlay')
    return () => setTimelinePresentation('overlay')
  }, [inCanvas])

  useDialogFocus(dialogRef, () => {
    if (inCanvas) return
    session.close()
  })

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true })
  }, [])

  function toggleShelf(): void {
    const next = !frames.open
    frames.setOpen(next)
    if (!next) shelfToggleRef.current?.focus({ preventScroll: true })
  }

  function captureHere(): void {
    const outcome = frames.capture(head)
    if (!outcome) return
    const at = timecode(outcome.record.requestedTime)
    notifyInTimeline(outcome.kind === 'duplicate'
      ? { kind: 'info', tone: 'warn', message: t('This moment is already saved: {0}', { 0: at }), replaceKey: 'timeline-capture' }
      : { kind: 'info', message: t('Frame {0} — saving…', { 0: at }), replaceKey: 'timeline-capture' })
  }

  function toggleCrop(): void {
    const willBeOn = !session.crop
    session.toggleCrop()
    notifyInTimeline({
      kind: 'info',
      message: willBeOn ? t('Crop frame enabled') : t('Cropping disabled'),
      replaceKey: 'timeline-crop',
    })
  }

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
      cuts: session.cuts.map((cut) => cut.time),
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
      trimLeft: session.trimLeftAtHead,
      trimRight: session.trimRightAtHead,
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
          shelf={{
            records: frames.records,
            selectedId: frames.selectedId,
            open: frames.open,
            toggleRef: shelfToggleRef,
            onToggle: toggleShelf,
            onSelect: selectFrame,
            onRetry: frames.retry,
            onCancel: frames.cancel,
            onRemove: frameActions.remove,
            onShow: frameActions.show,
            onDownload: frameActions.download,
          }}
        />
        <TimelineTransport
          playing={playback.playing}
          muted={playback.muted}
          ready={Boolean(facts)}
          time={shownTime}
          keptDuration={keptDuration}
          status={status}
          frameCount={frames.records.length}
          shelfOpen={frames.open}
          shelfToggleRef={shelfToggleRef}
          onToggleShelf={toggleShelf}
          onStepBack={() => stepBy(-frameStep)}
          onPlay={playback.togglePlay}
          onStepForward={() => stepBy(frameStep)}
          onToggleMute={playback.toggleMute}
          onCapture={captureHere}
        />
      </div>

      <TimelineTrack
        session={session}
        trackRef={trackRef}
        timeZoom={timeZoom}
        peaks={peaks}
        frames={frames.records}
        selectedFrameId={frames.selectedId}
        playing={playback.playing}
        onPause={playback.pause}
        onPreview={setPreviewTime}
        onSelectFrame={selectFrame}
      />

      <TimelineMontage session={session} onToggleCrop={toggleCrop} onExtractAudio={extractAudio} />

      {inCanvas && (
        <button type="button" className="ui-btn tl-back" aria-keyshortcuts="Escape" onClick={backToVideo}>
          <IconBack size={14} />{t('Return to video · Esc')}
        </button>
      )}
    </div>
  )
}

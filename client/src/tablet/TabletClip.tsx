import { useEffect, useRef, useState } from 'react'
import { IconCamera, IconCrop, IconMenu, IconRestore, IconScissors, IconSound, IconTrash } from '../ui/icons'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { extractAudioFromItem } from '../spaces/canvas/konva/extractAudio'
import type { TabletMediaUploader } from './runtime'
import { getTimelineTarget, setTimelineTarget } from '../spaces/canvas/timeline/timelineBus'
import { useTimelineSession } from '../spaces/canvas/timeline/useTimelineSession'
import { useFrameCapture } from '../spaces/canvas/timeline/useFrameCapture'
import { SavedFramesDrawer } from '../spaces/canvas/timeline/SavedFramesDrawer'
import { segmentAt } from '../spaces/canvas/timeline/timelineModel'
import { TabletFullScreen } from './TabletFullScreen'
import { ClipTrack } from './ClipTrack'
import { confirmDiscardDraft } from './confirmDiscardDraft'
import { TabletClipPreview } from './TabletClipPreview'
import { TabletClipCropPanel } from './TabletClipCropPanel'
import { InlineNotice } from '../ui/InlineNotice'
import { clearTimelineNotice, getTimelineNotice, onTimelineNotice } from '../spaces/canvas/timeline/timelineNotice'
import { tabletSystemMessage } from './tabletSystemMessage'
import { MediaPlaybackControls } from '../ui/MediaPlaybackControls'
import { bindClipMediaGuards, syncClipMedia } from './clipPlaybackBounds'

function isCompactCropViewport(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(orientation: portrait), (max-width: 800px)').matches
  }
  return window.innerWidth <= 800 || window.innerHeight > window.innerWidth
}

export function TabletClipFeedback({ error }: { error: string | null }) {
  const [notice, setNotice] = useState(getTimelineNotice)
  useEffect(() => {
    const unsubscribe = onTimelineNotice(next => setNotice(current => next ?? (current?.kind === 'error' ? current : null)))
    return () => { unsubscribe(); clearTimelineNotice() }
  }, [])
  if (!error && !notice) return null
  return <InlineNotice className="tablet-error" tone={error ? 'error' : notice!.kind}
    title={error ? tabletSystemMessage(error, 'Clip editing failed.') : tabletSystemMessage(notice!.message, 'Clip editing failed.')}
    action={notice?.action ? { label: notice.action.label, onClick: notice.action.run } : undefined}
    onDismiss={error ? undefined : () => { setNotice(null); clearTimelineNotice() }} />
}

// Правка клипа пальцем: обрезка, резы, кадр, звук, кадрирование.
//
// Весь разбор — общий с компьютером (useTimelineSession): резы, склейки,
// пороги и вызовы ffmpeg живут там. Здесь только дорожка под палец: она шире,
// метки крупнее, а стык двигается пальцем без промаха в один пиксель.

export function TabletClip({
  store,
  upload,
  itemId,
  tool,
  onClose,
}: {
  store: CanvasStore
  upload: TabletMediaUploader
  itemId: string
  tool?: 'audio'
  onClose(): void
}) {
  const session = useTimelineSession(store)
  const sessionRef = useRef(session)
  sessionRef.current = session
  // Полка кадров планшета — та же очередь, что на компьютере, но со своим
  // upload-путьём планшета (передаётся сюда как `upload`).
  const frames = useFrameCapture(store, session?.item ?? null, { upload: upload as never })
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const moreWrapRef = useRef<HTMLDivElement>(null)
  const [busyNote, setBusyNote] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [cropPanelOpen, setCropPanelOpen] = useState(true)
  const [compactCropViewport, setCompactCropViewport] = useState(false)
  const previousCompactCropViewport = useRef(false)
  const applyingRef = useRef(false)
  const startedAudio = useRef(false)

  // React StrictMode intentionally mounts, cleans up, and mounts effects once
  // in development. Deferring the target clear lets that probe cleanup be
  // cancelled by the second setup while still closing the editor on a real
  // unmount.
  const clearTargetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (clearTargetTimer.current !== null) {
      clearTimeout(clearTargetTimer.current)
      clearTargetTimer.current = null
    }
    return () => {
      clearTargetTimer.current = setTimeout(() => {
        clearTargetTimer.current = null
        if (getTimelineTarget() === itemId) setTimelineTarget(null)
      }, 0)
    }
  }, [itemId])

  // The dedicated timeline owns seeking. Keep the media element at the same
  // clamped head after trim handles or keyboard commands move the session, and
  // stop playback at the selected out point instead of letting it run past the
  // editable range.
  useEffect(() => {
    const video = videoRef.current
    const currentSession = sessionRef.current
    if (!video || !currentSession) return
    syncClipMedia(video, currentSession, 'head')
  }, [session?.head, session?.inPoint, session?.outPoint, session?.item.src])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    return bindClipMediaGuards(video, () => sessionRef.current)
  }, [session?.item.src])

  useEffect(() => {
    const update = () => setCompactCropViewport(isCompactCropViewport())
    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])

  useEffect(() => {
    if (compactCropViewport && !previousCompactCropViewport.current) setCropPanelOpen(false)
    previousCompactCropViewport.current = compactCropViewport
  }, [compactCropViewport])

  useEffect(() => {
    if (!moreOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && moreWrapRef.current?.contains(target)) return
      setMoreOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMoreOpen(false)
      moreButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [moreOpen])

  // «Отделить звук» из инспектора открывает тот же режим и сразу делает своё
  // дело: отдельного экрана ради одной кнопки заводить не за что.
  useEffect(() => {
    if (tool !== 'audio' || startedAudio.current || !session) return
    startedAudio.current = true
    void extractAudioFromItem(store, itemId).then(onClose)
  }, [tool, session, store, itemId, onClose])

  if (!session) return null

  const duration = session.facts?.duration ?? 0
  // Кусок под курсором: от него зависит, что делает кнопка и как она названа.
  const headSegment = segmentAt(session.segments, session.head)
  const headDropped = Boolean(headSegment && session.dropped.includes(headSegment.start))

  const seek = (time: number) => {
    const next = Math.max(session.inPoint, Math.min(time, session.outPoint))
    session.setHead(next)
    const video = videoRef.current
    if (video && Number.isFinite(next)) {
      syncClipMedia(video, session, 'head')
    }
  }

  const closeMore = () => {
    setMoreOpen(false)
    moreButtonRef.current?.focus()
  }

  const apply = async () => {
    if (applyingRef.current) return
    applyingRef.current = true
    setBusyNote('Cutting…')
    try {
      if (await session.apply() === 'applied') onClose()
    } finally {
      applyingRef.current = false
      setBusyNote(null)
    }
  }

  const close = async () => {
    if (applyingRef.current || session.busy) return
    const dirty = session.inPoint !== 0 || session.outPoint !== duration || session.cuts.length > 0 || session.crop !== null
    if (!await confirmDiscardDraft(dirty)) return
    session.close()
    onClose()
  }

  return (
    <TabletFullScreen
      title="Clip editing"
      subtitle={
        <span className="tablet-mono">
          {session.item.name ?? 'clip'}
          {session.facts?.width ? ` · ${session.facts.width} × ${session.facts.height}` : ''}
          {duration ? ` · ${duration.toFixed(1)}  s` : ''}
        </span>
      }
      onCancel={close}
      tone="dark"
      className="tablet-clip-editor"
      primary={
        <button
          type="button"
          className="ui-btn primary"
          disabled={session.busy || Boolean(busyNote) || session.loading || Boolean(session.error) || session.pieces === 0}
          onClick={() => void apply()}
        >
          {busyNote ?? `Apply · ${session.summary}`}
        </button>
      }
      footer={
        <div className="tablet-clip-tools" role="toolbar" aria-label="Clip tools">
          <button type="button" className="ui-btn" aria-label="Cut" onClick={() => session.addCut()}>
            <IconScissors size={18} /> <span className="tablet-clip-tool-label">Cut</span>
          </button>
          <button type="button" className={`ui-btn ${session.crop ? 'on' : ''}`} aria-label="Crop" aria-pressed={Boolean(session.crop)} onClick={() => {
            session.toggleCrop()
            setCropPanelOpen(!compactCropViewport)
          }}>
            <IconCrop size={18} /> <span className="tablet-clip-tool-label">Crop</span>
          </button>
          <button type="button" className="ui-btn" aria-label="Capture frame" onClick={() => frames.capture(session.head)}>
            <IconCamera size={18} /> <span className="tablet-clip-tool-label">Capture frame</span>
          </button>
          <span className="tablet-full-gap" />
          <div ref={moreWrapRef} className="tablet-clip-more-wrap">
            <button
              type="button"
              className={`ui-btn ${moreOpen ? 'on' : ''}`}
              ref={moreButtonRef}
              aria-expanded={moreOpen}
              aria-controls="tablet-clip-more"
              onClick={() => setMoreOpen((value) => !value)}
            >
              <IconMenu size={18} /> More
            </button>
            {moreOpen && <div id="tablet-clip-more" className="tablet-clip-more" role="group" aria-label="More clip tools">
              <button type="button" className={`ui-btn ${headDropped ? 'on' : ''}`} disabled={!headSegment} onClick={() => { session.toggleDropAtHead(); closeMore() }}>
                {headDropped ? <IconRestore size={18} /> : <IconTrash size={18} />}
                {headDropped ? 'Restore segment' : 'Delete segment'}
              </button>
              {session.cuts.map(cut => (
                <button key={cut.time} type="button" className="ui-btn" disabled={session.busy} onClick={() => { session.removeCut(cut.time); closeMore() }}>
                  Join at {cut.time.toFixed(2)} s
                </button>
              ))}
              <button type="button" className={`ui-btn ${frames.records.length ? 'on' : ''}`} aria-expanded={frames.open} disabled={frames.records.length === 0} onClick={() => { frames.setOpen(!frames.open); closeMore() }}>
                <IconCamera size={18} /> Frames · {frames.records.length}
              </button>
              <button type="button" className="ui-btn" disabled={session.facts ? !session.facts.hasAudio : false} onClick={() => { closeMore(); void extractAudioFromItem(store, session.item.id) }}>
                <IconSound size={18} /> Extract audio
              </button>
              <label className={`tablet-clip-auto ${session.autoOn ? 'on' : ''}`}>
                <input type="checkbox" checked={session.autoOn} onChange={() => session.toggleAuto()} />
                <span>{session.autoBusy ? 'Finding cuts…' : 'Find cuts'}</span>
              </label>
              {session.autoOn && <label className="tablet-clip-threshold">
                <span>Sensitivity</span>
                <input type="range" min={0.05} max={0.9} step={0.01} value={session.threshold} aria-label="Cut sensitivity" onChange={(event) => session.setThreshold(Number(event.target.value))} />
              </label>}
            </div>}
          </div>
        </div>
      }
    >
      <TabletClipFeedback error={session.error} />
      <div className="tablet-clip-editor-body">
        <div className="tablet-clip-workspace">
          <section className="tablet-clip-preview-area" aria-label="Video preview">
            <TabletClipPreview session={session} videoRef={videoRef} />
          </section>
          <TabletClipCropPanel session={session} open={cropPanelOpen} onOpenChange={setCropPanelOpen} />
        </div>
        <div className="tablet-clip-timeline">
          <ClipTrack
            session={session}
            onSeek={seek}
            transport={<MediaPlaybackControls key={session.item.src} mediaRef={videoRef} showSeek={false} className="tablet-clip-transport" />}
          />
        </div>
      </div>

      {frames.open && (
        <div className="tablet-shelf" role="region" aria-label="Captured frames shelf">
          <SavedFramesDrawer
            frames={frames.records}
            onRetry={frames.retry}
            onCancel={frames.cancel}
            onRemove={(id) => {
              const rec = frames.records.find((r) => r.id === id)
              if (rec?.resultItemId) store.removeItems([rec.resultItemId])
              frames.drop(id)
            }}
            onShow={(id) => {
              const rec = frames.records.find((r) => r.id === id)
              if (rec?.resultItemId) {
                store.revealItems([rec.resultItemId])
                onClose()
              }
            }}
            onDownload={(id) => {
              const rec = frames.records.find((r) => r.id === id)
              if (rec?.resultUrl) {
                const a = document.createElement('a')
                a.href = rec.resultUrl
                a.download = `frame ${rec.requestedTime.toFixed(2)}  s.png`
                document.body.appendChild(a)
                a.click()
                a.remove()
              }
            }}
            onSeek={(time) => {
              if (videoRef.current) videoRef.current.pause()
              session.setHead(time)
            }}
          />
        </div>
      )}
    </TabletFullScreen>
  )
}

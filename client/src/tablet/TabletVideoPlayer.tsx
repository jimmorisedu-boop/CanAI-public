import { useEffect, useRef, useState } from 'react'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { frameBlob } from '../spaces/canvas/konva/videoFrameReader'
import type { TabletMediaUploader } from './runtime'
import { adjacentFrameTime, readVideoFrameTimes } from './videoFrameIndex'
import { placeVideoFrames, type UploadedVideoFrame } from './videoFrameSelection'
import { InlineNotice } from '../ui/InlineNotice'
import { IconCamera, IconClose, IconPause, IconRun } from '../ui/icons'
import { tabletSystemMessage } from './tabletSystemMessage'
import { cachedVideoStillDataUrl, rememberVideoStill } from '../spaces/canvas/konva/videoStillFrame'

interface SelectedFrame { id: number; blob: Blob; preview: string; width: number; height: number; time: number; uploaded?: UploadedVideoFrame }
export function TabletVideoPlayer({ item, store, upload, onLayout, onSelection, onAdded }: {
  item: CanvasItem & { src: string }; store?: CanvasStore; upload?: TabletMediaUploader
  onLayout(): void; onSelection(count: number, busy: boolean): void; onAdded(): void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState({ time: 0, duration: 0, playing: false, ready: false })
  const [poster, setPoster] = useState<string | undefined>(() => cachedVideoStillDataUrl(item.src))
  const [times, setTimes] = useState<number[]>([])
  const [indexError, setIndexError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frames, setFrames] = useState<SelectedFrame[]>([])
  const latest = useRef(frames); latest.current = frames
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const alive = useRef(true)
  const abort = useRef(new AbortController())
  useEffect(() => {
    setPoster(cachedVideoStillDataUrl(item.src))
  }, [item.src])
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    abort.current = controller
    void readVideoFrameTimes(item.src, controller.signal).then(value => { if (alive.current) setTimes(value) })
      .catch(() => { if (alive.current && !controller.signal.aborted) setIndexError('Frame-by-frame seeking is unavailable for this file. Seeking by seconds and snapshots are available.') })
    return () => {
      alive.current = false; controller.abort()
      latest.current.forEach(frame => URL.revokeObjectURL(frame.preview))
    }
  }, [item.src])
  useEffect(() => onSelection(frames.length, busy), [frames.length, busy, onSelection])
  const update = () => {
    const el = video.current
    if (el) setState({ time: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : 0, playing: !el.paused && !el.ended, ready: el.readyState >= 2 && !el.seeking })
  }
  const rememberPoster = () => {
    if (video.current && rememberVideoStill(item.src, video.current)) setPoster(cachedVideoStillDataUrl(item.src))
  }
  const seek = (time: number) => {
    const el = video.current
    if (!el || inFlight.current) return
    el.pause(); el.currentTime = Math.max(0, Math.min(time, Math.max(0, state.duration - .000001)))
    update()
  }
  const capture = async () => {
    if (inFlight.current || !video.current || !state.ready) return
    if (frames.length >= 20) { setError('Add the selected 20 frames to the canvas before choosing more'); return }
    inFlight.current = true; setBusy(true); setError(null)
    const el = video.current
    el.pause()
    const time = el.currentTime
    try {
      const result = await frameBlob(item.src, time, { video: el })
      if (!alive.current) return
      if (latest.current.reduce((sum, frame) => sum + frame.blob.size, result.blob.size) > 64 * 1024 * 1024) throw new Error('Add the selected frames to the canvas to free memory')
      setFrames(current => [...current, { ...result, time, id: Date.now(), preview: URL.createObjectURL(result.blob) }])
    } catch (error) { if (alive.current) setError(tabletSystemMessage(error, 'Could not capture frame')) }
    finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  const add = async () => {
    if (!store || !upload || inFlight.current || !frames.length) return
    inFlight.current = true; setBusy(true); setError(null)
    try {
      for (const frame of frames) {
        if (!frame.uploaded) {
          const result = await upload(new File([frame.blob], `Frame ${frame.time.toFixed(3)} s.png`, { type: 'image/png' }), abort.current.signal)
          frame.uploaded = { ...result, width: frame.width, height: frame.height, time: frame.time }
        }
      }
      if (!alive.current) return
      placeVideoFrames(store, store.getItem(item.id) ?? item, frames.map(frame => frame.uploaded!))
      frames.forEach(frame => URL.revokeObjectURL(frame.preview))
      latest.current = []; setFrames([]); onAdded()
    } catch (error) { if (alive.current) setError(tabletSystemMessage(error, 'Could not add frames')) }
    finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  return <div className="tablet-video-workspace">
    <video ref={video} src={item.src} poster={poster} playsInline preload="auto" crossOrigin="anonymous"
      onLoadedMetadata={() => { update(); onLayout() }} onLoadedData={() => { rememberPoster(); update() }} onTimeUpdate={update}
      onPlay={update} onPause={() => { rememberPoster(); update() }} onEnded={update} onSeeking={update} onSeeked={update}
      onError={() => setError('Video did not load. Close the viewer and try loading it again.')} />
    <div className="tablet-video-frame-controls" onDoubleClick={event => event.stopPropagation()}>
      <input type="range" min={0} max={state.duration || 1} step="any" value={state.time} aria-label="Video position" disabled={!state.duration || busy} onChange={event => seek(Number(event.target.value))} />
      <div className="tablet-video-frame-buttons">
        <button className="ui-btn" type="button" disabled={!times.length || busy} title="Previous frame" aria-label="Previous frame" onClick={() => seek(adjacentFrameTime(times, video.current?.currentTime ?? 0, -1))}>|‹</button>
        <button className="ui-btn" type="button" disabled={!state.duration || busy} onClick={() => seek((video.current?.currentTime ?? 0) - 1)}>−1 s</button>
        <button className="ui-btn" type="button" disabled={!state.duration || busy} aria-label={state.playing ? 'Pause' : 'Play'} onClick={() => {
          const el = video.current; if (!el) return
          if (!el.paused) el.pause()
          else void el.play().catch(() => setError('Could not play video'))
        }}>{state.playing ? <IconPause size={18} /> : <IconRun size={18} />}</button>
        <button className="ui-btn" type="button" disabled={!state.duration || busy} onClick={() => seek((video.current?.currentTime ?? 0) + 1)}>+1 s</button>
        <button className="ui-btn" type="button" disabled={!times.length || busy} title="Next frame" aria-label="Next frame" onClick={() => seek(adjacentFrameTime(times, video.current?.currentTime ?? 0, 1))}>›|</button>
        <span>{state.time.toFixed(3)} / {state.duration.toFixed(2)} s</span>
        {store && upload && <button className="ui-btn" type="button" aria-label="Choose frame" disabled={!state.ready || busy} onClick={() => void capture()}><IconCamera size={18} /></button>}
      </div>
      {indexError && <InlineNotice tone="info" title={indexError} />}
      {error && <InlineNotice tone="error" title={tabletSystemMessage(error, 'Video operation failed')} onDismiss={() => setError(null)} />}
      {frames.length > 0 && <div className="tablet-video-frame-basket">
        <div className="tablet-video-frame-strip">{frames.map(frame => <div key={frame.id}>
          <img src={frame.preview} alt={`Frame ${frame.time.toFixed(3)} s`} />
          <button className="ui-btn icon-only" type="button" aria-label={`Remove frame ${frame.time.toFixed(3)} s`} disabled={busy} onClick={() => {
            URL.revokeObjectURL(frame.preview); setFrames(current => current.filter(value => value !== frame))
          }}><IconClose size={14} /></button><small>{frame.time.toFixed(3)} s</small>
        </div>)}</div>
        <button className="ui-btn primary" type="button" disabled={busy} onClick={() => void add()}>{busy ? 'Saving…' : `Add frames (${frames.length})`}</button>
      </div>}
    </div>
  </div>
}

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { TimelineSession } from '../spaces/canvas/timeline/useTimelineSession'
import {
  clipSourceSize,
  fitClipPreview,
  type ClipSize,
} from './clipPreviewGeometry'
import { TabletClipCrop } from './TabletClipCrop'

/** Video preview with an explicit aspect-fit frame and source-pixel crop overlay. */
export function TabletClipPreview({
  session,
  videoRef,
}: {
  session: TimelineSession
  videoRef: RefObject<HTMLVideoElement | null>
}) {
  const previewRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState<ClipSize>({ width: 0, height: 0 })
  const [mediaSize, setMediaSize] = useState<ClipSize | null>(null)

  // Read browser dimensions through onLoadedMetadata below. Avoid sampling a
  // previous source's videoWidth during a source switch before loadstart.
  const source = clipSourceSize(session.facts, mediaSize, session.item)
  // The workspace adds another 8px around this preview, leaving 24px for
  // each 44px crop handle without sacrificing a second outer margin.
  const display = fitClipPreview(source, available, 16)

  useEffect(() => {
    setMediaSize(null)
  }, [session.item.src])

  useLayoutEffect(() => {
    const node = previewRef.current
    if (!node) return
    const measure = () => {
      const rect = node.getBoundingClientRect()
      const width = node.clientWidth > 0 ? node.clientWidth : rect.width
      const height = node.clientHeight > 0 ? node.clientHeight : rect.height
      if (!Number.isFinite(width) || !Number.isFinite(height) || !(width > 0) || !(height > 0)) return
      setAvailable((current) => current.width === width && current.height === height ? current : { width, height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const onLoadedMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setMediaSize({ width: video.videoWidth, height: video.videoHeight })
    }
  }

  const onTimeUpdate = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    session.setHead(event.currentTarget.currentTime)
  }

  const stopPreviewPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.stopPropagation()
  }
  const displayStyle = {
    left: display.x,
    top: display.y,
    width: display.width,
    height: display.height,
  }

  return (
    <div
      ref={previewRef}
      className="tablet-clip-preview nodrag nopan nowheel"
      role="group"
      aria-label="Clip preview"
      aria-busy={session.loading ? 'true' : 'false'}
      onPointerDown={stopPreviewPointer}
      onPointerMove={stopPreviewPointer}
      onPointerUp={stopPreviewPointer}
      onPointerCancel={stopPreviewPointer}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="tablet-clip-preview-frame" ref={frameRef} style={displayStyle}>
        <video
          ref={(node) => {
            ;(videoRef as { current: HTMLVideoElement | null }).current = node
          }}
          className="tablet-clip-preview-video"
          src={session.item.src}
          playsInline
          preload="metadata"
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
        />
        <TabletClipCrop session={session} frameRef={frameRef} sourceSize={source} />
      </div>
    </div>
  )
}

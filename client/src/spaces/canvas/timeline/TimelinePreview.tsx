import type { CSSProperties, DOMAttributes, ReactNode, RefObject } from 'react'
import { IconClose, IconFrameFit } from '../../../ui/icons'
import { zoomTransform, type ZoomState } from '../../../ui/useSharedZoom'
import { RATIO_PRESETS } from '../konva/cropMath'
import { TimelineButton } from './TimelineButton'
import { TimelineCropFrame } from './TimelineCropFrame'
import { TimelineFramesShelf } from './TimelineFramesShelf'
import type { FrameCaptureRecord } from './frameCaptureQueue'
import type { TimelineSession } from './useTimelineSession'
import { useT } from '../../../i18n/context.js'

// Превью правки клипа: видео вписано в окно без плашки заголовка поверх кадра;
// в правом верхнем углу — компактные кнопки «вписать кадр» и выход, снизу при
// необходимости открываются пропорции кадрирования и всплывающая полка кадров.

export interface TimelineShelfProps {
  records: readonly FrameCaptureRecord[]
  selectedId: string | null
  open: boolean
  toggleRef: RefObject<HTMLButtonElement>
  onToggle(): void
  onSelect(record: FrameCaptureRecord): void
  onRetry(id: string): void
  onCancel(id: string): void
  onRemove(id: string): void
  onShow(id: string): void
  onDownload(id: string): void
}

export function TimelinePreview({
  session,
  videoRef,
  viewportRef,
  stageRef,
  zoom,
  zoomed,
  viewportProps,
  onFit,
  shelf,
}: {
  session: TimelineSession
  videoRef: RefObject<HTMLVideoElement>
  viewportRef: RefObject<HTMLDivElement>
  stageRef: RefObject<HTMLDivElement>
  zoom: ZoomState
  zoomed: boolean
  viewportProps: Pick<DOMAttributes<HTMLDivElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onDoubleClick'>
  onFit(): void
  shelf?: TimelineShelfProps
  children?: ReactNode
}) {
  const t = useT()
  const { facts } = session
  return (
    <div className="tl-preview">
      <div
        className={`timeline-viewport${zoomed ? ' zoomed' : ''}`}
        ref={viewportRef}
        {...viewportProps}
      >
        <div
          className="timeline-stage"
          ref={stageRef}
          style={{
            ...(facts?.width && facts?.height ? { '--tl-ratio': facts.width / facts.height } : null),
            transform: zoomTransform(zoom),
            '--tl-zoom': zoom.scale,
          } as CSSProperties}
        >
          <video ref={videoRef} src={session.item.src} playsInline preload="metadata" />
          <TimelineCropFrame session={session} stageRef={stageRef} />
        </div>
      </div>

      <div className="tl-preview-top">
        <div className="tl-preview-actions">
          <TimelineButton
            glass
            label={t('Fit frame to window')}
            keys="0"
            shortcut="0"
            placement="bottom-end"
            on={zoomed}
            onClick={onFit}
          >
            <IconFrameFit size={18} />
          </TimelineButton>
          <button type="button" className="timeline-close" onClick={session.close} aria-keyshortcuts="Escape">
            <IconClose size={14} />{t('Esc — exit')}
          </button>
        </div>
      </div>

      {session.crop && (
        <div className="tl-glass tl-presets" role="group" aria-label={t('Crop aspect ratio')}>
          {RATIO_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className={session.cropRatio === preset.value ? 'is-on' : undefined}
              aria-pressed={session.cropRatio === preset.value}
              disabled={!facts?.width || !facts?.height}
              onClick={() => session.setCropRatio(preset.value)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {shelf && (
        <TimelineFramesShelf
          {...shelf}
          abovePresets={Boolean(session.crop)}
        />
      )}
    </div>
  )
}

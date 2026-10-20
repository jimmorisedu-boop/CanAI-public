import type { CSSProperties, DOMAttributes, ReactNode, RefObject } from 'react'
import { IconClose, IconFrameFit } from '../../../ui/icons'
import { zoomTransform, type ZoomState } from '../../../ui/useSharedZoom'
import { RATIO_PRESETS } from '../konva/cropMath'
import { TimelineButton } from './TimelineButton'
import { TimelineCropFrame } from './TimelineCropFrame'
import type { TimelineSession } from './useTimelineSession'
import { systemErrorMessage } from '../../../ui/systemMessage'

// Превью правки клипа: видео вписано в окно, поверх него — стеклянные плашки
// (имя клипа, «вписать кадр», выход, пропорции кадрирования) и полка кадров.
// Всё, что поверх видео, лежит РЯДОМ с областью просмотра, а не внутри неё:
// нажатие по плашке не должно начинать панораму кадра и захватывать указатель.

function describe(session: TimelineSession): string {
  const { facts } = session
  if (!facts) return systemErrorMessage(session.error, 'Reading video…')
  return `${facts.duration.toFixed(1)} s · ${facts.width ?? '?'}×${facts.height ?? '?'} · ${facts.hasAudio ? 'with audio' : 'without audio'}`
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
  children,
}: {
  session: TimelineSession
  videoRef: RefObject<HTMLVideoElement>
  viewportRef: RefObject<HTMLDivElement>
  stageRef: RefObject<HTMLDivElement>
  zoom: ZoomState
  zoomed: boolean
  viewportProps: Pick<DOMAttributes<HTMLDivElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onDoubleClick'>
  onFit(): void
  /** Полка кадров: оверлей внутри превью. */
  children?: ReactNode
}) {
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
            // Пропорция кадра — числом: от неё CSS считает размер сцены так,
            // чтобы кадр вписывался в окно по обеим осям (contain) и при этом
            // ЗАПОЛНЯЛ его — маленький клип не остаётся крошечным по центру.
            ...(facts?.width && facts?.height ? { '--tl-ratio': facts.width / facts.height } : null),
            transform: zoomTransform(zoom),
            // Ручки и обводки делят на этот множитель: иначе при пятикратном
            // приближении они выросли бы в пять раз вместе с кадром.
            '--tl-zoom': zoom.scale,
          } as CSSProperties}
        >
          <video ref={videoRef} src={session.item.src} playsInline preload="metadata" />
          <TimelineCropFrame session={session} stageRef={stageRef} />
        </div>
      </div>

      <div className="tl-preview-top">
        <div className="tl-glass tl-name">
          <strong>{session.item.name || 'clip'}</strong>
          <span>{describe(session)}</span>
        </div>
        <div className="tl-preview-actions">
          <TimelineButton
            glass
            label="Fit frame to window"
            keys="0"
            shortcut="0"
            placement="bottom-end"
            on={zoomed}
            onClick={onFit}
          >
            <IconFrameFit size={18} />
          </TimelineButton>
          {/* Выход — обычная кнопка канона с подписью, та же, что в сравнении:
              из полноэкранного режима выход должен быть виден словами. */}
          <button type="button" className="timeline-close" onClick={session.close} aria-keyshortcuts="Escape">
            <IconClose size={14} />Esc — exit
          </button>
        </div>
      </div>

      {session.crop && (
        <div className="tl-glass tl-presets" role="group" aria-label="Crop aspect ratio">
          {RATIO_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className={session.cropRatio === preset.value ? 'is-on' : undefined}
              aria-pressed={session.cropRatio === preset.value}
              // Без размеров кадра пропорцию не пересчитать: кнопка нажалась бы,
              // подсветилась и ничего не сделала.
              disabled={!facts?.width || !facts?.height}
              onClick={() => session.setCropRatio(preset.value)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {children}
    </div>
  )
}

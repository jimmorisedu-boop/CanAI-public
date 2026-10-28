import type { RefObject } from 'react'
import { IconCamera, IconImage, IconMute, IconPause, IconRun, IconSound, IconStepBack, IconStepForward } from '../../../ui/icons'
import { TimelineButton } from './TimelineButton'
import { clearTimelineNotice } from './timelineNotice'
import type { StatusLine } from './timelineStatus'
import { timecode } from './timelineTimecode'
import { useT } from '../../../i18n/context.js'

// Транспорт непосредственно под видео (закон Фиттса + закон Якоба):
// слева — снятие кадра (S) и всплывающая полка кадров (B), по центру — крупный
// кластер воспроизведения с двойным таймкодом (текущее / живой хронометраж),
// справа — сжимаемая строка состояния.

export function TimelineTransport({
  playing,
  muted,
  ready,
  time,
  keptDuration,
  status,
  frameCount,
  shelfOpen,
  shelfToggleRef,
  onToggleShelf,
  onStepBack,
  onPlay,
  onStepForward,
  onToggleMute,
  onCapture,
}: {
  playing: boolean
  muted: boolean
  ready: boolean
  time: number
  keptDuration: number
  status: StatusLine
  frameCount: number
  shelfOpen: boolean
  shelfToggleRef: RefObject<HTMLButtonElement>
  onToggleShelf(): void
  onStepBack(): void
  onPlay(): void
  onStepForward(): void
  onToggleMute(): void
  onCapture(): void
}) {
  const t = useT()
  return (
    <div className="tl-transport" role="group" aria-label={t('Playback controls')}>
      <div className="tl-transport-left">
        <TimelineButton
          label={t('Capture frame to canvas')}
          text={t('Frame')}
          kbd="S"
          keys="S"
          shortcut="S"
          placement="top-start"
          disabled={!ready}
          onClick={onCapture}
        >
          <IconCamera size={17} />
        </TimelineButton>
        <TimelineButton
          buttonRef={shelfToggleRef}
          label={shelfOpen ? t('Hide saved frames') : t('Show saved frames')}
          text={`${t('Frames')}${frameCount > 0 ? ` · ${frameCount}` : ''}`}
          kbd="B"
          keys="B"
          shortcut="B"
          placement="top-start"
          expanded={shelfOpen}
          on={shelfOpen}
          className="tl-shelf-toggle"
          onClick={onToggleShelf}
        >
          <IconImage size={17} />
        </TimelineButton>
      </div>

      <div className="tl-transport-center">
        <TimelineButton
          label={t('Previous frame')}
          keys="←"
          shortcut="ArrowLeft"
          hint={t('Shift+← steps 10 frames')}
          placement="top"
          disabled={!ready}
          onClick={onStepBack}
        >
          <IconStepBack size={17} />
        </TimelineButton>
        <TimelineButton
          label={playing ? t('Pause') : t('Play')}
          keys="Space"
          shortcut="Space"
          placement="top"
          className="tl-play-btn"
          disabled={!ready}
          onClick={onPlay}
        >
          {playing ? <IconPause size={19} /> : <IconRun size={19} />}
        </TimelineButton>
        <TimelineButton
          label={t('Next frame')}
          keys="→"
          shortcut="ArrowRight"
          hint={t('Shift+→ steps 10 frames')}
          placement="top"
          disabled={!ready}
          onClick={onStepForward}
        >
          <IconStepForward size={17} />
        </TimelineButton>

        <span className="tl-timecode-pair">
          <strong className="tl-timecode">{timecode(time)}</strong>
          <span className="tl-timecode-total">/ {timecode(keptDuration)}</span>
        </span>

        <TimelineButton
          label={muted ? t('Turn preview audio on') : t('Mute preview audio')}
          placement="top"
          on={muted}
          onClick={onToggleMute}
        >
          {muted ? <IconMute size={17} /> : <IconSound size={17} />}
        </TimelineButton>
      </div>

      <span className="tl-live" aria-live="polite" data-tone={status.tone}>
        <span className="tl-live-text">{status.text}</span>
        {status.action && (
          <button
            type="button"
            className="ui-btn quiet tl-live-action"
            onClick={() => { status.action!.run(); clearTimelineNotice() }}
          >
            {status.action.label}
          </button>
        )}
      </span>
    </div>
  )
}

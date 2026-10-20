import { IconCamera, IconMute, IconPause, IconRun, IconSound, IconStepBack, IconStepForward } from '../../../ui/icons'
import { TimelineButton } from './TimelineButton'
import { clearTimelineNotice } from './timelineNotice'
import type { StatusLine } from './timelineStatus'
import { timecode } from './timelineTimecode'

// Транспорт под превью: шаг назад, играть/пауза, шаг вперёд, звук, таймкод,
// живая строка состояния и главная кнопка «Снять кадр на холст». Сообщения
// режима идут в строку состояния, а не плашкой посреди кадра: плашка
// загораживала то, ради чего в режим зашли.

export function TimelineTransport({
  playing,
  muted,
  ready,
  time,
  status,
  onStepBack,
  onPlay,
  onStepForward,
  onToggleMute,
  onCapture,
}: {
  playing: boolean
  muted: boolean
  /** Клип прочитан — шагать и снимать есть что. */
  ready: boolean
  time: number
  status: StatusLine
  onStepBack(): void
  onPlay(): void
  onStepForward(): void
  onToggleMute(): void
  onCapture(): void
}) {
  return (
    <div className="tl-transport" role="group" aria-label="Playback controls">
      <TimelineButton
        label="Previous frame"
        keys="←"
        shortcut="ArrowLeft"
        placement="top-start"
        disabled={!ready}
        onClick={onStepBack}
      >
        <IconStepBack size={18} />
      </TimelineButton>
      <TimelineButton
        label={playing ? 'Pause' : 'Play'}
        keys="Space"
        shortcut="Space"
        placement="top-start"
        disabled={!ready}
        onClick={onPlay}
      >
        {playing ? <IconPause size={18} /> : <IconRun size={18} />}
      </TimelineButton>
      <TimelineButton
        label="Next frame"
        keys="→"
        shortcut="ArrowRight"
        placement="top-start"
        disabled={!ready}
        onClick={onStepForward}
      >
        <IconStepForward size={18} />
      </TimelineButton>
      <TimelineButton
        label={muted ? 'Turn preview audio on' : 'Mute preview audio'}
        placement="top-start"
        on={muted}
        onClick={onToggleMute}
      >
        {muted ? <IconMute size={18} /> : <IconSound size={18} />}
      </TimelineButton>

      <strong className="tl-timecode">{timecode(time)}</strong>

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

      <TimelineButton
        label="Capture frame to canvas"
        keys="F"
        shortcut="F"
        placement="top-end"
        primary
        disabled={!ready}
        onClick={onCapture}
      >
        <IconCamera size={18} />
      </TimelineButton>
    </div>
  )
}

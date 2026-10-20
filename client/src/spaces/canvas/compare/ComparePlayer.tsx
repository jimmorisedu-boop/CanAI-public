import { IconPause, IconRun } from '../../../ui/icons'

// Полоса плеера — ОДНА на обе раскладки сравнения (рядом и наложение).
// Своей логики не держит: всё считает useComparePlayer, здесь только вид.

const RATES = [0.25, 0.5, 1]

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function ComparePlayer({
  playing,
  time,
  duration,
  rate,
  alternate,
  canAlternate,
  onToggle,
  onSeek,
  onRate,
  onAlternate,
  extra,
}: {
  playing: boolean
  time: number
  duration: number
  rate: number
  alternate: boolean
  canAlternate: boolean
  onToggle: () => void
  onSeek: (value: number) => void
  onRate: (value: number) => void
  onAlternate: (value: boolean) => void
  extra?: React.ReactNode
}) {
  return (
    <div className="compare-player">
      <button
        className="compare-play"
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        // не оставляем фокус на кнопке: следующий пробел ушёл бы в неё
        onClick={(event) => {
          event.currentTarget.blur()
          onToggle()
        }}
      >
        {playing ? <IconPause size={16} weight="fill" /> : <IconRun size={16} weight="fill" />}
      </button>
      <span className="compare-time">{formatTime(time)}</span>
      <input
        className="compare-scrub"
        type="range"
        min={0}
        max={Math.max(duration, 0.01)}
        step={0.01}
        value={Math.min(time, duration)}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label="Playback position"
      />
      <span className="compare-time">{formatTime(duration)}</span>
      <div className="compare-rates">
        {RATES.map((value) => (
          <button
            key={value}
            className={`compare-rate ${rate === value ? 'on' : ''}`}
            onClick={() => onRate(value)}
          >
            {value}×
          </button>
        ))}
      </div>
      {canAlternate && (
        <label className="compare-alternate" title="Space switches between the videos, each from the beginning">
          <input type="checkbox" checked={alternate} onChange={(event) => onAlternate(event.target.checked)} />
          in sequence
        </label>
      )}
      {extra}
    </div>
  )
}

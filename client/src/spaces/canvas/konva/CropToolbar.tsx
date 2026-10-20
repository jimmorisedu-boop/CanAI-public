import { useEffect } from 'react'
import { IconCrop, IconDone } from '../../../ui/icons'
import { RATIO_PRESETS } from './cropMath'

// Плавающий тулбар режима кропа (верх-центр): пресеты пропорций + применить.
export function CropToolbar({
  ratio,
  busy,
  onRatio,
  onApply,
  onCancel,
}: {
  ratio: number | null
  busy: boolean
  onRatio: (r: number | null) => void
  onApply: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onApply()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onApply, onCancel])

  return (
    <div className="sketch-palette crop-toolbar">
      <span className="sketch-palette-label">
        <IconCrop size={15} /> Crop
      </span>
      {RATIO_PRESETS.map((p) => (
        <button
          key={p.label}
          className={`crop-ratio ${ratio === p.value ? 'on' : ''}`}
          onClick={() => onRatio(p.value)}
        >
          {p.label}
        </button>
      ))}
      <button className="sketch-cancel" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <button className="sketch-done" disabled={busy} onClick={onApply}>
        {busy ? (
          'Cropping…'
        ) : (
          <>
            <IconDone size={15} weight="bold" /> Apply
          </>
        )}
      </button>
    </div>
  )
}

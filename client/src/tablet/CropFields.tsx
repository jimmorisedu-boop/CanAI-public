import { useEffect, useState } from 'react'
import type { Rect } from '../spaces/canvas/konva/cropMath'
import { cropFieldBounds, editCropField } from './cropFieldModel'

export function CropFields({ rect, bounds, onChange, minimum = 24, ratio = null, disabled = false, unit = '' }: {
  rect: Rect
  bounds: { w: number; h: number }
  onChange(rect: Rect): void
  minimum?: number
  ratio?: number | null
  disabled?: boolean
  unit?: string
}) {
  return <fieldset className="tablet-crop-fields" disabled={disabled}>
    <legend>Crop area{unit ? `, ${unit}` : ''}</legend>
    {([['x', 'X'], ['y', 'Y'], ['w', 'Width'], ['h', 'Height']] as const).map(([field, label]) => {
      const limits = cropFieldBounds(rect, field, bounds, minimum)
      return <CropNumber key={field} label={label} value={rect[field]} min={limits.min} max={limits.max}
        onChange={value => editCropField(rect, field, value, bounds, minimum, ratio)}
        onCommit={next => { onChange(next); return next[field] }} />
    })}
  </fieldset>
}

function CropNumber({ label, value, min, max, onChange, onCommit }: {
  label: string; value: number; min: number; max: number
  onChange(value: number): Rect; onCommit(rect: Rect): number
}) {
  const format = (number: number) => String(Number(number.toFixed(2)))
  const [draft, setDraft] = useState(format(value))
  useEffect(() => setDraft(format(value)), [value])
  const commit = () => {
    if (!draft.trim() || !Number.isFinite(Number(draft))) { setDraft(format(value)); return }
    setDraft(format(onCommit(onChange(Number(draft)))))
  }
  return <label>{label}<input className="ui-field" type="number" inputMode="decimal" step="1"
    min={min} max={max} value={draft}
    onChange={event => {
      setDraft(event.target.value)
      const next = event.target.valueAsNumber
      // Let a person finish typing a number below the minimum (1 → 12 → 120).
      if (Number.isFinite(next) && next >= min && next <= max) onCommit(onChange(next))
    }}
    onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit() } }}
  /></label>
}

import {
  IconClose,
  IconDone,
  IconEraser,
  IconRedo,
  IconSketch,
  IconUndo,
} from '../../../ui/icons'
import { useT } from '../../../i18n/context.js'


export interface Brush {
  tool: 'draw' | 'erase'
  color: string
  size: number
}

const SWATCH_NAMES: Record<string, string> = {
  '#e0554e': 'Vermilion',
  '#1a1a1f': 'Graphite',
  '#2f8f6f': 'Green',
  '#2b6fe0': 'Blue',
  '#f0b429': 'Yellow',
  '#ffffff': 'White',
}

export const SWATCHES = Object.keys(SWATCH_NAMES)

export function SketchPalette({
  brush,
  onBrush,
  busy,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onCancel,
  onDone,
}: {
  brush: Brush
  onBrush: (brush: Brush) => void
  busy: boolean
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onCancel: () => void
  onDone: () => void
}) {
  const t = useT()
  return (
    <div className="sketch-palette" role="toolbar" aria-label={t('Sketch tools')}>
      <div className="sketch-scroll">
        <span className="sketch-palette-label">{t('Sketch')}</span>

        <div className="sketch-tool-group" role="group" aria-label={t('Tool')}>
          <button
            type="button"
            className={`sketch-icon-button ${brush.tool === 'draw' ? 'on' : ''}`}
            aria-label={t('Brush')}
            aria-pressed={brush.tool === 'draw'}
            disabled={busy}
            onClick={() => onBrush({ ...brush, tool: 'draw' })}
          >
            <IconSketch size={17} />
          </button>
          <button
            type="button"
            className={`sketch-icon-button ${brush.tool === 'erase' ? 'on' : ''}`}
            aria-label={t('Eraser')}
            aria-pressed={brush.tool === 'erase'}
            disabled={busy}
            onClick={() => onBrush({ ...brush, tool: 'erase' })}
          >
            <IconEraser size={17} />
          </button>
        </div>

        <div className="sketch-colors" role="group" aria-label={t('Brush color')}>
          {SWATCHES.map((color) => (
            <button
              type="button"
              key={color}
              className={`sketch-swatch ${brush.color === color && brush.tool === 'draw' ? 'on' : ''}`}
              disabled={busy}
              onClick={() => onBrush({ ...brush, tool: 'draw', color })}
              aria-label={SWATCH_NAMES[color]}
              aria-pressed={brush.color === color && brush.tool === 'draw'}
            >
              <span style={{ background: color }} />
            </button>
          ))}
        </div>

        <label className="sketch-size-wrap">
          <span className="sr-only">{t('Brush size')}</span>
          <input
            type="range"
            min={2}
            max={40}
            value={brush.size}
            disabled={busy}
            onChange={(event) => onBrush({ ...brush, size: Number(event.target.value) })}
            className="sketch-size"
            aria-label={t('Brush size')}
          />
          <output>{brush.size}</output>
        </label>

        <div className="sketch-tool-group" role="group" aria-label={t('Sketch history')}>
          <button
            type="button"
            className="sketch-icon-button"
            aria-label={t('Undo stroke')}
            disabled={busy || !canUndo}
            onClick={onUndo}
          >
            <IconUndo size={17} />
          </button>
          <button
            type="button"
            className="sketch-icon-button"
            aria-label={t('Redo stroke')}
            disabled={busy || !canRedo}
            onClick={onRedo}
          >
            <IconRedo size={17} />
          </button>
        </div>
      </div>

      <div className="sketch-actions">
        <button
          type="button"
          className="sketch-cancel"
          aria-label={t('Cancel')}
          disabled={busy}
          onClick={onCancel}
        >
          <IconClose size={16} /> <span>{t('Cancel')}</span>
        </button>
        <button
          type="button"
          className="sketch-done"
          aria-label={t('Apply')}
          disabled={busy || !canUndo}
          onClick={onDone}
        >
          {busy ? t('Saving…') : (
            <><IconDone size={16} /> <span>{t('Apply')}</span></>
          )}
        </button>
      </div>
    </div>
  )
}

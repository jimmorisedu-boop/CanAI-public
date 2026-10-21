import type { TimelineSession } from '../spaces/canvas/timeline/useTimelineSession'
import { RATIO_PRESETS } from '../spaces/canvas/konva/cropMath'
import { CropFields } from './CropFields'
import { useT } from '../i18n/context.js'


export function TabletClipCropPanel({ session, open, onOpenChange }: {
  session: TimelineSession
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const t = useT()
  if (!session.crop) return null
  return (
    <details className="tablet-clip-crop-panel" open={open} onToggle={event => onOpenChange(event.currentTarget.open)}>
      <summary>{t('Crop settings')}</summary>
      <div className="tablet-clip-crop-content">
        <div className="tablet-clip-ratios" role="group" aria-label={t('Crop aspect ratio')}>
          {RATIO_PRESETS.map(preset => (
            <button
              key={preset.label}
              type="button"
              className={session.cropRatio === preset.value ? 'on' : undefined}
              aria-pressed={session.cropRatio === preset.value}
              aria-label={preset.label}
              title={preset.label}
              disabled={!session.facts?.width || !session.facts.height || session.busy}
              onClick={() => session.setCropRatio(preset.value)}
            >
              {preset.label === 'Freeform' ? 'Free' : preset.label}
            </button>
          ))}
        </div>
        <CropFields
          rect={{ x: session.crop.x * 100, y: session.crop.y * 100, w: session.crop.w * 100, h: session.crop.h * 100 }}
          bounds={{ w: 100, h: 100 }} minimum={1} unit="%" disabled={session.busy}
          ratio={session.cropRatio && session.facts?.width && session.facts.height
            ? session.cropRatio / (session.facts.width / session.facts.height)
            : null}
          onChange={rect => session.setCrop({ x: rect.x / 100, y: rect.y / 100, w: rect.w / 100, h: rect.h / 100 })}
        />
      </div>
    </details>
  )
}

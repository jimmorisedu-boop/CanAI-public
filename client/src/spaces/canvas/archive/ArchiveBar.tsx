import { useEffect, useRef, useState } from 'react'
import { IconArchive } from '../../../ui/icons'
import { OBJECTS, pluralWithCount } from '../../../ui/plural'
import type { CanvasStore } from '../konva/canvasStore'
import { useContentVersion } from '../konva/useStore'
import { ArchivePanel } from './ArchivePanel'
import { isArchiveHover, onArchiveHover, onOpenArchive } from './archiveBus'
import { createArchiveTarget, registerSaveForLaterOnboardingTarget, showOnboardingTarget } from '../onboardingTargets'
import { useT } from '../../../i18n/context.js'


// Плитка «Архив» — правый нижний угол холста. Принцип тот же: перетащил
// объект(ы) с холста на плитку — материал уехал сюда (с холста исчез, но
// не потерян). Клик по плитке открывает список.
export function ArchiveBar({ store }: { store: CanvasStore }) {
  const t = useT()
  useContentVersion(store)
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(isArchiveHover())
  const archiveRef = useRef<HTMLButtonElement>(null)

  useEffect(() => onArchiveHover(setOver), [])
  useEffect(() => onOpenArchive(() => setOpen(true)), [])
  useEffect(() => registerSaveForLaterOnboardingTarget(createArchiveTarget({
    focus: () => archiveRef.current?.focus({ preventScroll: true }),
    pulse: () => showOnboardingTarget(archiveRef.current, {
      message: t('Archive removes objects from the canvas, while Assets keep them handy.'),
    }),
  })), [t])

  const count = store.getArchive().length

  return (
    <div className="archive-bar" data-canvas-safe-edge="right">
      <div className="asset-bar-title">{t('Archive')}</div>
      <button
        ref={archiveRef}
        type="button"
        className={`archive-tile ${count ? 'filled' : 'empty'} ${over ? 'over' : ''}`}
        data-archive-dropzone=""
        title={
          count
            ? t('In Archive {0} — click to open the list. Drag a selection here to remove it from the canvas.', { 0: pluralWithCount(count, OBJECTS) })
            : t('Drag selected objects here to move them off the canvas into Archive. Click to open the list.')
        }
        aria-label={count ? t('Archive: {0}', { 0: pluralWithCount(count, OBJECTS) }) : t('Archive')}
        onClick={() => setOpen(true)}
        onContextMenu={(e) => {
          e.preventDefault()
          setOpen(true)
        }}
      >
        <IconArchive size={22} />
        {count > 0 && <span className="archive-tile-count">{count}</span>}
      </button>
      {open && <ArchivePanel store={store} onClose={() => setOpen(false)} />}
    </div>
  )
}

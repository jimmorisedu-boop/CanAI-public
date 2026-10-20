import { useEffect, useRef, useState } from 'react'
import { IconArchive } from '../../../ui/icons'
import { OBJECTS, pluralWithCount } from '../../../ui/plural'
import type { CanvasStore } from '../konva/canvasStore'
import { useContentVersion } from '../konva/useStore'
import { ArchivePanel } from './ArchivePanel'
import { isArchiveHover, onArchiveHover, onOpenArchive } from './archiveBus'
import { createArchiveTarget, registerSaveForLaterOnboardingTarget, showOnboardingTarget } from '../onboardingTargets'

// Плитка «Архив» — правый нижний угол холста. Принцип тот же: перетащил
// объект(ы) с холста на плитку — материал уехал сюда (с холста исчез, но
// не потерян). Клик по плитке открывает список.
export function ArchiveBar({ store }: { store: CanvasStore }) {
  useContentVersion(store)
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(isArchiveHover())
  const archiveRef = useRef<HTMLButtonElement>(null)

  useEffect(() => onArchiveHover(setOver), [])
  useEffect(() => onOpenArchive(() => setOpen(true)), [])
  useEffect(() => registerSaveForLaterOnboardingTarget(createArchiveTarget({
    focus: () => archiveRef.current?.focus({ preventScroll: true }),
    pulse: () => showOnboardingTarget(archiveRef.current, {
      message: 'Archive removes objects from the canvas, while Assets keep them handy.',
    }),
  })), [])

  const count = store.getArchive().length

  return (
    <div className="archive-bar" data-canvas-safe-edge="right">
      <div className="asset-bar-title">Archive</div>
      <button
        ref={archiveRef}
        type="button"
        className={`archive-tile ${count ? 'filled' : 'empty'} ${over ? 'over' : ''}`}
        data-archive-dropzone=""
        title={
          count
            ? `In Archive ${pluralWithCount(count, OBJECTS)} — click to open the list. Drag a selection here to remove it from the canvas.`
            : 'Drag selected objects here to move them off the canvas into Archive. Click to open the list.'
        }
        aria-label={count ? `Archive: ${pluralWithCount(count, OBJECTS)}` : 'Archive'}
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

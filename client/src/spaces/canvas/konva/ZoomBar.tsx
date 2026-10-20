import { IconFit, IconMinus, IconPlus } from '../../../ui/icons'
import type { CanvasStore } from './canvasStore'
import { zoomStep, zoomTo100, zoomToFit } from './cameraOps'
import { useCameraVersion } from './useStore'

// Зум-бар холста (низ-лево, как в Figma/Miro): −  %  +  вписать  100%
export function ZoomBar({ store, viewport }: { store: CanvasStore; viewport: { w: number; h: number } }) {
  useCameraVersion(store)
  const pct = Math.round(store.getCamera().scale * 100)

  return (
    <div className="zoom-bar">
      <button className="icon-btn" title="Zoom out" onClick={() => zoomStep(store, viewport, -1)}>
        <IconMinus size={15} />
      </button>
      <span className="zoom-bar-pct" title="Current zoom">
        {pct}%
      </span>
      <button className="icon-btn" title="Zoom in" onClick={() => zoomStep(store, viewport, 1)}>
        <IconPlus size={15} />
      </button>
      <span className="zoom-bar-sep" />
      <button className="icon-btn" title="Show all (Shift+1)" onClick={() => zoomToFit(store, viewport)}>
        <IconFit size={15} />
      </button>
      <button title="100% zoom" onClick={() => zoomTo100(store, viewport)}>
        1:1
      </button>
    </div>
  )
}

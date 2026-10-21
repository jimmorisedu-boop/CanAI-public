import { IconFitAll } from '../ui/icons'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { useCameraVersion } from '../spaces/canvas/konva/useStore'
import { clampScale, fitCamera, zoomAt } from './boardGestures'
import { useT } from '../i18n/context.js'


// Масштаб доски.
//
// Щипок есть, но одного щипка мало: «вписать всё» и «натуральный размер» —
// это точные значения, к которым пальцами не подобраться, а искать доску
// вслепую после случайного отдаления неприятно.

export function TabletZoom({ store, host }: { store: CanvasStore; host: () => HTMLElement | null }) {
  const t = useT()
  useCameraVersion(store)
  const camera = store.getCamera()

  const viewport = () => {
    const node = host()
    return { w: node?.clientWidth ?? window.innerWidth, h: node?.clientHeight ?? window.innerHeight }
  }

  const zoomBy = (factor: number) => {
    const size = viewport()
    const center = { x: size.w / 2, y: size.h / 2 }
    store.setCamera(zoomAt(store.getCamera(), center, clampScale(store.getCamera().scale * factor)))
  }

  return (
    <div className="tablet-zoom" role="group" aria-label={t('Zoom')}>
      <button
        type="button"
        className="ui-icon-btn"
        aria-label={t('Show all')}
        onClick={() => store.setCamera(fitCamera(store.getItems(), viewport()))}
      >
        <IconFitAll size={18} />
      </button>
      <button type="button" className="ui-icon-btn" aria-label={t('Zoom out')} onClick={() => zoomBy(1 / 1.25)}>−</button>
      <span className="tablet-zoom-value">{Math.round(camera.scale * 100)} %</span>
      <button type="button" className="ui-icon-btn" aria-label={t('Zoom in')} onClick={() => zoomBy(1.25)}>+</button>
      <button
        type="button"
        className="ui-btn quiet tablet-zoom-reset"
        onClick={() => {
          const size = viewport()
          store.setCamera(zoomAt(store.getCamera(), { x: size.w / 2, y: size.h / 2 }, 1))
        }}
      >
        1:1
      </button>
    </div>
  )
}

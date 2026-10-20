import type { CSSProperties } from 'react'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { useGuidesVersion } from '../spaces/canvas/konva/useStore'

const GUIDE_PX = 1.5

function guideStyle(guide: number[], scale: number): { className: string; style: CSSProperties } | null {
  const [x1, y1, x2, y2] = guide
  if ([x1, y1, x2, y2].some((value) => !Number.isFinite(value))) return null
  const thickness = GUIDE_PX / Math.max(0.05, scale)
  if (x1 === x2) {
    return {
      className: 'tablet-snap-guide vertical',
      style: {
        left: x1,
        top: Math.min(y1, y2),
        width: thickness,
        height: Math.abs(y2 - y1),
        transform: 'translateX(-50%)',
      },
    }
  }
  return {
    className: 'tablet-snap-guide horizontal',
    style: {
      left: Math.min(x1, x2),
      top: y1,
      width: Math.abs(x2 - x1),
      height: thickness,
      transform: 'translateY(-50%)',
    },
  }
}

/** Тонкий визуальный слой: направляющие живут в мировых координатах. */
export function TabletSnapGuides({ guides, scale }: { guides: number[][]; scale: number }) {
  return (
    <div className="tablet-snap-guides" aria-hidden="true">
      {guides.map((guide, index) => {
        const presentation = guideStyle(guide, scale)
        if (!presentation) return null
        return <i key={`${guide.join(':')}:${index}`} {...presentation} />
      })}
    </div>
  )
}

/** Подписка изолирована здесь: появление гайда не перерисовывает карточки. */
export function TabletStoreSnapGuides({ store, scale }: { store: CanvasStore; scale: number }) {
  useGuidesVersion(store)
  return <TabletSnapGuides guides={store.getGuides()} scale={scale} />
}

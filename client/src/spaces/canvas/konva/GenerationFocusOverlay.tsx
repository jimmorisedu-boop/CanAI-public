import { Layer, Rect } from 'react-konva'
import type { CanvasStore } from './canvasStore'
import { itemAabb } from './geometry'
import { useGenerationFocusVersion, useOnboardingFocusVersion } from './useStore'

export function GenerationFocusOverlay({
  store,
  scale,
}: {
  store: CanvasStore
  scale: number
}) {
  useGenerationFocusVersion(store)
  useOnboardingFocusVersion(store)
  const items = [...store.getGenerationFocus(), ...store.getOnboardingFocus()].flatMap((id) => {
    const item = store.getItem(id)
    return item ? [itemAabb(item)] : []
  })

  if (items.length === 0) return null
  return (
    <Layer listening={false}>
      {items.map((bounds, index) => (
        <Rect
          key={index}
          x={bounds.x - 6 / scale}
          y={bounds.y - 6 / scale}
          width={bounds.w + 12 / scale}
          height={bounds.h + 12 / scale}
          fill="rgba(211, 63, 33, 0.08)"
          stroke="#d33f21"
          strokeWidth={2 / scale}
          cornerRadius={8 / scale}
          listening={false}
        />
      ))}
    </Layer>
  )
}

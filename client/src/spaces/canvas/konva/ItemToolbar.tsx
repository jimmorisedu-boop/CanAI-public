import { IconArchive, IconCrop, IconDownload, IconOpenExternal, IconSketch, IconTimeline } from '../../../ui/icons'
import type { CanvasItem } from './types'
import type { CanvasStore } from './canvasStore'
import { archiveSelection } from './archiveSelection'
import { setTimelineTarget } from '../timeline/timelineBus'
import { canvasItemFileName } from './mediaFileName'
import { useCanvasAnchor } from './useCanvasAnchor'
import { itemAabb } from './geometry'

// HTML-меню над выделенным объектом (Konva-оверлей). Набор кнопок зависит от
// типа: у картинки — редактор, скетч, кроп; у видео — правка клипа. Общие для
// медиа — архив и скачивание, включая аудио.
export function isItemToolbarEligible(item: CanvasItem): boolean {
  return item.kind === 'image' || item.kind === 'video' || item.kind === 'audio'
}

export function itemDownloadLabel(item: CanvasItem): string {
  return item.kind === 'audio' ? 'Download audio' : 'Download'
}

export function ItemToolbar({
  item,
  store,
  onEdit,
  onSketch,
  onCrop,
}: {
  item: CanvasItem
  store: CanvasStore
  onEdit: (id: string) => void
  onSketch: (id: string) => void
  onCrop: (id: string) => void
}) {
  function download(): void {
    if (!item.src) return
    const a = document.createElement('a')
    a.href = item.src
    a.download = canvasItemFileName(item)
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  // Позицию панель считает сама — и при переносе объекта, и при навигации по
  // холсту: через стор камера доезжает с задержкой, и панель отставала.
  const ref = useCanvasAnchor<HTMLDivElement>(
    store,
    [item.id],
    { x: item.x + item.w / 2, y: item.y, screenOffsetY: -44, bounds: [itemAabb(item)] },
  )

  return (
    <div ref={ref} className="konva-item-toolbar konva-anchored">
      {/* Внешний редактор — только для картинок: сервер открывает в нём
          исключительно изображения, и на видео кнопка выдавала бы отказ. */}
      {item.kind === 'image' && (
        <>
          <button
            className="konva-tool-btn"
            title="Open in editor (Photoshop)"
            onClick={() => onEdit(item.id)}
          >
            <IconOpenExternal />
          </button>
          <button
            className="konva-tool-btn"
            title="Sketch: draw over it and generate from the sketch"
            onClick={() => onSketch(item.id)}
          >
            <IconSketch />
          </button>
          <button className="konva-tool-btn" title="Crop (aspect ratio or freeform)" onClick={() => onCrop(item.id)}>
            <IconCrop />
          </button>
        </>
      )}
      {item.kind === 'video' && (
        <button
          className="konva-tool-btn"
          title="Edit clip: crop, cuts, frame, audio (T)"
          onClick={() => setTimelineTarget(item.id)}
        >
          <IconTimeline />
        </button>
      )}
      <button
        className="konva-tool-btn"
        title="To Archive"
        onClick={() => archiveSelection(store, [item.id])}
      >
        <IconArchive />
      </button>
      <button className="konva-tool-btn" title={itemDownloadLabel(item)} onClick={download}>
        <IconDownload />
      </button>
    </div>
  )
}

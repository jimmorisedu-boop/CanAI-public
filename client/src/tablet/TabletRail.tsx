import { IconArchive, IconClose, IconSound, IconText, IconVideo } from '../ui/icons'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { PinnedAsset } from '../spaces/canvas/konva/types'
import { useContentVersion } from '../spaces/canvas/konva/useStore'
import { previewSrc } from './remoteSession'

// Полка слева: ассеты и архив.
//
// На компьютере они живут справа, но правый край планшета занимает инспектор —
// и делить его нельзя: инспектор появляется по выделению, а полка нужна всегда.
//
// Объект попадает сюда перетаскиванием (см. BoardCanvas: палец, отпущенный над
// слотом, закрепляет объект и возвращает его на место) или долгим нажатием по
// объекту → «Закрепить». Нажатие на занятый слот берёт его референсом.

export function TabletRail({
  store,
  onPickAsset,
  onOpenArchive,
}: {
  store: CanvasStore
  onPickAsset(asset: PinnedAsset): void
  onOpenArchive(): void
}) {
  useContentVersion(store)
  const assets = store.getAssets()
  const bySlot = new Map(assets.map((asset) => [asset.slot, asset]))
  const maxSlot = assets.reduce((max, asset) => Math.max(max, asset.slot), -1)
  // Показываем занятые слоты и ровно один свободный: пустая колонка из восьми
  // рамок занимает экран, ничего о себе не сообщая.
  const slots = Array.from({ length: Math.min(maxSlot + 2, 8) }, (_, index) => index)
  const archived = store.getArchive().length

  return (
    <aside className="tablet-rail" aria-label="Assets">
      <div className="tablet-rail-list tablet-rail-slots">
        {slots.map((slot) => {
          const asset = bySlot.get(slot)
          return (
            <div className="tablet-slot-wrap" key={slot}>
              <button
                type="button"
                className={`tablet-slot ${asset ? 'filled' : 'empty'}`}
                data-asset-slot={slot}
                aria-label={asset ? `Asset ${slot + 1}: ${asset.name ?? asset.kind}` : `Free slot ${slot + 1}`}
                onClick={() => { if (asset) onPickAsset(asset) }}
              >
                {asset ? <AssetFace asset={asset} /> : <span className="tablet-slot-plus" aria-hidden="true">+</span>}
              </button>
              {asset && (
                <button
                  type="button"
                  className="tablet-slot-unpin"
                  aria-label="Unpin"
                  onClick={() => store.unpinAsset(slot)}
                >
                  <IconClose size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="tablet-rail-actions">
        <button
          type="button"
          className="tablet-rail-btn"
          data-archive-dropzone
          onClick={onOpenArchive}
          aria-label={archived > 0 ? `Board archive: ${archived}` : 'Board archive'}
        >
          <IconArchive size={22} />
          <span>Archive</span>
          {archived > 0 && <em>{archived}</em>}
        </button>
      </div>
    </aside>
  )
}

function AssetFace({ asset }: { asset: PinnedAsset }) {
  if (asset.kind === 'image' && asset.src) {
    return <img src={previewSrc(asset.src)} alt="" decoding="async" draggable={false} />
  }
  if (asset.kind === 'video') return <span className="tablet-slot-icon"><IconVideo size={20} /></span>
  if (asset.kind === 'audio') return <span className="tablet-slot-icon"><IconSound size={20} /></span>
  return (
    <span className="tablet-slot-text">
      <IconText size={14} />
      {asset.text?.slice(0, 24) ?? 'text'}
    </span>
  )
}

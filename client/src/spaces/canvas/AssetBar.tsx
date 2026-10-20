import { useEffect, useRef, useState } from 'react'
import { notify } from './toastBus'
import { IconText, IconVideo } from '../../ui/icons'
import type { CanvasStore } from './konva/canvasStore'
import { measure } from './konva/importMedia'
import { assetToRef } from './konva/assetRef'
import type { PinnedAsset } from './konva/types'
import { useContentVersion } from './konva/useStore'
import { requestAddPromptAsset } from './promptAssetBus'
import { screenPreviewSrc } from './konva/screenPreview'
import { boardMediaUploader } from './konva/boardUploader'
import { createAssetShelfTarget, registerSaveForLaterOnboardingTarget, showOnboardingTarget } from './onboardingTargets'

// Полка быстрого доступа справа:
// перетащи файл ИЛИ объект с холста на слот → миниатюра; клик → ассет
// уходит референсом в промпт; ПКМ (правый клик) — открепить. Живёт в доске.
export function AssetBar({ store }: { store: CanvasStore }) {
  useContentVersion(store)
  const [busySlot, setBusySlot] = useState<number | null>(null)
  const shelfRef = useRef<HTMLDivElement>(null)

  useEffect(() => registerSaveForLaterOnboardingTarget(createAssetShelfTarget({
    pulse: () => showOnboardingTarget(shelfRef.current, { message: '' }),
  })), [])

  const bySlot = new Map<number, PinnedAsset>()
  const assets = store.getAssets()
  for (const a of assets) bySlot.set(a.slot, a)

  const maxSlot = assets.reduce((max, a) => Math.max(max, a.slot), -1)
  const slotCount = maxSlot + 2

  async function onDropFile(slot: number, e: React.DragEvent): Promise<void> {
    e.preventDefault()
    e.stopPropagation()
    const file = Array.from(e.dataTransfer.files).find(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
    )
    if (!file) return
    setBusySlot(slot)
    try {
      const isImage = file.type.startsWith('image/')
      // ⚠️ Сначала читаем, потом грузим. Нечитаемый файл (текст с расширением
      // .png, обрезанный ролик) рисовать нечем — в слоте была бы пустая
      // плитка, — а раз отказ всё равно неизбежен, незачем сперва отправлять
      // файл на сервер и оставлять там мусор до ближайшей уборки.
      const { w, h, readable } = await measure(file, isImage)
      if (!readable) {
        notify({ kind: 'error', message: `"${file.name || "file"}" does not open: it is damaged or it is not what it looks like from the extension` })
        return
      }
      // ⚠️ Полка живёт В ДОКУМЕНТЕ доски, поэтому на сетевой файл обязан
      // уехать на сервер команды — см. boardUploader.
      const uploaded = await boardMediaUploader()(file)
      store.pinAsset({
        slot,
        kind: file.type.startsWith('video/') ? 'video' : 'image',
        src: uploaded.url,
        assetId: uploaded.assetId,
        assetRevision: uploaded.assetRevision,
        assetChecksum: uploaded.assetChecksum,
        mime: uploaded.mime,
        name: file.name || "file",
        width: w,
        height: h,
      })
    } catch {
      notify({ kind: 'error', message: "Failed to add file to Assets. Try again." })
    } finally {
      setBusySlot(null)
    }
  }

  function onSlotClick(slot: number): void {
    const asset = bySlot.get(slot)
    if (asset) requestAddPromptAsset(assetToRef(asset))
  }

  function onSlotContextMenu(slot: number, e: React.MouseEvent): void {
    e.preventDefault()
    const asset = bySlot.get(slot)
    if (asset) {
      store.unpinAsset(slot)
    }
  }

  return (
    <div ref={shelfRef} className="asset-bar" data-canvas-safe-edge="right">
      <div className="asset-bar-title" title="Drag an image/video here (from canvas or file) and a thumbnail will appear. Click - add to prompt. RMB - unpin.">
        Assets
      </div>
      <div className="asset-slots-grid">
        {Array.from({ length: slotCount }, (_, slot) => {
          const asset = bySlot.get(slot)
          return (
            <div
              key={slot}
              className={`asset-slot ${asset ? 'filled' : 'empty'} ${busySlot === slot ? 'busy' : ''}`}
              data-asset-slot={slot}
              title={
                asset
                  ? `${asset.name || asset.kind} - click will add to prompt, RMB - unpin`
                  : "Drag an image/video from the canvas or file - it will be pinned here"
              }
              onClick={() => onSlotClick(slot)}
              onContextMenu={(e) => onSlotContextMenu(slot, e)}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }}
              onDrop={(e) => void onDropFile(slot, e)}
            >
              {asset ? (
                <>
                  {asset.kind === 'image' && asset.src ? (
                    // Слот — миниатюра: оригинал сетевой доски ехал бы по сети
                    // целиком ради квадрата в полсотни точек.
                    <img src={screenPreviewSrc(asset.src, 96)} alt="" className="asset-thumb" />
                  ) : asset.kind === 'video' && asset.src ? (
                    <video src={asset.src} className="asset-thumb" muted preload="metadata" />
                  ) : (
                    <span className="asset-thumb asset-thumb-text">
                      <IconText size={16} />
                    </span>
                  )}
                  {asset.kind === 'video' && <IconVideo size={13} className="asset-badge" />}
                </>
              ) : (
                <span className="asset-slot-num">{slot + 1}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

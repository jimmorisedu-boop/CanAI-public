import { memo, useEffect, useRef, useState } from 'react'
import { Group, Image as KonvaImage, Rect, Text as KonvaText } from 'react-konva'
import type Konva from 'konva'
import type { CanvasStore } from './canvasStore'
import { requestPromptFill } from '../promptFillBus'
import { MarkBadge } from './MarkBadge'
import { ItemInfoBadge } from './ItemInfoBadge'
import { infoLineParts } from './itemInfoLine'
import { modelDisplayName } from '../genOptions'
import { isImageLoadedFrom, useImageEl } from './media'
import { mediaCornerRadius } from './canvasLayout'
import { screenPreviewSrc, stickyPreviewStep } from './screenPreview'
import {
  onCanvasItemDragMove,
  onCanvasItemDragStart,
  onDragEnd,
  onTransformEnd,
  onTransformPreview,
  selectOnClick,
  useArrival,
  useCameraScale,
  useMediaSize,
  useThemeColors,
  type ItemProps,
  type KEvent,
} from './itemHelpers'

export function LeftAccentStrip({ itemH, radius, store }: { itemH: number; radius: number; store: CanvasStore }) {
  // Масштаб берём здесь, а не пропсом сверху: тогда зум перерисовывает только
  // эту полоску, а не всю фигуру со всеми обработчиками (см. useCameraScale).
  const scale = useCameraScale(store)
  // Вертикальная полоса-маркер слева для сгенерированного контента: на экране
  // всегда 4 px. ⚠️ В единицах доски она при приближении росла вместе с
  // кадром (при ×8 — 32 px), та же беда, что у рамки (жалоба 30.09.2026).
  // Скругление — у кадра: `radius` приходит от фигуры (canvasLayout).
  const worldWidth = 4 / scale
  return (
    <Rect
      x={0}
      y={0}
      width={worldWidth}
      height={itemH}
      fill="#ff552e"
      cornerRadius={[radius, 0, 0, radius]}
      perfectDrawEnabled={false}
      listening={false}
    />
  )
}

export const ImageItem = memo(function ImageItem({
  item,
  store,
  draggable,
  selected,
  persistNaturalSize = true,
  viewScale = 1,
}: ItemProps & { persistNaturalSize?: boolean; viewScale?: number }) {
  // Показываем экранное превью, а item.src (оригинал) остаётся для скачивания,
  // обрезки, скетча и генерации. Масштаб приходит пропом — огрублённым и
  // общим для всех фигур: подписка на камеру внутри фигуры однажды уже стоила
  // 246 мс на сдвиг (см. cameraScale).
  // ⚠️ Ступень идёт вниз только когда копия крупнее нужной больше чем вдвое:
  // крупные копии на отдалённой доске роняли Firefox до 7 кадров в секунду
  // (см. stickyPreviewStep), а мелкие колебания масштаба адрес не трогают.
  const previewWidth = useRef<number>()
  previewWidth.current = stickyPreviewStep(previewWidth.current, item.w * viewScale * devicePixelRatio)
  // GIF сюда не приходит: его рисует GifItem с плеером (см. KonvaCanvas).
  const shownSrc = screenPreviewSrc(item.src, previewWidth.current)
  // ⚠️ Размеры превью — НЕ размеры картинки. Пока показана уменьшенная копия,
  // натуральное разрешение берём из объекта: иначе оно уехало бы в доску и в
  // подсказку как «512×384», а на нём держатся обрезка и экспорт.
  const showingPreview = shownSrc !== item.src
  const img = useImageEl(shownSrc, item.src, { x: item.x + item.w / 2, y: item.y + item.h / 2 })
  const ref = useRef<Konva.Image>(null)
  const groupRef = useRef<Konva.Group>(null)
  const tc = useThemeColors()
  const [hovered, setHovered] = useState(false)
  const fileSize = useMediaSize(item.src, hovered)
  // Одно скругление на кадр, подложку, рамку и полосу — постоянное на экране.
  const radius = mediaCornerRadius(viewScale, item.w, item.h)

  useArrival(store, item.id, () => groupRef.current, Boolean(img))

  useEffect(() => {
    if (img) {
      ref.current?.getLayer()?.batchDraw()
      // Только размер самого ОРИГИНАЛА: пока он грузится, на экране ещё
      // прежняя уменьшенная копия (см. isImageLoadedFrom).
      if (persistNaturalSize && !showingPreview && isImageLoadedFrom(img, item.src)
        && (item.naturalWidth !== img.naturalWidth || item.naturalHeight !== img.naturalHeight)) {
        store.updateItem(item.id, {
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        }, false)
      }
    }
  }, [img, item.id, item.src, item.naturalWidth, item.naturalHeight, persistNaturalSize, showingPreview, store])
  return (
    <Group
      id={item.id}
      // Размер и скругление — для кольца выделения (SelectionRings).
      selectionFrame={{ w: item.w, h: item.h, radius }}
      ref={groupRef}
      x={item.x}
      y={item.y}
      rotation={item.rotation}
      draggable={draggable}
      onDragStart={(e) => onCanvasItemDragStart(store, item.id, e)}
      onDragMove={(e) => onCanvasItemDragMove(store, item.id, e)}
      onDragEnd={(e) => onDragEnd(store, item.id, e)}
      onTransform={() => groupRef.current && onTransformPreview(store, item.id, groupRef.current)}
      onTransformEnd={() => groupRef.current && onTransformEnd(store, item.id, groupRef.current)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {!img && (
        <Rect
          width={item.w}
          height={item.h}
          fill="#e7e4de"
          cornerRadius={radius}
          perfectDrawEnabled={false}
          listening={false}
        />
      )}
      <KonvaImage
        ref={ref}
        image={img}
        width={item.w}
        height={item.h}
        cornerRadius={radius}
        perfectDrawEnabled={false}
        onClick={(e) => selectOnClick(store, item.id, e)}
        onTap={(e) => selectOnClick(store, item.id, e as unknown as KEvent)}
        onDblClick={() => {
          requestPromptFill({ shapeId: item.id, prompt: item.prompt, modelId: item.modelId, referenceIds: item.referenceIds })
          const validRefs = (item.referenceIds || []).filter((id) => Boolean(store.getItem(id)))
          store.setSelection(validRefs)
        }}
      />
      {/* Тонкая рамка вокруг картинки — линия на экране, а не полоса доски:
          в единицах доски она при ×8 становилась полосой в 8 px. */}
      <Rect
        width={item.w}
        height={item.h}
        stroke={tc.itemBorder}
        strokeWidth={1}
        strokeScaleEnabled={false}
        cornerRadius={radius}
        perfectDrawEnabled={false}
        listening={false}
      />
      {/* Вариант 5: Вертикальная полоса-маркер слева для сгенерированного контента */}
      {item.prompt && <LeftAccentStrip itemH={item.h} radius={radius} store={store} />}
      {item.mark != null && <MarkBadge mark={item.mark} store={store} itemW={item.w} />}
      {img && hovered && (
        <ItemInfoBadge
          store={store}
          itemW={item.w}
          itemH={item.h}
          parts={infoLineParts({
            name: item.name,
            modelName: modelDisplayName(item.modelId),
            // Показываем разрешение ОРИГИНАЛА: на экране может быть превью.
            naturalWidth: item.naturalWidth ?? img.naturalWidth,
            naturalHeight: item.naturalHeight ?? img.naturalHeight,
            fileSize,
          })}
        />
      )}
    </Group>
  )
})

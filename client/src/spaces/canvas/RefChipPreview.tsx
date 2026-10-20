import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SelectionRef } from './konva/selection'
import {
  PREVIEW_WIDTH,
  refChipPreviewPosition,
  type RefChipPreviewPlacement,
} from './refChipPreviewPos'
import { screenPreviewSrc } from './konva/screenPreview'

const DELAY_MS = 500 // как и раньше: превью появляется не сразу

/**
 * Hover карточка всё ещё показывает оригинальное соотношение и размер, но
 * не должна скачивать многомегабайтный raster только ради 200px портала.
 * Видео оставляем на исходном URL: серверное экранное preview — image-only.
 */
export function refChipHoverSrc(refItem: SelectionRef): string | undefined {
  return refItem.kind === 'image'
    ? screenPreviewSrc(refItem.src, PREVIEW_WIDTH)
    : refItem.src
}

export type RefChipHoverProps = {
  onPointerEnter(): void
  onPointerLeave(): void
  onFocus(): void
  onBlur(): void
}

// Превью медиа-референса по наведению. Живёт в портале на <body>, потому что
// чипы стоят и в промпт-баре, и в ленте помощника с overflow: auto — внутри
// ленты абсолютное превью срезалось её краем.
export function useRefChipPreview(
  refItem: SelectionRef,
  // Сорвавшуюся миниатюру незачем показывать ещё и крупно: превью повторило бы
  // ту же неудачу, только во весь экран (см. refChipFallback.ts).
  options: { disabled?: boolean } = {},
): {
  anchorRef: (node: HTMLDivElement | null) => void
  hoverProps: RefChipHoverProps
  preview: ReactNode
} {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const [place, setPlace] = useState<RefChipPreviewPlacement | null>(null)
  const enabled = refItem.kind !== 'text' && Boolean(refItem.src) && !options.disabled
  const open = place !== null

  const measure = useCallback(() => {
    const node = nodeRef.current
    if (!node) return
    setPlace(
      refChipPreviewPosition(node.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    )
  }, [])

  const cancelTimer = useCallback(() => {
    if (timerRef.current == null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const show = useCallback(() => {
    if (!enabled) return
    cancelTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      measure()
    }, DELAY_MS)
  }, [cancelTimer, enabled, measure])

  const hide = useCallback(() => {
    cancelTimer()
    setPlace(null)
  }, [cancelTimer])

  useEffect(() => cancelTimer, [cancelTimer])

  // лента прокручивается под курсором — карточка должна ехать за чипом,
  // иначе висела бы на старом месте
  useEffect(() => {
    if (!open) return
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, measure])

  const preview =
    place && enabled
      ? createPortal(
          <div
            className={`ref-chip-preview place-${place.placement}`}
            aria-hidden="true"
            style={{
              left: place.left,
              width: PREVIEW_WIDTH,
              ...(place.placement === 'top'
                ? { bottom: place.offset }
                : { top: place.offset }),
            }}
          >
            {refItem.kind === 'image' ? (
              <img src={refChipHoverSrc(refItem)} alt="" style={{ maxHeight: place.maxMediaHeight }} />
            ) : (
              <video
                src={refItem.src}
                playsInline
                muted
                autoPlay
                loop
                style={{ maxHeight: place.maxMediaHeight }}
              />
            )}
          </div>,
          document.body,
        )
      : null

  return {
    anchorRef: (node) => {
      nodeRef.current = node
    },
    hoverProps: { onPointerEnter: show, onPointerLeave: hide, onFocus: show, onBlur: hide },
    preview,
  }
}

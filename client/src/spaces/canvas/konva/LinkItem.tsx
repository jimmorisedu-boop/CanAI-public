import { memo, useEffect, useRef, useState } from 'react'
import Konva from 'konva'
import { Group, Image as KonvaImage, Rect, Text as KonvaText } from 'react-konva'
import { api } from '../../../api'
import type { CanvasLinkData, CanvasItem } from './types'
import type { CanvasStore } from './canvasStore'
import { useImageEl } from './media'
import { CANVAS_MONO_FONT, CANVAS_SANS_FONT } from './fonts'
import {
  onCanvasItemDragMove,
  onCanvasItemDragStart,
  onDragEnd,
  onTransformEnd,
  onTransformPreview,
  selectOnClick,
  useThemeColors,
  type KEvent,
} from './itemHelpers'
import { mediaLinkController } from './mediaLinkController'
import { showErrorToast } from '../toastBus'
import { linkCardPresentation } from './linkItemPresentation'
import { linkItemLayout, linkItemScale } from './linkItemLayout'
import { CardActionButton } from './CardActionButton'
export { linkCardPresentation } from './linkItemPresentation'

const LINK_CARD_RADIUS = 12

/**
 * Превью обрезается по скруглению самой карточки.
 *
 * ⚠️ Прямоугольная обрезка оставляла у превью квадратные углы, а рамка
 * карточки скруглена: картинка торчала из-за дуги сверху слева и справа
 * (жалоба 21.09.2026 со снимком, та же беда, что у картинок на холсте).
 * Низ превью скругляем только когда оно и есть низ карточки.
 */
function clipPreviewCorners(width: number, height: number, cardHeight: number) {
  const bottom = height >= cardHeight - 0.5 ? LINK_CARD_RADIUS : 0
  return (context: Konva.Context) => {
    Konva.Util.drawRoundedRectPath(context, width, height, [LINK_CARD_RADIUS, LINK_CARD_RADIUS, bottom, bottom])
  }
}

function useDirectVideoFrame(link: CanvasLinkData): HTMLVideoElement | undefined {
  const [frame, setFrame] = useState<HTMLVideoElement>()
  useEffect(() => {
    if (link.previewSrc || link.previewKind !== 'video' || link.provider !== 'direct') {
      setFrame(undefined)
      return
    }
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    video.crossOrigin = 'anonymous'
    video.src = api.directVideoPreviewUrl(link.normalizedUrl)
    let alive = true
    const redraw = () => { if (alive) setFrame(video) }
    const seek = () => {
      try {
        video.currentTime = Math.min(0.1, Number.isFinite(video.duration) ? video.duration / 2 : 0.1)
      } catch {
        redraw()
      }
    }
    video.addEventListener('loadeddata', seek, { once: true })
    video.addEventListener('seeked', redraw, { once: true })
    video.addEventListener('error', redraw, { once: true })
    video.load()
    return () => {
      alive = false
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [link.normalizedUrl, link.previewKind, link.previewSrc, link.provider])
  return frame
}

export const LinkItem = memo(function LinkItem({
  item,
  store,
  projectId,
  draggable,
  selected,
}: {
  item: CanvasItem
  store: CanvasStore
  projectId: string
  draggable: boolean
  selected: boolean
}) {
  const groupRef = useRef<Konva.Group>(null)
  const preparingRef = useRef(false)
  const [preparing, setPreparing] = useState(false)
  // Окно входа открыто — состояние вида, а не доски: перезагрузка страницы
  // должна вернуть карточку к «Войти», а не к «Я вошёл».
  const [loginOpened, setLoginOpened] = useState(false)
  const link = item.link!
  const view = linkCardPresentation(link, { loginOpened })
  const colors = useThemeColors()
  const image = useImageEl(link.previewSrc)
  const video = useDirectVideoFrame(link)
  const preview = image ?? video
  const layout = linkItemLayout(item.w, item.h)
  // Кегли растут вместе с карточкой: иначе на растянутой карточке коробки
  // становятся больше, а подписи выглядят мельче (жалоба 19.08.2026).
  const scale = linkItemScale(item.w, item.h)
  const openLogin = () => {
    if (preparingRef.current) return
    preparingRef.current = true
    setPreparing(true)
    void api.openExtractorLogin(link.provider)
      // Кнопка меняется ТОЛЬКО после ответа сервера: если Firefox не нашёлся,
      // окно не открылось, и предлагать «Я вошёл» было бы враньём.
      .then(() => setLoginOpened(true))
      .catch((error) => {
        showErrorToast(error instanceof Error ? error.message : 'Failed to open the sign-in window')
      })
      .finally(() => {
        preparingRef.current = false
        setPreparing(false)
      })
  }

  const primary = () => {
    if (view.primaryKind === 'downloading' || preparingRef.current) return
    if (view.primaryKind === 'login') return openLogin()
    // «Я вошёл» — это повтор превью: оно и упёрлось во вход.
    if (view.primaryKind === 'retry-login') return retryPreview()
    preparingRef.current = true
    setPreparing(true)
    void mediaLinkController.downloadLink(store, projectId, item.id)
      .catch((error) => {
        showErrorToast(error instanceof Error ? error.message : 'Failed to start download')
      })
      .finally(() => {
        preparingRef.current = false
        setPreparing(false)
      })
  }

  const retryPreview = () => {
    void mediaLinkController.refreshLinkPreview(store, item.id, link.url)
  }

  return (
    <Group
      id={item.id}
      // Размер и скругление — для кольца выделения (SelectionRings).
      selectionFrame={{ w: item.w, h: item.h, radius: LINK_CARD_RADIUS }}
      ref={groupRef}
      x={item.x}
      y={item.y}
      width={item.w}
      height={item.h}
      rotation={item.rotation}
      draggable={draggable}
      onDragStart={(event) => onCanvasItemDragStart(store, item.id, event)}
      onDragMove={(event) => onCanvasItemDragMove(store, item.id, event)}
      onDragEnd={(event) => onDragEnd(store, item.id, event)}
      onTransform={() => groupRef.current && onTransformPreview(store, item.id, groupRef.current)}
      onTransformEnd={() => groupRef.current && onTransformEnd(store, item.id, groupRef.current)}
      onClick={(event) => selectOnClick(store, item.id, event)}
      onTap={(event) => selectOnClick(store, item.id, event as unknown as KEvent)}
    >
      <Rect width={item.w} height={item.h} cornerRadius={LINK_CARD_RADIUS} fill={colors.pendingFill} stroke={colors.itemBorder} strokeWidth={1} strokeScaleEnabled={false} perfectDrawEnabled={false} />
      <Group clipFunc={clipPreviewCorners(layout.preview.width, layout.preview.height, item.h)}>
        <Rect width={layout.preview.width} height={layout.preview.height} fill="rgba(127,127,127,0.12)" />
        {preview ? (
          <KonvaImage image={preview} width={layout.preview.width} height={layout.preview.height} listening={false} />
        ) : (
          <KonvaText width={layout.preview.width} height={layout.preview.height} text={view.previewStatus || (link.previewKind === 'video' ? '▶' : '▧')} align="center" verticalAlign="middle" fontSize={(view.previewStatus ? 12 : 34) * scale} fill={link.state === 'error' ? colors.errorText : colors.timerColor} listening={false} />
        )}
        {view.loginHint && (
          <KonvaText
            x={12}
            y={Math.max(8, layout.preview.height - 30)}
            width={Math.max(40, layout.preview.width - 24)}
            text={view.loginHint}
            align="center"
            fontSize={10 * scale}
            lineHeight={1.3}
            fill={colors.timerColor}
            fontFamily={CANVAS_SANS_FONT}
            wrap="word"
            ellipsis
            listening={false}
          />
        )}
        {view.canRetryPreview && (
          <CardActionButton
            x={Math.max(12, (layout.preview.width - 150) / 2)}
            y={Math.max(8, layout.preview.height - 42)}
            width={Math.min(150, layout.preview.width - 24)}
            height={30}
            label="Retry preview"
            textColor={colors.textColor}
            accent={colors.accent}
            accentHover={colors.accentHover}
            onPress={retryPreview}
          />
        )}
      </Group>
      {layout.badge.height > 0 && (
        <>
          <Rect x={layout.badge.x} y={layout.badge.y} width={Math.min(layout.badge.width, Math.max(64, view.source.length * 8 + 18))} height={layout.badge.height} cornerRadius={layout.badge.height / 2} fill={colors.accentSoft} />
          <KonvaText x={layout.badge.x + 9} y={layout.badge.y} height={layout.badge.height} text={view.source} verticalAlign="middle" fontSize={10 * scale} fontStyle="600" fill={colors.accent} fontFamily={CANVAS_SANS_FONT} listening={false} />
        </>
      )}
      {layout.title.height > 0 && (
        <KonvaText x={layout.title.x} y={layout.title.y} width={layout.title.width} height={layout.title.height} text={view.title} fontSize={15 * scale} lineHeight={1.25} fontStyle="600" fill={colors.textColor} fontFamily={CANVAS_SANS_FONT} wrap="word" ellipsis listening={false} />
      )}
      {layout.url.height > 0 && (
        <KonvaText x={layout.url.x} y={layout.url.y} width={layout.url.width} height={layout.url.height} text={link.state === 'error' ? view.previewStatus ?? view.shortUrl : view.shortUrl} fontSize={11 * scale} fill={link.state === 'error' ? colors.errorText : colors.timerColor} fontFamily={link.state === 'error' ? CANVAS_SANS_FONT : CANVAS_MONO_FONT} ellipsis listening={false} />
      )}
      <CardActionButton {...layout.openButton} label={view.openLabel} textColor={colors.textColor} accent={colors.accent} accentHover={colors.accentHover} onPress={() => window.open(link.normalizedUrl, '_blank', 'noopener,noreferrer')} />
      <CardActionButton
        {...layout.downloadButton}
        label={preparing ? (view.primaryKind === 'login' ? 'Opening window…' : 'Preparing…') : view.primaryAction}
        // Вход подсвечен так же, как скачивание: это и есть главное действие
        // карточки, пока площадка не пускает.
        primary={!preparing && (view.primaryKind === 'download' || view.primaryKind === 'login')}
        textColor={colors.textColor}
        accent={colors.accent}
        accentHover={colors.accentHover}
        onPress={primary}
      />
    </Group>
  )
})

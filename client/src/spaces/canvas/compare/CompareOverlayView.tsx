import { useEffect, useRef, useState } from 'react'
import type { CanvasItem } from '../konva/types'
import { ComparePlayer } from './ComparePlayer'
import { useComparePlayer, useComparePlayerSpace } from './useComparePlayer'
import {
  naturalSize,
  overlayFrame,
  wipeClipPath,
  wipeFractionInBox,
  wipePercent,
  zoomedBox,
  type Size,
} from './compareLayout'
import { useSharedZoom } from '../../../ui/useSharedZoom'
import { useT } from '../../../i18n/context.js'


// Наложение — совмещение двух кадров в одном прямоугольнике. Три способа
// смотреть, каждый отдельной кнопкой (раньше «переключение» было спрятано в
// пробел поверх шторы, и о нём нельзя было догадаться):
//   wipe   — штора за курсором
//   toggle — пробел (или клик) переключает исходник ↔ кандидат на месте
//   diff   — mix-blend-mode: difference, чёрное = одинаково
//
// Что здесь легко сделать неправильно (и было сделано):
// 1) оба кадра обязаны занимать ОДИН прямоугольник, иначе при разных
//    пропорциях они висят по-разному и сравнивать нечего;
// 2) зум задаётся РАЗМЕРОМ коробки, а не transform: scale — иначе браузер
//    растягивает готовый слой и разрешение теряется;
// 3) mix-blend-mode: difference обязан стоять на ВЕРХНЕМ слое: нижний
//    смешивается с фоном, а не с соседней картинкой;
// 4) видео здесь тоже работает, и оба слоя обязаны идти ОДНИМ плеером —
//    разойдись они на полсекунды, штора покажет разницу таймкодов, а не
//    разницу моделей, и сравнение соврёт.

export type OverlayMode = 'wipe' | 'toggle' | 'diff'

/**
 * Слой наложения: картинка или видео.
 *
 * ⚠️ Видео в наложении обязано быть БЕЗ звука и без своих кнопок. Два
 * одновременных звука — каша, а вторая панель управления поверх кадра — ровно
 * то, из-за чего смотреть было нечем. Играют оба слоя вместе, ведёт их
 * вызывающий.
 */
function MediaLayer({
  item,
  className,
  style,
  onVideo,
}: {
  item: CanvasItem
  className: string
  style?: React.CSSProperties
  onVideo: (el: HTMLVideoElement | null) => void
}) {
  if (item.kind === 'video') {
    return (
      <video
        ref={onVideo}
        className={className}
        style={style}
        src={item.src}
        muted
        playsInline
        preload="auto"
      />
    )
  }
  return <img className={className} style={style} src={item.src} alt="" draggable={false} />
}

function useElementSize(ref: React.RefObject<HTMLElement>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      setSize({ width: rect.width, height: rect.height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

export function CompareOverlayView({
  baseline,
  candidate,
  mode,
  showBaseline,
}: {
  baseline: CanvasItem
  candidate: CanvasItem
  mode: OverlayMode
  // режим переключения: что сейчас на экране (кто есть кто — пишет шапка)
  showBaseline: boolean
}) {
  const t = useT()
  const [wipe, setWipe] = useState(50)
  const frameRef = useRef<HTMLDivElement>(null)
  // 0 — кандидат (нижний слой), 1 — исходник (верхний); порядок для плеера не
  // важен, ведущим он берёт самое длинное видео
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([])
  const videoCount = [candidate, baseline].filter((item) => item.kind === 'video').length
  const player = useComparePlayer(videoRefs, `${baseline.id}:${candidate.id}`)
  // ⚠️ Пробел здесь принадлежит режиму «Переключение» (подглядка на удержании),
  // и отбирать его у него нельзя. В «Шторе» и «Разнице» он свободен — там его
  // берёт плеер.
  useComparePlayerSpace(player.togglePlay, videoCount > 0 && mode !== 'toggle')

  const frame = useElementSize(frameRef)
  const { zoom, zoomed, surfaceProps, reset, zoomToPoint } = useSharedZoom(frameRef)

  // общая коробка для обоих кадров — по пропорциям исходника, затем зум
  const fitted = overlayFrame(naturalSize(baseline), frame)
  const box = zoomedBox(fitted, frame, zoom)

  // Двойной клик: первый раз — 100% (пиксель в пиксель) в точку клика,
  // второй — обратно «вписать». Не тумблер состояний: если уже приближено
  // любым способом, двойной клик всегда возвращает к вписанному кадру.
  // Плеер — обычные кнопки и ползунок: движение и клики по нему не должны
  // ни двигать штору, ни приближать кадр.
  function overPlayer(event: React.MouseEvent): boolean {
    return event.target instanceof HTMLElement && Boolean(event.target.closest('.compare-player'))
  }

  function onDoubleClick(event: React.MouseEvent): void {
    if (overPlayer(event)) return
    const rect = frameRef.current?.getBoundingClientRect()
    if (!rect) return
    if (zoomed) {
      reset()
      return
    }
    const natural = naturalSize(baseline)
    const fullScale = fitted.width > 0 ? natural.width / fitted.width : 1
    if (fullScale <= 1.001) return // кадр и так меньше натурального
    zoomToPoint(fullScale, { x: event.clientX - rect.left, y: event.clientY - rect.top }, frame)
  }

  function trackWipe(event: React.MouseEvent): void {
    if (mode !== 'wipe' || overPlayer(event)) return
    // зажатая кнопка при зуме — это пан, а не штора
    if (zoomed && event.buttons === 1) return
    const rect = frameRef.current?.getBoundingClientRect()
    if (!rect) return
    setWipe(wipePercent(event.clientX, rect))
  }

  const fraction = mode === 'wipe' ? wipeFractionInBox(wipe, box, frame) : 1
  const boxStyle = { left: box.x, top: box.y, width: box.width, height: box.height }

  // в режиме переключения верхний слой либо показан целиком, либо убран
  const baselineHidden = mode === 'toggle' && !showBaseline

  return (
    <div
      className={`compare-frame mode-${mode} ${zoomed ? 'is-zoomed' : ''}`}
      ref={frameRef}
      onMouseMove={trackWipe}
      onDoubleClick={onDoubleClick}
      {...surfaceProps}
    >
      <div className="compare-media" style={boxStyle}>
        {/* нижний слой — кандидат */}
        <MediaLayer
          item={candidate}
          className="compare-layer"
          onVideo={(el) => {
            videoRefs.current[0] = el
          }}
        />
        {/* верхний слой — исходник */}
        <MediaLayer
          item={baseline}
          className="compare-layer compare-layer-baseline"
          onVideo={(el) => {
            videoRefs.current[1] = el
          }}
          style={
            mode === 'diff'
              ? { mixBlendMode: 'difference' }
              : baselineHidden
                ? { visibility: 'hidden' }
                : { clipPath: wipeClipPath(fraction * 100) }
          }
        />
      </div>

      {mode === 'wipe' && (
        <div className="compare-wipe-handle" style={{ left: `${wipe}%` }} aria-hidden="true">
          <i />
        </div>
      )}

      {zoomed && (
        <button className="compare-zoom-reset" onClick={reset}>

          {t('Fit')}
        </button>
      )}

      {videoCount > 0 && (
        <ComparePlayer
          playing={player.playing}
          time={player.time}
          duration={player.duration}
          rate={player.rate}
          alternate={player.alternate}
          canAlternate={videoCount === 2}
          onToggle={player.togglePlay}
          onSeek={player.seek}
          onRate={player.changeRate}
          onAlternate={player.setAlternate}
        />
      )}
    </div>
  )
}

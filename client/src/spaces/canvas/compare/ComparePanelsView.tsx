import { useRef } from 'react'
import type { CanvasItem } from '../konva/types'
import { ComparePlayer } from './ComparePlayer'
import { useComparePlayer, useComparePlayerSpace } from './useComparePlayer'
import { useSharedZoom, zoomTransform } from '../../../ui/useSharedZoom'
import { useT } from '../../../i18n/context.js'


// Панели рядом — раскладка по умолчанию, когда в сравнении есть видео: на
// движении важнее видеть оба кадра целиком, чем совмещать их. Зум общий,
// плеер один на все панели (сам плеер и его логика — общие с наложением).

export function ComparePanelsView({
  items,
  labels,
}: {
  items: CanvasItem[]
  labels: string[]
}) {
  const t = useT()
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([])
  const wrapRef = useRef<HTMLDivElement>(null)
  // колесо слушаем на стабильной обёртке (панели пересоздаются при листании),
  // и обязательно нативно — React вешает wheel пассивно
  const { zoom, zoomed, surfaceProps, reset } = useSharedZoom(wrapRef)

  const videoCount = items.filter((item) => item.kind === 'video').length
  const canAlternate = videoCount === 2
  const player = useComparePlayer(videoRefs, items)
  // здесь пробел принадлежит плееру: своего режима «Переключение» у панелей нет
  useComparePlayerSpace(player.togglePlay, videoCount > 0)


  let videoSlot = -1

  return (
    <div className="compare-panels-wrap" ref={wrapRef}>
      <div className="compare-panels" style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}>
        {items.map((item, index) => {
          const isVideo = item.kind === 'video'
          if (isVideo) videoSlot += 1
          const slot = videoSlot
          return (
            <div className={`compare-panel ${zoomed ? 'is-zoomed' : ''}`} key={item.id} {...surfaceProps}>
              <span className="compare-panel-label">{labels[index]}</span>
              <div className="compare-sync-layer" style={{ transform: zoomTransform(zoom) }}>
                {isVideo ? (
                  <video
                    ref={(el) => {
                      videoRefs.current[slot] = el
                    }}
                    src={item.src}
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <img src={item.src} alt="" draggable={false} />
                )}
              </div>
            </div>
          )
        })}
      </div>

      {videoCount > 0 && (
      <ComparePlayer
        playing={player.playing}
        time={player.time}
        duration={player.duration}
        rate={player.rate}
        alternate={player.alternate}
        canAlternate={canAlternate}
        onToggle={player.togglePlay}
        onSeek={player.seek}
        onRate={player.changeRate}
        onAlternate={player.setAlternate}
        extra={
          zoomed ? (
            <button className="compare-zoom-reset inline" onClick={reset}>
              Reset zoom
            </button>
          ) : null
        }
      />
      )}
      {videoCount === 0 && zoomed && (
        <button className="compare-zoom-reset" onClick={reset}>

          {t('Fit')}
        </button>
      )}
    </div>
  )
}

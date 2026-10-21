import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { TabletFullScreen } from './TabletFullScreen'
import { TabletVideoPlayer } from './TabletVideoPlayer'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { TabletMediaUploader } from './runtime'
import { askConfirm } from '../ui/confirmBus'
import { useT } from '../i18n/context.js'


/**
 * Крупный просмотр материала с доски.
 *
 * Это отдельный режим просмотра: камера доски и размеры объекта остаются
 * нетронутыми. В режиме «100%» прокрутка относится только к этому окну, чтобы
 * двойной tap не превращался в случайный resize или зум всей доски.
 */
export function TabletMediaViewer({
  item,
  onClose,
  store,
  upload,
}: {
  item: CanvasItem & { kind: 'image' | 'video'; src: string }
  onClose(): void
  store?: CanvasStore
  upload?: TabletMediaUploader
}) {
  const t = useT()
  const [view, setView] = useState<'fit' | 'actual'>('fit')
  const stageRef = useRef<HTMLDivElement>(null)
  const selection = useRef({ count: 0, busy: false })
  const [addingFrames, setAddingFrames] = useState(false)
  const onSelection = useCallback((count: number, busy: boolean) => { selection.current = { count, busy }; setAddingFrames(busy) }, [])
  const requestClose = async () => {
    if (selection.current.busy) return
    if (selection.current.count && !await askConfirm({ title: t('Close frame selection?'), detail: t('Frames selected: {0}.. They are not on the canvas yet.', { 0: selection.current.count }), confirmLabel: t('Close without adding'), cancelLabel: t('Back to frames') })) return
    onClose()
  }

  // A scroll position from 100% mode survives a CSS display change. If the
  // device rotates or the tablet UI is pinched while the viewer is open, that
  // stale position makes the next fitted image appear far to one side. Reset
  // the local viewport whenever the fitted stage is laid out again.
  const resetFitScroll = () => {
    const stage = stageRef.current
    if (view === 'fit' && stage) {
      stage.scrollLeft = 0
      stage.scrollTop = 0
    }
  }

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const update = () => resetFitScroll()
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(stage)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    window.addEventListener('canai-tablet-ui-scale', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
      window.removeEventListener('canai-tablet-ui-scale', update)
    }
  }, [view])

  const title = item.name || (item.kind === 'image' ? t('Image') : t('Video'))
  const dimensions = item.naturalWidth && item.naturalHeight
    ? `${item.naturalWidth} × ${item.naturalHeight}`
    : `${Math.round(item.w)} × ${Math.round(item.h)}`

  return (
    <TabletFullScreen
      title={t('Large preview')}
      subtitle={t('{0} · {1}  · object size does not change', { 0: title, 1: dimensions })}
      onCancel={() => void requestClose()}
      cancelLabel={t('Close')}
      tone="dark"
      center={item.kind === 'image' &&
        <div className="tablet-media-viewer-controls" role="group" aria-label={t('Preview scale')}>
          <button
            type="button"
            className={`ui-btn quiet ${view === 'fit' ? 'on' : ''}`}
            aria-pressed={view === 'fit'}
            onClick={() => setView('fit')}
          >

            {t('Fit')}
          </button>
          <button
            type="button"
            className={`ui-btn quiet ${view === 'actual' ? 'on' : ''}`}
            aria-pressed={view === 'actual'}
            onClick={() => setView('actual')}
          >
            100%
          </button>
        </div>
      }
      primary={<button type="button" className="ui-btn primary" disabled={addingFrames} onClick={() => void requestClose()}>{addingFrames ? t('Adding frames…') : t('Done')}</button>}
      footer={<span className="tablet-media-viewer-note">{item.kind === 'video' ? t('Selected frames are added next to the video. Cancel removes the whole set in one step.') : t('Preview does not change the object position, size, or board history.')}</span>}
    >
      <div
        ref={stageRef}
        className={`tablet-media-viewer-stage ${view === 'actual' ? 'actual' : 'fit'}`}
        aria-label={t('{0},, large preview', { 0: title })}
        onDoubleClick={() => { if (item.kind === 'image') setView((current) => current === 'fit' ? 'actual' : 'fit') }}
      >
        {item.kind === 'image' ? (
          <img src={item.src} alt={title} draggable={false} onLoad={resetFitScroll} />
        ) : (
          <TabletVideoPlayer key={item.id} item={item} store={store} upload={upload} onLayout={resetFitScroll} onSelection={onSelection} onAdded={onClose} />
        )}
      </div>
    </TabletFullScreen>
  )
}

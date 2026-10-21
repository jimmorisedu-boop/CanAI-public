import { useCallback, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { IconNext, IconPrev } from '../ui/icons'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { useContentVersion } from '../spaces/canvas/konva/useStore'
import { useCatalogModels } from '../spaces/canvas/genOptions'
import { compareLayout, wipeClipPath, wrapCursor, type CompareKind } from '../spaces/canvas/compare/compareLayout'
import { panelLabel, panelSubLabel } from '../spaces/canvas/compare/compareLabels'
import { DEFAULT_FACE_THRESHOLD } from '../spaces/canvas/compare/faceMath'
import { FaceSimilarityChip, useFaceSimilarity } from '../spaces/canvas/compare/FaceSimilarityChip'
import { api } from '../api'
import { notify } from '../spaces/canvas/notifications'
import { TabletFullScreen } from './TabletFullScreen'
import { previewSrc } from './remoteSession'
import { useBoardHistory } from './boardHistory'
import { useComparePlayer } from '../spaces/canvas/compare/useComparePlayer'
import { isActiveModal } from './modalFocus'
import { MediaPlaybackControls } from '../ui/MediaPlaybackControls'
import { useT } from '../i18n/context.js'


// Сравнение исходника с кандидатами.
//
// Правила раскладки и подписей — общие с компьютером: только картинки →
// наложение, есть видео → рядом; в кадре не больше двух единиц контента,
// остальные листаются. Планшетное здесь одно: вместо удержания пробела —
// удержание пальца на кадре, а вместо колеса — обычный просмотр без зума.

type Mode = 'wipe' | 'switch' | 'diff'

export function TabletCompare({
  store,
  baseId,
  candidateIds,
  onClose,
}: {
  store: CanvasStore
  baseId: string
  candidateIds: string[]
  onClose(): void
}) {
  const t = useT()
  const history = useBoardHistory()
  useContentVersion(store)
  const { models } = useCatalogModels()
  const [cursor, setCursor] = useState(0)
  const [mode, setMode] = useState<Mode>('wipe')
  const [wipe, setWipe] = useState(50)
  const [holding, setHolding] = useState(false)
  const [threshold, setThreshold] = useState(DEFAULT_FACE_THRESHOLD)
  const [faceAttempt, setFaceAttempt] = useState(0)

  const baseline = store.getItem(baseId)
  const candidates = useMemo(
    () => candidateIds.map((id) => store.getItem(id)).filter((item): item is CanvasItem => Boolean(item)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidateIds, store, store.getContentVersion()],
  )

  const candidate = candidates[wrapCursor(cursor, Math.max(1, candidates.length))]
  const face = useFaceSimilarity(baseline, candidate, faceAttempt)
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([])
  const surfaceRef = useRef<HTMLDivElement>(null)
  const shownMedia = `${baseline?.id}:${baseline?.src}|${candidate?.id}:${candidate?.src}`
  useComparePlayer(videoRefs, shownMedia, () => {
    const modal = surfaceRef.current?.closest<HTMLElement>('[aria-modal="true"]')
    return Boolean(modal && isActiveModal(modal))
  })

  if (!baseline) return null

  const kinds: CompareKind[] = [baseline, candidate]
    .filter((item): item is CanvasItem => Boolean(item))
    .map((item) => (item.kind === 'video' ? 'video' : 'image'))
  const layout = candidate ? compareLayout(kinds) : 'side-by-side'

  const archiveLoser = () => {
    if (!candidate) return
    store.archiveItems([candidate.id])
    notify({
      kind: 'success',
      message: t('Candidate moved to archive'),
      action: { label: t('Undo'), run: history.undo },
    })
    if (candidates.length <= 1) onClose()
  }

  const keepThis = () => {
    if (!candidate) return
    const losers = candidates.filter((item) => item.id !== candidate.id).map((item) => item.id)
    if (losers.length > 0) {
      const moved = store.archiveItems(losers)
      notify({
        kind: 'success',
        message: t('Archive: {0} {1}', { 0: moved, 1: t(Math.abs(moved) === 1 ? 'candidate' : 'candidates') }),
        action: { label: t('Undo'), run: history.undo },
      })
    }
    store.setSelection([candidate.id])
    onClose()
  }

  return (
    <TabletFullScreen
      title={t('Compare')}
      onCancel={onClose}
      cancelLabel={t('Close')}
      tone="dark"
      center={layout === 'overlay' ? (
        <div className="ui-toggle" role="group" aria-label={t('Overlay mode')}>
          {([['wipe', 'Wipe'], ['switch', 'Switch'], ['diff', 'Difference']] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={mode === value ? 'on' : ''}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {t(label)}
            </button>
          ))}
        </div>
      ) : undefined}
      primary={
        <div className="tablet-compare-nav">
          <span className="tablet-mono">{candidates.length > 0 ? t('{0}  of {1}', { 0: wrapCursor(cursor, candidates.length) + 1, 1: candidates.length }) : t('—')}</span>
          <button type="button" className="ui-icon-btn" aria-label={t('Previous')} disabled={candidates.length < 2} onClick={() => setCursor((value) => value - 1)}>
            <IconPrev size={18} />
          </button>
          <button type="button" className="ui-icon-btn" aria-label={t('Next')} disabled={candidates.length < 2} onClick={() => setCursor((value) => value + 1)}>
            <IconNext size={18} />
          </button>
        </div>
      }
      footer={
        <>
          <span className="tablet-hint">{kinds.includes('video')
            ? t('A / D — previous / next frame · Shift — 10 frames')
            : t('Hold the frame to show the original')}</span>
          <span className="tablet-full-gap" />
          <button type="button" className="ui-btn" disabled={!candidate} onClick={archiveLoser}>{t('Archive candidate')}</button>
          <button type="button" className="ui-btn primary" disabled={!candidate} onClick={keepThis}>{t('Keep this one')}</button>
        </>
      }
    >
      <div ref={surfaceRef} className={`tablet-compare ${layout}`}>
        {layout === 'overlay' && candidate ? (
          <div
            className="tablet-compare-stack"
            onPointerDown={(event) => {
              if (mode === 'switch') setHolding(true)
              if (mode === 'wipe') {
                const rect = event.currentTarget.getBoundingClientRect()
                setWipe(Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)))
              }
            }}
            onPointerMove={(event) => {
              if (mode !== 'wipe' || event.buttons === 0) return
              const rect = event.currentTarget.getBoundingClientRect()
              setWipe(Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)))
            }}
            onPointerUp={() => setHolding(false)}
            onPointerCancel={() => setHolding(false)}
          >
            <Media item={baseline} />
            <div
              className={`tablet-compare-top ${mode}`}
              style={{
                clipPath: mode === 'wipe' ? wipeClipPath(wipe) : undefined,
                opacity: mode === 'switch' && holding ? 0 : 1,
              }}
            >
              <Media item={candidate} />
            </div>
            {mode === 'wipe' && <span className="tablet-compare-wipe" style={{ left: `${wipe}%` }} />}
          </div>
        ) : (
          <>
            <Panel
              key={baseline.id}
              item={baseline}
              videoRef={video => { videoRefs.current[0] = video }}
              label={panelLabel(baseline, models, true)}
              sub={panelSubLabel(baseline, true)}
            />
            {candidate && (
              <Panel
                key={candidate.id}
                item={candidate}
                videoRef={video => { videoRefs.current[1] = video }}
                label={panelLabel(candidate, models, false)}
                sub={panelSubLabel(candidate, false)}
                chip={
                  <FaceSimilarityChip
                    state={face}
                    threshold={threshold}
                    onThreshold={(value) => {
                      setThreshold(value)
                      // Порог общий с компьютером: он живёт в настройках, а не
                      // в этом окне — иначе одна и та же пара получала бы
                      // разный вердикт на разных устройствах.
                      void api.patchSettings({ faceThreshold: value }).catch(() => {})
                    }}
                    onEnable={() => setFaceAttempt((value) => value + 1)}
                  />
                }
              />
            )}
          </>
        )}
      </div>

      {layout === 'overlay' && candidate && (
        <div className="tablet-compare-chip">
          <FaceSimilarityChip
            state={face}
            threshold={threshold}
            onThreshold={(value) => {
              setThreshold(value)
              void api.patchSettings({ faceThreshold: value }).catch(() => {})
            }}
            onEnable={() => setFaceAttempt((value) => value + 1)}
          />
        </div>
      )}
    </TabletFullScreen>
  )
}

function Panel({
  item,
  label,
  sub,
  chip,
  videoRef,
}: {
  item: CanvasItem
  label: string
  sub: string
  chip?: React.ReactNode
  videoRef?: Ref<HTMLVideoElement>
}) {
  return (
    <div className="tablet-compare-pane">
      <div className="tablet-compare-label">
        <b>{label}</b>
        <span className="tablet-mono">{sub}</span>
        <span className="tablet-full-gap" />
        {chip}
      </div>
      <div className="tablet-compare-media"><Media item={item} videoRef={videoRef} /></div>
    </div>
  )
}

function Media({ item, videoRef }: { item: CanvasItem; videoRef?: Ref<HTMLVideoElement> }) {
  const mediaRef = useRef<HTMLVideoElement | null>(null)
  const setMediaRef = useCallback((element: HTMLVideoElement | null) => {
    mediaRef.current = element
    if (typeof videoRef === 'function') videoRef(element)
  }, [videoRef])
  useImperativeHandle(
    typeof videoRef === 'function' ? null : videoRef,
    () => mediaRef.current!,
    [videoRef, item.src],
  )
  if (item.kind === 'video') {
    return (
      <div className="tablet-compare-media-player">
        <video ref={setMediaRef} src={item.src} playsInline preload="metadata" />
        <MediaPlaybackControls key={item.src} mediaRef={mediaRef} />
      </div>
    )
  }
  return <img src={previewSrc(item.src ?? '')} alt="" decoding="async" draggable={false} />
}

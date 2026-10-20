import { useCallback, useEffect, useRef, useState } from 'react'
import { ArchiveBar } from './archive/ArchiveBar'
import { AssetBar } from './AssetBar'
import { onCanvasPlace } from './canvasBus'
import { setActiveCanvasStore } from './activeCanvasStore'
import { CanvasOnboarding } from './CanvasOnboarding'
import { TimelineOverlay } from './timeline/TimelineOverlay'
import { useTimelineSession } from './timeline/useTimelineSession'
import { onTimelinePresentation } from './timeline/timelineBus'
import { closeCompare } from './compare/compareBus'
import { ComparePickerBar } from './compare/ComparePickerBar'
import { CompareViewer } from './compare/CompareViewer'
import { useCompareSession } from './compare/useCompareSession'
import { setCropTarget } from './cropBus'
import { CanvasStore } from './konva/canvasStore'
import { KonvaCanvas } from './konva/KonvaCanvas'
import { bakeSketchToNewImage } from './konva/sketchExport'
import { adoptResultForBoard, boardMediaUploader, setBoardUploadTarget } from './konva/boardUploader'
import { setExportBoardName } from './konva/zipExport'
import { PromptBar } from './PromptBar'
import { promptChatStore } from './promptChatStore'
import { initProjectSync, restoreProjectGenerationTasks, type ProjectLoadState, type ProjectSyncHandle } from './projectSync'
import { getSketchTarget, onSketchTarget, setSketchTarget } from './sketchBus'
import { downloadProjectSnapshot, type ProjectConflictSnapshot } from './projectConflict'
import { ProjectConflictState } from './ProjectConflictState'
import { BoardHandoffState } from './continuity/BoardHandoffState'
import { startBoardOwnership, type BoardOwnershipSession } from './continuity/boardOwnership'
import { api } from '../../api'
import type { BoardHolder, ProjectRef } from '../../types'
import { projectKey } from '../../projects/projectRef'
import { OperationState } from '../../ui/OperationState'
import { notify } from './notifications'
import { ImportQueuePanel } from './ImportQueuePanel'
import { registerGenerationFocusSink } from './generationFocusBus'
import { openArchive } from './archive/archiveBus'
import { onboardingStore, retryOnboardingOnBoardOpen } from './onboardingStore'
import { browserExternalEditRegistry } from './externalEditRegistry'
import { deliverExternalEditSession } from './externalEditApply'
import { registerMediaImportSink } from './mediaImportRegistry'
import { mediaLinkController, refreshUnsettledLinkPreviews, registerMediaLinkRetryHandler } from './konva/mediaLinkController'

const GENERATION_FOCUS_MS = 2200
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)))
}

export function CanvasSpace({ projectRef, projectName, canEdit, canComment: _canComment, canManage: _canManage = false, visible = true, chatOpen, onChatOpenChange }: {
  projectRef: ProjectRef
  projectName: string
  canEdit: boolean
  canComment: boolean
  canManage?: boolean
  visible?: boolean
  chatOpen: boolean
  onChatOpenChange(open: boolean): void
}) {
  const projectId = projectRef.id
  const [store] = useState(() => new CanvasStore())
  const [loadState, setLoadState] = useState<ProjectLoadState>('loading')
  const [syncHandle, setSyncHandle] = useState<ProjectSyncHandle | null>(null)
  const syncRef = useRef<ProjectSyncHandle | null>(null)
  syncRef.current = syncHandle
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [conflict, setConflict] = useState<ProjectConflictSnapshot | null>(null)
  const [conflictRetrying, setConflictRetrying] = useState(false)
  const [discardingCopy, setDiscardingCopy] = useState(false)
  const [sketching, setSketching] = useState(false)
  const [sketchBusy, setSketchBusy] = useState(false)
  const [timelinePeek, setTimelinePeek] = useState(false)
  const [handoff, setHandoff] = useState<BoardHolder | null>(null)
  const [returningBoard, setReturningBoard] = useState(false)
  const handoffRef = useRef<BoardHolder | null>(null)
  const ownershipRef = useRef<BoardOwnershipSession | null>(null)
  const [compareSession] = [useCompareSession()]
  const timelineSession = useTimelineSession(store)
  const [generationFocusTimer, setGenerationFocusTimer] = useState<number | null>(null)
  const boardUsable = loadState === 'ready' && !handoff

  useEffect(() => onTimelinePresentation((value) => setTimelinePeek(value === 'canvas')), [])
  useEffect(() => { void promptChatStore.loadProject(projectKey(projectRef)) }, [projectId, projectRef.source])
  useEffect(() => { void retryOnboardingOnBoardOpen(onboardingStore) }, [projectId])
  useEffect(() => { setBoardUploadTarget(projectRef); return () => setBoardUploadTarget(null) }, [projectId, projectRef])
  useEffect(() => { setExportBoardName(projectName); return () => setExportBoardName('') }, [projectName])

  useEffect(() => {
    let active = true
    setLoadState('loading'); setSyncHandle(null); setConflict(null)
    void initProjectSync(store, projectId, (state) => { if (active) setLoadState(state) }, (next) => { if (active) setConflict(next) }, undefined, (error) => { if (active) { console.warn('[CanAI] board load failed', error); setLoadState('error') } }).then((handle) => {
      if (!active) { void handle.dispose().catch((error) => console.warn('[CanAI] failed to complete saving closed board:', error)); return }
      setSyncHandle(handle)
      restoreProjectGenerationTasks(store, projectId)
    }).catch((error) => { if (active) { console.warn('[CanAI] board load failed', error); setLoadState('error') } })
    const release = setActiveCanvasStore(store)
    return () => { active = false; release(); const handle = syncRef.current; if (handle) void handle.dispose().catch((error) => console.warn('[CanAI] failed to complete board saving:', error)); syncRef.current = null }
  }, [store, projectId, loadAttempt])

  useEffect(() => {
    if (!boardUsable) return
    const session = startBoardOwnership(projectId, (state) => {
      if (state.status === 'other') { handoffRef.current = state.holder; setHandoff(state.holder); const handle = syncRef.current; if (handle) { void handle.dispose().catch(() => {}); setSyncHandle(null) } }
      else if (state.status === 'stale') setLoadAttempt((attempt) => attempt + 1)
      else if (state.status === 'mine' && handoffRef.current) { handoffRef.current = null; setHandoff(null); setLoadAttempt((attempt) => attempt + 1) }
    })
    ownershipRef.current = session
    return () => { session.stop(); ownershipRef.current = null }
  }, [boardUsable, projectId])

  const returnBoardHere = useCallback(async () => {
    setReturningBoard(true)
    try { const state = await ownershipRef.current?.claim(); if (state?.status === 'other') return; handoffRef.current = null; setHandoff(null); setLoadAttempt((attempt) => attempt + 1) }
    finally { setReturningBoard(false) }
  }, [])

  useEffect(() => {
    if (!boardUsable || !syncHandle) return
    return browserExternalEditRegistry.registerSink(projectId, (session) => deliverExternalEditSession(store, session, syncHandle))
  }, [boardUsable, projectId, store, syncHandle])
  useEffect(() => {
    if (!boardUsable) return
    const existing = refreshUnsettledLinkPreviews(store).catch(() => {})
    void existing
  }, [boardUsable, store, projectId])
  useEffect(() => {
    if (!boardUsable) return
    const unregisterSink = registerMediaImportSink(projectId, async (task) => {
      if (task.status === 'completed' || task.status === 'error' || task.status === 'cancelled' || task.status === 'interrupted') await store.completeMediaImport(task)
      else store.updateMediaImportProgress(task)
    })
    const unregisterRetry = registerMediaLinkRetryHandler((linkId, entryIds) => { void mediaLinkController.retryFailedLinkEntries(store, projectId, linkId, entryIds).catch(() => {}) })
    return () => { unregisterSink(); unregisterRetry() }
  }, [boardUsable, projectId, store])
  useEffect(() => onCanvasPlace((result, name) => {
    if (!boardUsable) return
    void adoptResultForBoard(result, name, projectRef).then((ready) => store.placeResult(ready, name)).catch((error) => notify({ kind: 'error', message: error instanceof Error ? error.message : 'Could not place result' }))
  }), [boardUsable, projectRef, store])
  useEffect(() => {
    if (!boardUsable) return
    const unregister = registerGenerationFocusSink(projectId, (request) => {
      if (generationFocusTimer !== null) window.clearTimeout(generationFocusTimer)
      const result = store.focusGenerationResults(request.jobIds)
      if (result.canvasIds.length > 0) {
        const timer = window.setTimeout(() => store.clearGenerationFocus(), GENERATION_FOCUS_MS)
        setGenerationFocusTimer(timer)
      } else if (result.archivedIds.length > 0) notify({ kind: 'info', message: 'Result is in Archive', action: { label: 'Open archive', run: openArchive } })
      else if (result.pendingJobIds.length > 0) notify({ kind: 'info', message: 'Result is still being added to the board' })
      else notify({ kind: 'error', message: 'Result deleted or no longer available' })
    })
    return () => { unregister(); if (generationFocusTimer !== null) window.clearTimeout(generationFocusTimer); store.clearGenerationFocus() }
  }, [boardUsable, projectId, store])
  useEffect(() => { setCropTarget(null); store.clearStrokes(); setSketchTarget(null); closeCompare(); return onSketchTarget((target) => setSketching(Boolean(target))) }, [projectId, store])

  // Escape exits sketch mode without baking the current strokes. Keep the
  // guard here as well as on the action button: a pending upload must finish
  // before the target is cleared so the new local image is not orphaned.
  function cancelSketch(): void {
    if (sketchBusy) return
    store.clearStrokes()
    setSketchTarget(null)
  }

  useEffect(() => {
    if (!sketching) return
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelSketch()
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'z') { e.preventDefault(); e.shiftKey ? store.redoStroke() : store.undoStroke() }
      else if (key === 'y') { e.preventDefault(); store.redoStroke() }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [sketching, sketchBusy, store])

  // Applying the sketch creates a new local image beside the source. A blank
  // sketch deliberately stays open so the user can draw before applying.
  async function finishSketch(): Promise<void> {
    const target = getSketchTarget()
    if (!target || sketchBusy) return
    setSketchBusy(true)
    try {
      const saved = await bakeSketchToNewImage(store, target, boardMediaUploader(projectRef))
      if (!saved) {
        notify({ kind: 'info', message: 'Draw at least one stroke inside the selected picture.' })
        return
      }
      store.clearStrokes()
      setSketchTarget(null)
    } catch (error) {
      notify({ kind: 'error', message: error instanceof Error ? error.message : 'Failed to save sketch' })
    } finally {
      setSketchBusy(false)
    }
  }
  const retryConflictRecovery = async () => { if (!syncHandle) return; setConflictRetrying(true); try { await syncHandle.retryConflictRecovery() } catch (cause) { notify({ kind: 'error', message: cause instanceof Error ? cause.message : 'Failed to save conflict copy' }) } finally { setConflictRetrying(false) } }
  const discardConflictCopy = async () => { const id = conflict?.recoveryProject?.id; if (!id) return; setDiscardingCopy(true); try { await api.deleteProject(id); window.location.reload() } catch (cause) { setDiscardingCopy(false); notify({ kind: 'error', message: cause instanceof Error ? cause.message : 'Failed to remove copy' }) } }
  const openConflictCopy = () => { const id = conflict?.recoveryProject?.id; if (id) window.location.assign(`?project=${encodeURIComponent(`local:${id}`)}`) }
  const boardLoaded = loadState === 'ready'
  return <div className={`canvas-space ${sketching ? 'sketching' : ''} ${timelineSession && !timelinePeek ? 'timeline' : ''}`} aria-label={`Board "${projectName}"`} style={visible ? undefined : { display: 'none' }}><div className="canvas-main">
    {boardLoaded && !handoff ? <><KonvaCanvas store={store} projectId={projectId} projectRef={projectRef} readOnly={!canEdit} sketching={sketching} sketchBusy={sketchBusy} onSketchDone={() => void finishSketch()} onSketchCancel={cancelSketch} visible={visible} /><>{canEdit && <CanvasOnboarding store={store} />}</>{timelineSession && <TimelineOverlay session={timelineSession} store={store} />}<PromptBar store={store} projectId={projectId} projectSource="local" projectName={projectName} ready chatOpen={chatOpen} onChatOpenChange={onChatOpenChange} /><ArchiveBar store={store} /><AssetBar store={store} />{compareSession?.phase === 'picking' && <ComparePickerBar store={store} session={compareSession} />}{compareSession?.phase === 'viewing' && <CompareViewer store={store} session={compareSession} />}<ImportQueuePanel /></> : loadState === 'loading' ? <div className="canvas-loading" role="status">Loading board…</div> : null}
    {loadState === 'error' && <OperationState title="Board failed to load" detail="The server is unavailable or the file cannot be read. An empty canvas will not be saved over the data." action={{ label: 'Retry', onClick: () => setLoadAttempt((attempt) => attempt + 1) }} />}
    {handoff && <BoardHandoffState holder={handoff} returning={returningBoard} onReturn={() => void returnBoardHere()} />}
    {(loadState === 'conflict-saving' || loadState === 'conflict') && <ProjectConflictState phase={loadState === 'conflict-saving' ? 'saving' : 'conflict'} conflict={conflict} retrying={conflictRetrying} discarding={discardingCopy} onOpenCopy={openConflictCopy} onUseServer={() => void discardConflictCopy()} onRetry={() => void retryConflictRecovery()} onRepair={() => syncHandle?.resumeInvalidSnapshot()} onDownload={() => conflict && downloadProjectSnapshot(conflict.local)} />}
  </div></div>
}

import React, { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, type ProjectMeta } from './api'
import { BillingHistoryModal } from './BillingHistoryModal'
import { ProjectsScreen } from './projects/ProjectsScreen'
import { SettingsModal } from './settings/SettingsModal'
import { onOpenSettings, onSettingsSaved } from './settings/settingsBus'
import type { SettingsSectionId } from './settings/settingsSections'
import { ShortcutsModal } from './ShortcutsModal'
import { subscribeHelp } from './help/helpBus'
import { onMacroEdit, type MacroEditRequest } from './spaces/canvas/macroEditBus'
import { GenerationTaskCenter } from './spaces/canvas/GenerationTaskCenter'
import { getSaveStatus, onSaveStatus, type SaveStatus } from './spaces/canvas/saveStatusBus'
import { createMacroEditorLeaveController, type MacroFinalize, type MacroLeaveOptions } from './spaces/nodes/macroEditorLeave'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { IconBack, IconBalance } from './ui/icons'
import { withViewTransition } from './ui/viewTransition'
import { OperationState } from './ui/OperationState'
import { GlobalNotifications } from './ui/GlobalNotifications'
import { falBalancePresentation } from './ui/falBalancePresentation'
import { Tooltip } from './ui/Tooltip'
import { TopbarActions, useTopbarAttention } from './ui/TopbarActions'
import { useCompactLayout } from './ui/useCompactLayout'
import { notify } from './spaces/canvas/notifications'
import { requestGenerationFocus } from './spaces/canvas/generationFocusBus'
import {
  registerGenerationResultNavigationSink,
  requestGenerationResultNavigation,
  sameBoard,
  resolveGenerationResultProject,
  shouldDismissGenerationResultNavigationError,
} from './spaces/canvas/generationResultNavigation'
import { requestProjectTrash } from './spaces/canvas/projectTrashBus'
import { dismissToast } from './spaces/canvas/toastBus'
import { onboardingStore } from './spaces/canvas/onboardingStore'
import { createRecoveryHelpTarget, registerRecoveryOnboardingTarget } from './spaces/canvas/onboardingTargets'
import { ExternalEditStatusHost } from './spaces/canvas/ExternalEditStatusHost'
import { browserExternalEditRegistry } from './spaces/canvas/externalEditRegistry'
import { resolveExternalEditNavigation } from './spaces/canvas/externalEditNavigation'
import type { ProjectRef } from './types'
import { activeLocalProject, requestedProjectRef, type ActiveProject } from './projects/activeProject'
import { projectKey } from './projects/projectRef'

const NodesSpace = lazy(() => import('./spaces/nodes/NodesSpace').then((module) => ({ default: module.NodesSpace })))
const CanvasSpace = lazy(() => import('./spaces/canvas/CanvasSpace').then((module) => ({ default: module.CanvasSpace })))

type View = 'gallery' | 'editor'

export function EditorTopbarTasks({ project }: { project: ActiveProject | null }) {
  return <GenerationTaskCenter currentProjectId={project?.id} />
}

function SaveIndicator() {
  const [status, setStatus] = useState<SaveStatus>(getSaveStatus())
  useEffect(() => onSaveStatus(setStatus), [])
  if (status === 'idle') return null
  const text = status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : 'Save failed!'
  return <span className={`save-indicator ${status}`}>{text}</span>
}

function FalBalanceIndicator({
  onClick,
  onBalanceUpdate,
}: {
  onClick: () => void
  onBalanceUpdate: (balance: number | null, currency: string) => void
}) {
  const [balance, setBalance] = useState<number | null>(null)
  const [currency, setCurrency] = useState('USD')
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [mockMode, setMockMode] = useState(false)

  const fetchBalance = useCallback(async (manual = false) => {
    if (manual) setLoading(true)
    try {
      const status = await api.status()
      setMockMode(status.mockMode)
      if (status.mockMode) {
        setBalance(null)
        setErrorMsg(null)
        onBalanceUpdate(null, 'USD')
        return
      }
      const result = await api.getFalBalance()
      if (result.balance != null) {
        setBalance(result.balance)
        setCurrency(result.currency || 'USD')
        setErrorMsg(null)
        onBalanceUpdate(result.balance, result.currency || 'USD')
      } else if (balance == null) {
        setErrorMsg(result.error || 'Balance unavailable')
        onBalanceUpdate(null, 'USD')
      }
    } catch {
      if (balance == null) {
        setErrorMsg('Network error')
        onBalanceUpdate(null, 'USD')
      }
    } finally {
      setLoading(false)
    }
  }, [balance, onBalanceUpdate])

  useEffect(() => {
    void fetchBalance(true)
    const timer = window.setInterval(() => void fetchBalance(false), 60_000)
    return () => window.clearInterval(timer)
  }, [fetchBalance])

  useEffect(() => onSettingsSaved(() => {
    setBalance(null)
    setErrorMsg(null)
    void fetchBalance(true)
  }), [fetchBalance])

  const presentation = falBalancePresentation({ mockMode, balance, currency, errorMsg })
  return (
    <Tooltip title="fal.ai balance" hint={`${presentation.tooltip} Click to view spending history.`}>
      <button type="button" className={`fal-balance-btn ${loading ? 'loading' : ''} ${balance == null ? 'no-balance' : ''}`} onClick={onClick}>
        <span className="fal-balance-icon" aria-hidden="true"><IconBalance size={14} weight="fill" /></span>
        <span className="fal-balance-val">{presentation.label}</span>
      </button>
    </Tooltip>
  )
}

export function App() {
  const compact = useCompactLayout()
  const { attention: topbarHasAttention } = useTopbarAttention()
  const [view, setView] = useState<View>('gallery')
  const [project, setProject] = useState<ActiveProject | null>(null)
  const [macroEdit, setMacroEdit] = useState<MacroEditRequest | null>(null)
  const macroEditRef = useRef(macroEdit)
  macroEditRef.current = macroEdit
  const [macroLeaveController] = useState(() => createMacroEditorLeaveController())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsHint, setSettingsHint] = useState<string | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [helpTopic, setHelpTopic] = useState<string | undefined>(undefined)
  const [recoveryTargetRequest, setRecoveryTargetRequest] = useState(0)
  const [billingHistoryOpen, setBillingHistoryOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [currentBalance, setCurrentBalance] = useState<number | null>(null)
  const [currentCurrency, setCurrentCurrency] = useState('USD')
  const [balanceTrigger, setBalanceTrigger] = useState(0)
  const [routeError, setRouteError] = useState<string | null>(null)
  const [routeAttempt, setRouteAttempt] = useState(0)
  const [routeResolving, setRouteResolving] = useState(() => Boolean(new URLSearchParams(window.location.search).get('project')))
  const generationNavigationAttemptRef = useRef(0)
  const projectRef = useRef<ProjectRef | null>(null)
  projectRef.current = project?.ref ?? null
  const externalEditSnapshot = useSyncExternalStore(
    browserExternalEditRegistry.subscribe,
    browserExternalEditRegistry.getSnapshot,
    browserExternalEditRegistry.getSnapshot,
  )

  const handleBalanceUpdate = useCallback((balance: number | null, currency: string) => {
    setCurrentBalance(balance)
    setCurrentCurrency(currency)
  }, [])

  const leaveMacroEditor = useCallback((onLeave: () => void, options?: MacroLeaveOptions): Promise<boolean> => {
    const transition = () => withViewTransition(() => {
      macroEditRef.current = null
      setMacroEdit(null)
      onLeave()
    })
    if (!macroEditRef.current) {
      transition()
      return Promise.resolve(true)
    }
    return macroLeaveController.leave(transition, options)
  }, [macroLeaveController])

  const registerMacroLeaveGuard = useCallback((finalize: MacroFinalize) => macroLeaveController.register(finalize), [macroLeaveController])
  const [isEditingName, setIsEditingName] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  async function commitRename() {
    if (!project) return
    const name = renameValue.trim()
    if (!name || name === project.name) {
      setIsEditingName(false)
      return
    }
    try {
      const result = await api.renameProject(project.id, name)
      if (result?.project) setProject(activeLocalProject(result.project))
    } catch (error) {
      notify({ kind: 'error', message: error instanceof Error ? error.message : 'Could not rename board' })
    } finally {
      setIsEditingName(false)
    }
  }

  function cancelRename() { setIsEditingName(false) }
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('canai-theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('canai-theme', theme)
  }, [theme])
  useEffect(() => { void onboardingStore.load() }, [])
  const openHelpModal = useCallback((topicId?: string) => {
    void onboardingStore.load({ force: true })
    setHelpTopic(topicId)
    setShortcutsOpen(true)
  }, [])
  useEffect(() => subscribeHelp((request) => openHelpModal(request.topicId)), [openHelpModal])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.defaultPrevented) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      event.preventDefault()
      openHelpModal()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openHelpModal])
  useEffect(() => { void browserExternalEditRegistry.load().catch(() => {}) }, [])
  useEffect(() => {
    onOpenSettings((hint, section) => {
      setSettingsHint(hint ?? null)
      setSettingsSection(section)
      setSettingsOpen(true)
    })
    return () => onOpenSettings(null)
  }, [])
  useEffect(() => {
    onMacroEdit((request) => {
      void leaveMacroEditor(() => {
        macroEditRef.current = request
        setMacroEdit(request)
      })
    })
    return () => onMacroEdit(null)
  }, [leaveMacroEditor])

  useEffect(() => {
    const loadFromUrl = () => {
      const id = new URLSearchParams(window.location.search).get('project')
      if (!id) {
        setProject(null)
        setView('gallery')
        setRouteError(null)
        setRouteResolving(false)
        return
      }
      setRouteResolving(true)
      let ref: ProjectRef
      try { ref = requestedProjectRef(id) } catch {
        setProject(null)
        setRouteError('Invalid board link')
        setRouteResolving(false)
        return
      }
      api.listProjects().then(({ projects }) => {
        const found = projects.find((item) => item.id === ref.id)
        if (found) {
          setProject(activeLocalProject(found))
          setView('editor')
          setRouteError(null)
        } else {
          setProject(null)
          setRouteError('Board not found')
        }
        setRouteResolving(false)
      }).catch(() => {
        setProject(null)
        setRouteError('Could not reach the local server')
        setRouteResolving(false)
      })
    }
    loadFromUrl()
    window.addEventListener('popstate', loadFromUrl)
    return () => window.removeEventListener('popstate', loadFromUrl)
  }, [routeAttempt])

  useEffect(() => {
    if (project) {
      const url = `?project=${encodeURIComponent(projectKey(project.ref))}`
      if (window.location.search !== url) window.history.pushState(null, '', url)
    } else if (window.location.search && !macroEdit && !routeError && !routeResolving) {
      window.history.pushState(null, '', '/')
    }
  }, [project, macroEdit, routeError, routeResolving])
  useEffect(() => {
    if (!shortcutsOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShortcutsOpen(false)
        setHelpTopic(undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcutsOpen])
  useEffect(() => registerRecoveryOnboardingTarget(createRecoveryHelpTarget({
    openHelp: () => {
      openHelpModal()
      setRecoveryTargetRequest((request) => request + 1)
    },
  })), [openHelpModal])

  function openLocalProject(next: ProjectMeta): void {
    void leaveMacroEditor(() => {
      setProject(activeLocalProject(next))
      setView('editor')
    })
  }
  function openProject(_ref: ProjectRef, next: ProjectMeta): void { openLocalProject(next) }
  async function openExternalEditProject(projectId: string): Promise<void> {
    const resolution = await resolveExternalEditNavigation(projectId, api)
    if (resolution.kind === 'active') { openLocalProject(resolution.project); return }
    if (resolution.kind === 'trash') {
      requestProjectTrash({ projectId: resolution.project.id })
      notify({ kind: 'info', message: 'The board is in Trash' })
      void leaveMacroEditor(() => { setProject(null); setView('gallery') })
      return
    }
    notify({ kind: resolution.kind === 'missing' ? 'error' : 'error', message: resolution.kind === 'missing' ? 'The external edit board is no longer available' : resolution.message })
  }
  function revealExternalEdit(src: string): void {
    void api.revealFile(src).catch((error) => notify({ kind: 'error', message: error instanceof Error ? error.message : 'Could not reveal file' }))
  }
  function stopExternalEdit(sessionId: string): void {
    void browserExternalEditRegistry.stop(sessionId).catch((error) => notify({ kind: 'error', message: error instanceof Error ? error.message : 'Could not stop watching' }))
  }

  useEffect(() => registerGenerationResultNavigationSink((request) => {
    if (sameBoard(request.projectRef, projectRef.current)) {
      requestGenerationFocus({ projectId: request.projectRef.id, jobIds: request.jobIds })
      return
    }
    const attempt = ++generationNavigationAttemptRef.current
    void resolveGenerationResultProject(request.projectRef, api).then((resolution) => {
      if (attempt !== generationNavigationAttemptRef.current) return
      if (shouldDismissGenerationResultNavigationError(resolution)) dismissToast('generation-result-navigation')
      if (resolution.kind === 'active') {
        requestGenerationFocus({ projectId: request.projectRef.id, jobIds: request.jobIds })
        openProject(request.projectRef, resolution.project)
        return
      }
      if (resolution.kind === 'trash') {
        requestProjectTrash({ projectId: resolution.project.id })
        notify({ kind: 'info', message: 'The board is in Trash' })
        void leaveMacroEditor(() => { setProject(null); setView('gallery') })
        return
      }
      notify({ kind: 'error', message: resolution.kind === 'missing' ? 'The board is no longer available' : resolution.message, action: { label: 'Retry', run: () => requestGenerationResultNavigation(request) }, replaceKey: 'generation-result-navigation' })
    })
  }), [leaveMacroEditor])

  function backToGallery(): void { void leaveMacroEditor(() => { setView('gallery'); setProject(null) }) }
  function openSettings(): void { setSettingsHint(null); setSettingsSection(undefined); setSettingsOpen(true) }

  const externalEditStatus = (
    <ExternalEditStatusHost
      snapshot={externalEditSnapshot}
      currentProjectId={project?.id ?? null}
      onOpenProject={(id) => void openExternalEditProject(id)}
      onOpenTrash={(id) => void openExternalEditProject(id)}
      onRevealFile={revealExternalEdit}
      onStop={stopExternalEdit}
    />
  )
  const noticeCorner = <div className="notice-corner">{externalEditStatus}<GlobalNotifications /></div>

  if (routeResolving) return <>{noticeCorner}<div className="route-error-page"><div role="status">Opening board…</div></div></>
  if (routeError) return <><div className="route-error-page"><OperationState title={routeError} detail="Your link is saved. Try connecting again or return to the board list." action={{ label: 'Retry', onClick: () => setRouteAttempt((attempt) => attempt + 1) }} secondary={{ label: 'Boards', onClick: () => { window.history.replaceState(null, '', '/'); setRouteError(null); setView('gallery') } }} /></div>{noticeCorner}</>
  if (view === 'gallery') return <>
    {noticeCorner}
    <ProjectsScreen
      onOpen={openProject}
      onSettings={openSettings}
      theme={theme}
      setTheme={(next) => { if (next === 'light' || next === 'dark') setTheme(next) }}
    />
    <button type="button" className="help-global-trigger" aria-label="Open Help" title="Open Help (？)" onClick={() => openHelpModal()}>?</button>
    {settingsOpen && <SettingsModal hint={settingsHint} section={settingsSection} onClose={() => setSettingsOpen(false)} />}
    {shortcutsOpen && <ShortcutsModal onClose={() => { setShortcutsOpen(false); setHelpTopic(undefined) }} editorMounted={false} initialTopicId={helpTopic} />}
  </>

  return <div className="app-shell">
    {noticeCorner}
    <header className="top-bar" data-compact={compact || undefined}>
      <button className="brand-back" title="All boards (Ctrl-click to open the gallery in a new tab)" onClick={(event) => event.ctrlKey || event.metaKey ? window.open('/', '_blank', 'noopener') : backToGallery()}>
        <IconBack className="brand-back-arrow" size={20} /> <span className="brand">CanAI</span>
      </button>
      {(project || macroEdit) && <div className="top-bar-title-group">
        {project && <><span className="top-project-name-dot">·</span>{isEditingName ? <input className="top-project-name-input" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === 'Enter') void commitRename(); if (event.key === 'Escape') cancelRename() }} autoFocus onFocus={(event) => event.target.select()} /> : <button type="button" className="top-project-name editable" title="Click to rename" onClick={() => { setIsEditingName(true); setRenameValue(project.name) }}>{project.name}</button>}</>}
        {macroEdit && <><span className="top-project-name-dot">·</span><span className="top-project-name">Macro · slot {macroEdit.slot + 1}</span></>}
      </div>}
      <TopbarActions
        compact={compact}
        attention={topbarHasAttention}
        save={<SaveIndicator />}
        shareActions={null}
        exportControl={<div id="top-bar-export-portal" style={{ display: 'contents' }} />}
        tasks={<EditorTopbarTasks project={project} />}
        balance={<FalBalanceIndicator key={balanceTrigger} onClick={() => setBillingHistoryOpen(true)} onBalanceUpdate={handleBalanceUpdate} />}
        theme={theme}
        onSettings={openSettings}
        onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onHelp={() => openHelpModal()}
      />
    </header>
    <main className="space-host">
      {project && <div className="space-pane"><ErrorBoundary label="canvas"><Suspense fallback={<div className="canvas-loading">Loading board…</div>}><CanvasSpace key={projectKey(project.ref)} projectRef={project.ref} projectName={project.name} canEdit={project.canEdit} canComment={project.capabilities.canComment} canManage={project.capabilities.canManage} visible={!macroEdit} chatOpen={chatOpen} onChatOpenChange={setChatOpen} /></Suspense></ErrorBoundary></div>}
      {macroEdit && <div className="space-pane" style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'var(--bg)' }}><ErrorBoundary label="macro editor"><Suspense fallback={<div className="canvas-loading">Loading editor…</div>}><NodesSpace key={`${macroEdit.slot}:${macroEdit.macroId ?? 'new'}`} slot={macroEdit.slot} macroId={macroEdit.macroId} scope={macroEdit.scope ?? 'canvas'} source="local" theme={theme} onClose={(options) => leaveMacroEditor(() => {}, options)} registerLeaveGuard={registerMacroLeaveGuard} /></Suspense></ErrorBoundary></div>}
    </main>
    {settingsOpen && <SettingsModal hint={settingsHint} section={settingsSection} onClose={() => setSettingsOpen(false)} />}
    {shortcutsOpen && <ShortcutsModal onClose={() => { setShortcutsOpen(false); setHelpTopic(undefined) }} editorMounted={Boolean(project)} recoveryTargetRequest={recoveryTargetRequest} initialTopicId={helpTopic} />}
    {billingHistoryOpen && <BillingHistoryModal balance={currentBalance} currency={currentCurrency} onClose={() => setBillingHistoryOpen(false)} onRefreshBalance={() => setBalanceTrigger((value) => value + 1)} />}
  </div>
}

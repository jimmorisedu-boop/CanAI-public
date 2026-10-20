import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { setExportBoardName } from '../spaces/canvas/konva/zipExport'
import { setBoardUploadTarget } from '../spaces/canvas/konva/boardUploader'
import { ApiError, isLocalServiceUnavailable } from '../api'
import type { BoardHolder } from '../types'
import { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { startBoardOwnership, type BoardOwnershipSession } from '../spaces/canvas/continuity/boardOwnership'
import { boardHandoffDetail } from '../spaces/canvas/continuity/BoardHandoffState'
import { getGenerationTasks, subscribeGenerationTasks } from '../spaces/canvas/generationRegistry'
import { useContentVersion } from '../spaces/canvas/konva/useStore'
import { InlineNotice } from '../ui/InlineNotice'
import { getSaveStatus, onSaveStatus } from '../spaces/canvas/saveStatusBus'
import { BoardCanvas } from './BoardCanvas'
import { tabletMediaUploader } from './runtime'
import { TabletDialog } from './TabletDialog'
import { mediaDoubleTapAction } from './generationDetails'
import { requestPromptFill } from '../spaces/canvas/promptFillBus'
import { TabletContextBar } from './TabletContextBar'
import { TabletItemMenu } from './TabletItemMenu'
import { usePromptDock } from './usePromptDock'
import { TabletPrompt } from './TabletPrompt'
import { TabletRail } from './TabletRail'
import { TabletTasks } from './TabletTasks'
import { TabletTopbar } from './TabletTopbar'
import { TabletOverlays, type TabletEditor } from './TabletOverlays'
import { applyTheme, nextTheme, readTheme } from './tabletTheme'
import { useBoardActions } from './useBoardActions'
import { useBoardFingerGestures } from './useBoardFingerGestures'
import { TabletClipboardMenu, type ClipboardMenuState } from './TabletClipboardMenu'
import { copySelected, hasClipboard, paste } from '../spaces/canvas/konva/clipboard'
import { runWithBoardLease } from '../spaces/canvas/konva/boardLeaseActions'
import { BoardHistoryContext, createBoardHistory, useBoardHistoryKeyboard, useBoardHistoryVersion } from './boardHistory'
import { importFilesToBoard } from './tabletImport'
import { fitCamera, isViewerItem, screenToWorld, zoomAt, type Point } from './boardGestures'
import { useTabletVisualViewport } from './useTabletVisualViewport'
import type { TabletBoardSession, TabletBoardState, TabletProject, TabletRuntime } from './runtime'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import type { InspectorAction } from './inspectorModel'
import { TabletMediaViewer } from './TabletMediaViewer'
import { TabletResizeEditor } from './TabletResizeEditor'
import { TabletResize } from './TabletResize'
import { downloadProjectSnapshot, type ProjectConflictSnapshot } from '../spaces/canvas/projectConflict'
import { ProjectConflictState } from '../spaces/canvas/ProjectConflictState'
import { AgentPanel } from '../spaces/canvas/agents/AgentPanel'
import { useAgentPanel } from '../spaces/canvas/agents/useAgentPanel'
import { tabletSystemMessage } from './tabletSystemMessage'

// Экран доски на планшете.
//
// Всё, что касается сохранения, владения доской и задач генерации, взято у
// компьютера как есть: один и тот же projectSync, один и тот же
// generationRegistry. Иначе «продолжить на другом устройстве» означало бы
// «продолжить почти так же», а это худший вид почти.
//
// Раскладка ландшафтная и всегда одна: панель сверху, полка слева, инспектор
// справа по выделению, док создания снизу. Холст не делится ни с чем
// постоянным — панели приходят по делу и уходят.

const SAVE_NOTE: Record<ReturnType<typeof getSaveStatus>, string> = {
  idle: 'saved',
  saving: 'saving…',
  saved: 'saved',
  error: 'NOT SAVING',
}

export type TabletBoardLoadErrorKind = 'auth' | 'network' | 'unknown'

export interface TabletBoardLoadFailure {
  kind: TabletBoardLoadErrorKind
  title: string
  detail: string
  retryLabel: string
}

/** Переводит технический отказ открытия в следующий понятный шаг. */
export function classifyTabletBoardLoadError(error: unknown): TabletBoardLoadFailure {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const metadata = error && typeof error === 'object' ? error as { status?: unknown; code?: unknown } : null
  const status = error instanceof ApiError
    ? error.status
    : typeof metadata?.status === 'number' ? metadata.status : undefined
  const code = error instanceof ApiError
    ? error.code
    : typeof metadata?.code === 'string' ? metadata.code : undefined
  const displayMessage = tabletSystemMessage(error, 'The server could not open the saved board. Try again.', code)
  const auth = status === 401 || status === 403
    || /AUTH|UNAUTHORIZED|FORBIDDEN|SESSION|LOGIN/u.test(code ?? '')
    || /требуется вход|сеанс входа|доступ отозван|нет прав|войдите|sign[- ]in required|login required|session expired|access revoked|no permission|permission denied/iu.test(message)
  if (auth) {
    return {
      kind: 'auth',
      title: 'Sign-in required',
      detail: 'The session expired or access to this board was revoked. Return to the board list, sign in again, and retry.',
      retryLabel: 'Retry after signing in',
    }
  }

  const network = isLocalServiceUnavailable(error)
    || (status !== undefined && (status === 408 || status === 429 || status >= 500))
    || /сеть|соедин|недоступ|таймаут|timeout|network|fetch|offline|временн|unavailable|connection|timed[- ]out/iu.test(message)
  if (network) {
    return {
      kind: 'network',
      title: 'Could not open board',
      detail: 'Check the connection to your computer and try again.',
      retryLabel: 'Retry',
    }
  }

  return {
    kind: 'unknown',
    title: 'Board did not load',
    detail: message.trim() ? displayMessage : 'The server could not open the saved board. Try again.',
    retryLabel: 'Retry',
  }
}

export function TabletBoard({
  projectId,
  boardName,
  onExit,
  onOpenProject,
  onRenamed,
  runtime,
  canEdit,
  canManage,
}: {
  projectId: string
  boardName: string
  onExit(): void
  onOpenProject(project: TabletProject): void
  onRenamed(name: string): void
  runtime: TabletRuntime
  canEdit: boolean
  canManage: boolean
}) {
  const storeRef = useRef<CanvasStore>()
  if (!storeRef.current) storeRef.current = new CanvasStore()
  const store = storeRef.current

  const [loadState, setLoadState] = useState<TabletBoardState>('loading')
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [conflict, setConflict] = useState<ProjectConflictSnapshot | null>(null)
  const [conflictRetrying, setConflictRetrying] = useState(false)
  const [handoff, setHandoff] = useState<BoardHolder | null>(null)
  const [returning, setReturning] = useState(false)
  const [multiSelect, setMultiSelect] = useState(false)
  const [menu, setMenu] = useState<{ itemId: string; at: Point } | null>(null)
  const [clipboardMenu, setClipboardMenu] = useState<ClipboardMenuState | null>(null)
  // ⚠️ Спрятанный интерфейс — состояние ВИДА, а не доски: возвращается
  // четырьмя пальцами и сам при уходе с доски. В снимок он не едет.
  const [chromeHidden, setChromeHidden] = useState(false)
  const [contextHidden, setContextHidden] = useState(false)
  const [showObjects, setShowObjects] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [editor, setEditor] = useState<TabletEditor>(null)
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [resizeId, setResizeId] = useState<string | null>(null)
  const [gestureResize, setGestureResize] = useState<{ itemId: string; at: Point } | null>(null)
  const [busyNote, setBusyNote] = useState<string | null>(null)
  const [selectionRect, setSelectionRect] = useState<DOMRect | null>(null)
  const handoffRef = useRef<BoardHolder | null>(null)
  const ownershipRef = useRef<BoardOwnershipSession | null>(null)
  const syncRef = useRef<TabletBoardSession | null>(null)
  const [boardSession, setBoardSession] = useState<TabletBoardSession | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const acceptRef = useRef('image/*,video/*,audio/*')
  const visualViewport = useTabletVisualViewport()

  useContentVersion(store)
  // ⚠️ Молчать о несохранённой доске нельзя. На компьютере об этом говорит
  // строка в шапке, а планшет молчал: прогон 26.08.2026 показал доску, где
  // сохранение отвечало отказом раз за разом, а человек видел обычный холст и
  // продолжал работать. Хуже потери — только потеря, о которой не сказали.
  const saveStatus = useSyncExternalStore(onSaveStatus, getSaveStatus, getSaveStatus)
  const tasks = useSyncExternalStore(subscribeGenerationTasks, getGenerationTasks, getGenerationTasks)

  // Чем подписывать архив экспорта. Правило общее с компьютером: имя доски
  // знает только этот уровень, а скачивание зовут из глубины (см. zipExport).
  useEffect(() => {
    setExportBoardName(boardName)
    return () => setExportBoardName('')
  }, [boardName])


  useEffect(() => {
    let cancelled = false
    let handle: TabletBoardSession | undefined
    let errorReported = false
    setLoadError(null)
    setLoadState('loading')
    setConflict(null)
    setConflictRetrying(false)
    setBoardSession(null)
    const reportState = (state: TabletBoardState) => {
      if (cancelled) return
      if (state === 'ready') setLoadError(null)
      setLoadState(state)
    }
    const reportConflict = (next: ProjectConflictSnapshot | null) => {
      if (cancelled) return
      setConflict(next)
    }
    const reportError = (error: unknown) => {
      if (cancelled) return
      errorReported = true
      setLoadError(error)
      setLoadState('error')
    }
    // У local runtime openBoard возвращает handle сразу, а local/paired
    // сначала ждут чтения project.json. Вызываем его синхронно: иначе
    // добавочная микрозадача оставляет историю без session во время первого
    // рендера после ready (Cmd/Ctrl-Z успевает попасть в это окно). Ошибку
    // синхронного конструктора сокета ловим отдельно, не откладывая вызов.
    let opened: Promise<TabletBoardSession>
    try {
      opened = Promise.resolve(runtime.openBoard(projectId, store, reportState, canEdit, reportError, reportConflict))
    } catch (error) {
      reportError(error)
      opened = Promise.reject(error)
    }
    void opened.then((created) => {
      if (cancelled) {
        void Promise.resolve(created.dispose()).catch(() => {})
        return
      }
      handle = created
      syncRef.current = created
      setBoardSession(created)
    }, (error) => {
      // Some runtimes report through the callback, others only reject their
      // opening promise. Cover both paths without emitting the same failure
      // twice.
      if (!errorReported) reportError(error)
    })
    return () => {
      cancelled = true
      syncRef.current = null
      if (handle) void Promise.resolve(handle.dispose()).catch(() => {})
    }
  }, [store, projectId, loadAttempt, runtime, canEdit])

  // Какая доска открыта и как до её файлов дойти — для вставки с другой доски
  // и отметки, откуда скопировано. ⚠️ Без этого вставка на планшете клала
  // объекты как есть: файлы чужой доски оставались чужими, и коллега без
  // доступа к ней видел битые картинки (хвост пункта 2.4). Правило то же, что
  // на компьютере (`CanvasSpace`), дорога — своя: сервер команды напрямую.
  useEffect(() => {
    setBoardUploadTarget(runtime.uploadProjectRef?.(projectId) ?? null, runtime.boardFileTransport?.() ?? null)
    return () => setBoardUploadTarget(null)
  }, [runtime, projectId])

  // Local tablet uses the same selection/lease controller as desktop. Attach it
  // only after the board session exists; loading a document must remain a pure
  // snapshot operation and must not make a stale local selection authoritative.
    useEffect(() => {
    if ((runtime.kind !== 'lan') || loadState !== 'ready') return
    const session = startBoardOwnership(projectId, (state) => {
      if (state.status === 'other') {
        if (handoffRef.current?.clientId === state.holder.clientId) return
        handoffRef.current = state.holder
        setHandoff(state.holder)
        const handle = syncRef.current
        if (handle) {
          void Promise.resolve(handle.dispose()).catch(() => {})
          syncRef.current = null
        }
      } else if (state.status === 'stale') {
        // Планшет спал дольше, чем сервер нас помнит: доску перечитываем, а не
        // дописываем по памяти.
        setLoadAttempt((attempt) => attempt + 1)
      } else if (state.status === 'mine' && handoffRef.current) {
        handoffRef.current = null
        setHandoff(null)
        setLoadAttempt((attempt) => attempt + 1)
      }
    })
    ownershipRef.current = session
    return () => {
      session.stop()
      ownershipRef.current = null
    }
  }, [loadState, projectId, runtime.kind])

  // ⚠️ Сетевая доска без живого канала работает дальше и копит правки
  // («тихое переподключение», 24.09.2026): канал рвался по расписанию каждые
  // 15 минут, и каждый раз планшет замирал. «Только просмотр» — про право.
  const live = canEdit && !handoff && (loadState === 'ready'
    || (false && (loadState === 'offline' || loadState === 'opening')))
  const viewing = (loadState === 'ready' || loadState === 'readonly' || loadState === 'offline'
    || loadState === 'opening' || loadState === 'conflict-saving' || loadState === 'conflict') && !handoff
  // Real runtimes provide an explicit project reference. Keep a conservative
  // compatibility fallback for old test/paired adapters that predate the
  // transport capability descriptor; it cannot enable any new operation.
  const projectRef = useMemo(() => runtime.uploadProjectRef?.(projectId)
    ?? { source: false ? 'local' as const : 'local' as const, id: projectId }, [projectId, runtime])
  const fallbackAgentCapability = useMemo(() => runtime.capabilities?.agents ?? {
    mode: 'none' as const,
    canControl: false,
    canLaunch: false,
    label: false ? 'Local' : 'Host',
    reason: 'Agents are not supported by this connection',
  }, [runtime.capabilities?.agents, runtime.kind])
  const [resolvedAgentCapability, setResolvedAgentCapability] = useState(fallbackAgentCapability)
  useEffect(() => {
    let active = true
    setResolvedAgentCapability(fallbackAgentCapability)
    if (!runtime.agentCapability) return () => { active = false }
    void runtime.agentCapability(projectId).then((capability) => {
      if (active) setResolvedAgentCapability(capability)
    }).catch(() => undefined)
    return () => { active = false }
  }, [fallbackAgentCapability, projectId, runtime])
  const agentCapability = resolvedAgentCapability
  // ⚠️ Панель автономных агентов временно отключена по решению пользователя
  // (задача в бэклоге: доделать панель агентов).
  const agentsEnabled = false
  // One board-level controller owns refresh + the task SSE. The dock composer
  // and review panel below receive this same instance; neither mounts a
  // second stream.
  const agentController = useAgentPanel(projectRef, store, agentsEnabled, agentCapability.client)
  const liveRef = useRef(live)
  liveRef.current = live
  const history = useMemo(() => createBoardHistory(store, runtime.kind,
    () => syncRef.current === boardSession ? boardSession : null, () => liveRef.current), [store, runtime.kind, boardSession])
  useBoardHistoryVersion(history)
  const historyActive = live && !editor && !viewerId && !detailsId && !gestureResize && !resizeId && !renaming && !tasksOpen && !menu && !clipboardMenu
  const gestures = useMemo(() => ({
    undo: () => history.undo(),
    redo: () => history.redo(),
    clipboard: (at: Point) => {
      const board = bodyRef.current?.querySelector<HTMLElement>('.tablet-board')?.getBoundingClientRect()
      const local = { x: at.x - (board?.left ?? 0), y: at.y - (board?.top ?? 0) }
      setClipboardMenu({ at: local, world: screenToWorld(store.getCamera(), local) })
    },
    // Интерфейс прячется и возвращается одним и тем же жестом: отдельного
    // выхода не нужно, иначе человек остался бы с голым холстом.
    chrome: () => { setMenu(null); setClipboardMenu(null); setChromeHidden((hidden) => !hidden) },
  }), [history, store])
  useBoardFingerGestures(gestures, live && !editor && !viewerId && !detailsId && !gestureResize && !resizeId && !renaming && !tasksOpen)
  useBoardHistoryKeyboard(history, historyActive)

  const openViewer = useCallback((itemId: string) => {
    const item = store.getItem(itemId)
    if (!item || (item.kind !== 'image' && item.kind !== 'video') || !item.src) return
    setViewerId(itemId)
  }, [store])

  const takeBoard = useCallback(async () => {
    setReturning(true)
    try {
      const state = await ownershipRef.current?.claim()
      if (state && state.status === 'other') return
      handoffRef.current = null
      setHandoff(null)
      setLoadAttempt((attempt) => attempt + 1)
    } finally {
      setReturning(false)
    }
  }, [])

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusyNote(`Loading ${files.length}…`)
    try {
      await importFilesToBoard(store, files, runtime, projectId)
    } catch (error) {
      setBusyNote(tabletSystemMessage(error, 'Could not load'))
      window.setTimeout(() => setBusyNote(null), 4000)
      return
    }
    setBusyNote(null)
  }, [store, runtime, projectId])

  const viewport = useCallback(() => {
    // При открытом инспекторе рабочая сцена сужается. Точные команды камеры
    // должны считать именно её, иначе «Показать всё» снова кладёт материал под
    // правую панель.
    const canvas = bodyRef.current?.querySelector<HTMLElement>('.tablet-board')
    return {
      w: canvas?.clientWidth ?? bodyRef.current?.clientWidth ?? window.innerWidth,
      h: canvas?.clientHeight ?? bodyRef.current?.clientHeight ?? window.innerHeight,
    }
  }, [])

  // Док сообщает раскладке свою высоту: от неё считаются потолок полки и место
  // пилюли масштаба. Высота живая — она меняется, когда открывают помощника,
  // параметры модели или когда клавиатура ужимает полку.
  const dockRef = useRef<HTMLDivElement>(null)
  const dockPlacement = usePromptDock(dockRef, bodyRef, visualViewport.keyboardOpen ? visualViewport.bottomInset : 0, live)
  useEffect(() => {
    const node = dockRef.current
    const host = bodyRef.current
    if (!node || !host) return
    let frame = 0
    let lastHeight = -1
    const apply = () => {
      frame = 0
      const height = Math.round(node.getBoundingClientRect().height)
      if (height <= 0 || height === lastHeight) return
      lastHeight = height
      host.style.setProperty('--tablet-dock-h', `${height}px`)
    }
    const measure = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(apply)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    window.addEventListener('canai-tablet-ui-scale', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('canai-tablet-ui-scale', measure)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [live])

  const actions = useBoardActions({ store, projectId, viewport, setEditor, setBusyNote, onUndo: history.undo })

  const runBoardAction = useCallback((action: InspectorAction, items: CanvasItem[]) => {
    const first = items[0]
    if (!first) return
    if (action === 'view') {
      openViewer(first.id)
      return
    }
    if (action === 'resize') {
      setResizeId(first.id)
      return
    }
    actions.run(action, items)
  }, [actions, openViewer])

  const selectedItems = useMemo(
    () => store.getRenderableSelectedItems(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, store.getContentVersion()],
  )

  const activeTasks = tasks.filter(
    (task) => task.target.kind === 'canvas'
      && task.target.projectId === projectId
      && (task.state === 'queued' || task.state === 'running'),
  ).length

  const retryLoad = () => {
    setLoadError(null)
    setLoadState('loading')
    setLoadAttempt((attempt) => attempt + 1)
  }
  const retryConflictRecovery = async () => {
    const session = syncRef.current
    if (!session?.retryConflictRecovery) return
    setConflictRetrying(true)
    try {
      const recovered = await session.retryConflictRecovery()
      setConflict(recovered)
    } catch (error) {
      setBusyNote(tabletSystemMessage(error, 'Could not save conflict copy'))
      window.setTimeout(() => setBusyNote(null), 4000)
    } finally {
      setConflictRetrying(false)
    }
  }
  const openConflictCopy = () => {
    const copy = conflict?.recoveryProject
    if (!copy) return
    onOpenProject({
      id: copy.id,
      name: copy.name,
      thumb: null,
      permissions: { canRead: true, canEdit, canManage },
    })
  }
  const loadFailure = classifyTabletBoardLoadError(loadError)

  return (
    <BoardHistoryContext.Provider value={history}>
    <div className={`tablet-screen ${chromeHidden ? 'chrome-hidden' : ''}`}
      onPointerDownCapture={(event) => {
        if (!(event.target instanceof Element)) return
        if (event.target.closest('.tablet-dock, .tablet-topbar, .tablet-rail')) {
          setContextHidden(true); setMenu(null)
        } else if (event.target.closest('.tablet-board')) setContextHidden(false)
      }}
      onKeyDown={(event) => { if (event.key === 'Escape' && chromeHidden) setChromeHidden(false) }}
    >
      <TabletTopbar
        state={{
          boardName,
          saveNote: false
            ? loadState === 'ready'
              ? 'synced'
              : loadState === 'opening'
                ? 'connecting'
                : live ? 'offline · edits pending' : 'view only'
            : SAVE_NOTE[saveStatus],
          selectionCount: selectedItems.length,
          exportCount: store.getItems().filter((item) => item.kind !== 'link').length,
          activeTasks,
          multiSelect,
          canUndo: history.canUndo(),
          canRedo: history.canRedo(),
          canEdit: live,
          canManage,
          localFeatures: runtime.kind === 'lan',
        }}
        actions={{
          onExit,
          onRename: () => { if (canManage) setRenaming(true) },
          onUndo: history.undo,
          onRedo: history.redo,
          onAdd: (kind) => {
            if (kind === 'text') {
              actions.addTextInView()
              return
            }
            acceptRef.current = kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : 'audio/*'
            // accept выставляем ДО открытия выбора: системный выбор читает его
            // в момент открытия, а не при следующей отрисовке.
            if (fileInputRef.current) fileInputRef.current.accept = acceptRef.current
            fileInputRef.current?.click()
          },
          onToggleSelect: () => setMultiSelect((on) => !on),
          onTasks: () => setTasksOpen(true),
          onExport: () => { void actions.exportBoard(boardName) },
          onExportSelected: () => { void actions.exportBoard(boardName, true) },
          onObjects: () => setShowObjects((open) => !open),
          onTheme: () => applyTheme(nextTheme(readTheme())),
          onHelp: () => setEditor({ kind: 'help' }),
          onSettings: () => setEditor({ kind: 'settings' }),
          onFitAll: () => store.setCamera(fitCamera(store.getItems(), viewport())),
          onZoomActual: () => {
            const size = viewport()
            store.setCamera(zoomAt(store.getCamera(), { x: size.w / 2, y: size.h / 2 }, 1))
          },
        }}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept={acceptRef.current}
        multiple
        hidden
        onChange={(event) => {
          void addFiles(event.target.files)
          event.target.value = ''
        }}
      />

      <div className="tablet-body" ref={bodyRef}>
        {loadState === 'loading' && <p className="tablet-state">Opening board…</p>}
        {loadState === 'error' && (
          <div className="tablet-state">
            <InlineNotice
              tone="error"
              title={loadFailure.title}
              detail={loadFailure.detail}
              action={{ label: loadFailure.retryLabel, onClick: retryLoad }}
              secondary={loadFailure.kind === 'auth' ? { label: 'Back to list', onClick: onExit } : undefined}
            />
            <p>An empty canvas will not overwrite the saved board.</p>
          </div>
        )}

        {(loadState === 'conflict-saving' || loadState === 'conflict') && (
          <div className="tablet-state">
            <ProjectConflictState
              phase={loadState === 'conflict-saving' ? 'saving' : 'conflict'}
              conflict={conflict}
              retrying={conflictRetrying}
              onOpenCopy={openConflictCopy}
              onUseServer={retryLoad}
              onRetry={() => void retryConflictRecovery()}
              onRepair={() => boardSession?.resumeInvalidSnapshot?.()}
              onDownload={() => conflict && downloadProjectSnapshot(conflict.local)}
            />
          </div>
        )}

        {handoff && (
          <div className="tablet-state">
            <p><strong>The board is currently open on device “{handoff.device}”</strong></p>
            <p>{boardHandoffDetail(handoff)}</p>
            <button type="button" className="ui-btn primary" disabled={returning} onClick={() => void takeBoard()}>
              {returning ? 'Restoring…' : 'Restore here'}
            </button>
          </div>
        )}

        {viewing && (
          <>
            <div className={live ? 'tablet-board-live' : 'tablet-board-readonly'}>
              <BoardCanvas
                store={store}
                upload={tabletMediaUploader(runtime, projectId)}
                readOnly={!live}
                multiSelect={multiSelect}
                showObjects={showObjects}
                chromeHidden={chromeHidden}
                onLongPress={(itemId, at) => { if (live) setMenu({ itemId, at }) }}
                onResizeGesture={(itemId, at) => { if (live) setGestureResize({ itemId, at }) }}
                onDoubleTap={(id) => {
                  const item = store.getItem(id)
                  if (item && mediaDoubleTapAction(item) === 'details') setDetailsId(id)
                  else openViewer(id)
                }}
                onBackgroundTap={() => { setMenu(null); setGestureResize(null) }}
                onSelectionRect={setSelectionRect}
                onGestureStart={() => { setContextHidden(true); setMenu(null); setGestureResize(null) }}
              />
              {gestureResize && live && store.getItem(gestureResize.itemId) && (
                <TabletResize
                  store={store}
                  itemId={gestureResize.itemId}
                  menuPoint={gestureResize.at}
                  onMenu={(itemId, at) => { setGestureResize(null); setMenu({ itemId, at }) }}
                  onClose={() => setGestureResize(null)}
                  onCancel={() => setGestureResize(null)}
                />
              )}
            </div>
            <AgentPanel
              projectRef={projectRef}
              store={store}
              enabled={agentsEnabled}
              controller={agentController}
              capability={agentCapability}
            />
            {live && <TabletRail
              store={store}
              onPickAsset={actions.useAssetAsReference}
              onOpenArchive={() => setEditor({ kind: 'archive' })}
            />}
            {live && !gestureResize && !contextHidden && !chromeHidden && !menu && !clipboardMenu && selectedItems.length > 0 && (
              <TabletContextBar
                onDetails={(id) => setDetailsId(id)}
                store={store}
                items={selectedItems}
                selectionRect={selectionRect}
                busyNote={busyNote}
                onAction={(action, items) => {
                  const item = items[0]
                  if (action === 'resize' && items.length === 1 && (item.kind === 'image' || item.kind === 'video')) {
                    void store.withSelection([item.id], () => setGestureResize({ itemId: item.id, at: { x: 20, y: 60 } }))
                      .catch(() => setBusyNote('Could not get resize access'))
                  } else runBoardAction(action, items)
                }}
              />
            )}
            {live && <div
              className={`tablet-dock ${visualViewport.keyboardOpen ? 'keyboard-open' : ''}`}
              ref={dockRef}
              style={{ bottom: `calc(var(--space-3) + ${visualViewport.keyboardOpen ? visualViewport.bottomInset : 0}px)`, ...dockPlacement.style }}
            >
              <div className="tablet-dock-content">
                <TabletPrompt
                  dragHandle={<button type="button" className="ui-btn quiet tablet-dock-handle" aria-label="Move prompt panel" title="Drag to move; double-tap to return it to the bottom" {...dockPlacement.drag} onDoubleClick={dockPlacement.reset}><span aria-hidden="true">•••</span></button>}
                  store={store}
                  projectId={projectId}
                  projectSource={false ? 'local' : 'local'}
                  ready
                  agentController={agentController}
                  agentCapability={agentCapability}
                  flushBoardBeforeCapture={true && boardSession?.flushAndWait
                    ? () => boardSession.flushAndWait!()
                    : undefined}
                  preparationAvailable={runtime.capabilities?.preparation.available === true}
                  keyboardOpen={visualViewport.keyboardOpen}
                  visibleHeight={visualViewport.visibleHeight}
                />
              </div>
            </div>}
            {!live && <div className="tablet-local-readonly-note">
              {loadState === 'opening'
                ? 'Connecting to board…'
                : loadState === 'offline'
                  ? 'Offline — board is view only'
                  : 'You have view-only access'}
            </div>}
          </>
        )}
      </div>

      {chromeHidden && (
        <p className="tablet-chrome-hint">Four-finger tap restores the interface</p>
      )}

      {live && !chromeHidden && clipboardMenu && (
        <TabletClipboardMenu
          store={store}
          state={clipboardMenu}
          canPaste={hasClipboard()}
          onCopy={() => copySelected(store)}
          onCut={() => {
            copySelected(store)
            const ids = [...store.getSelectedIds()]
            runWithBoardLease(store, ids, () => store.removeItems(ids))
          }}
          onPaste={(world) => paste(store, world, viewport())}
          onClose={() => setClipboardMenu(null)}
        />
      )}

      {live && !chromeHidden && menu && (
        <TabletItemMenu
          store={store}
          itemId={menu.itemId}
          at={menu.at}
          onAction={runBoardAction}
          onClose={() => setMenu(null)}
        />
      )}

      {saveStatus === 'error' && live && (
        <div className="tablet-toast">
          <InlineNotice
            tone="error"
            title="Board is not saving"
            detail="Edits remain only on this screen. Check the connection to your computer."
          />
        </div>
      )}

      {tasksOpen && <TabletTasks projectId={projectId} onClose={() => setTasksOpen(false)} />}
      {busyNote && selectedItems.length === 0 && <div className="tablet-toast"><InlineNotice tone="info" title={tabletSystemMessage(busyNote, 'Working…')} /></div>}

      {renaming && canManage && (
        <RenameDialog
          name={boardName}
          onClose={() => setRenaming(false)}
          onSave={async (next) => {
            setRenaming(false)
            if (!runtime.renameProject) return
            await runtime.renameProject(projectId, next)
            onRenamed(next)
          }}
        />
      )}

      <TabletOverlays
        editor={editor}
        store={store}
        projectId={projectId}
        boardName={boardName}
        runtime={runtime}
        onClose={() => setEditor(null)}
      />

      {detailsId && (() => {
        const item = store.getItem(detailsId)
        return item ? <TabletDialog title="Generation settings" onClose={() => setDetailsId(null)} actions={<>
          <button type="button" className="ui-btn" onClick={() => { setDetailsId(null); openViewer(item.id) }}>Open large</button>
          <button type="button" className="ui-btn primary" disabled={!live || !item.prompt} onClick={() => {
            requestPromptFill({ shapeId: item.id, prompt: item.prompt, modelId: item.modelId, referenceIds: item.referenceIds })
            setDetailsId(null)
          }}>To prompt</button>
        </>}>
          <p><strong>Model:</strong> {actions.modelNameOf(item) || item.modelId || 'Not saved'}</p>
          <p>Size: {item.naturalWidth ?? Math.round(item.w)} × {item.naturalHeight ?? Math.round(item.h)} · References: {item.referenceIds?.length ?? 0}</p>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text' }}>{item.prompt || 'Prompt not saved'}</p>
        </TabletDialog> : null
      })()}
      {viewerId && (() => {
        const item = store.getItem(viewerId)
        return isViewerItem(item) ? (
          <TabletMediaViewer item={item} store={live ? store : undefined} upload={live ? tabletMediaUploader(runtime, projectId) : undefined} onClose={() => setViewerId(null)} />
        ) : null
      })()}
      {resizeId && (
        <TabletResizeEditor store={store} itemId={resizeId} onClose={() => setResizeId(null)} />
      )}
    </div>
    </BoardHistoryContext.Provider>
  )
}

function RenameDialog({
  name,
  onClose,
  onSave,
}: {
  name: string
  onClose(): void
  onSave(next: string): Promise<void>
}) {
  const [value, setValue] = useState(name)
  const trimmed = value.trim()
  return (
    <TabletDialog
      title="Board name"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="ui-btn quiet" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="ui-btn primary"
            disabled={!trimmed || trimmed === name}
            onClick={() => void onSave(trimmed)}
          >
            Save
          </button>
        </>
      }
    >
      <input
        className="ui-field tablet-input-line"
        value={value}
        aria-label="Board name"
        autoFocus
        onChange={(event) => setValue(event.target.value)}
      />
    </TabletDialog>
  )
}

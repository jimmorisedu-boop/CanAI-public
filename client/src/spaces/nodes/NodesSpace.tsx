import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  addEdge,
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type OnConnectEnd,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, type MacroScope } from '../../api'
import type { CatalogDefaults, CatalogModel, ProjectSource } from '../../types'
import { IconBack, IconTrash, IconSave, IconDone } from '../../ui/icons'
import { InlineNotice } from '../../ui/InlineNotice'
import { nodeInputPorts, nodeOutputPorts } from './nodePortContracts'
import {
  beginNodePaletteDrag,
  nodeKindFromDrop,
  nodePositionFromDrop,
  NODE_PALETTE_MIME,
} from './nodePaletteDnd'
import { notifyMacrosChanged } from '../canvas/macrosBus'
import { GenNode } from './GenNode'
import { GraphDiagnosticsPanel } from './GraphDiagnosticsPanel'
import { GraphValidationStatus } from './GraphValidationStatus'
import {
  summarizeDiagnostics,
  validateGraph,
  type GraphDiagnostic,
} from './graphDiagnostics'
import { ModelsContext, useModels } from './modelsContext'
import type { MacroFinalize, MacroLeaveOptions } from './macroEditorLeave'
import { macroSaveLabel } from './macroPersistence'
import {
  findFreeNodePosition,
  placementScreenArea,
  visibleFlowViewportForPlacement,
} from './nodePlacement'
import { NodeActionsContext } from './nodeActions'
import { canConnect, NODE_META, PORT_COLORS, portType } from './ports'
import {
  connectionErrorAfterAttempt,
  connectionMismatchMessage,
  selfLoopMessage,
} from './connectionDiagnostics'
import { referenceLimitError } from './nodeModel'
import { useNodesGraph } from './useNodesGraph'
import type { CanaiNode, NodeKind } from './types'
import { showErrorToast } from '../canvas/toastBus'
import { NodePaletteButton } from './NodePaletteButton'
import { askConfirm } from '../../ui/confirmBus'
import { hits } from '../../ui/hotkeys'
import { useCompactLayout } from '../../ui/useCompactLayout'
import { NodesCompactToolbar } from './NodesCompactToolbar'
import { reactFlowNavigationProps, useNavigationMode } from '../../settings/navigationMode'
import { useT } from '../../i18n/context.js'


const nodeTypes = { gen: GenNode }
const NEW_NODE_SIZE = { width: 240, height: 150 }
const NEW_NODE_GAP = 48

// Магнит связей: в этом радиусе React Flow подхватывает порт, к которому тянут
// провод. Он берёт БЛИЖАЙШИЙ порт по расстоянию (getClosestHandle в
// @xyflow/system считает только его), а совместимость проверяет уже после —
// поэтому радиус выручает там, где связь бросают мимо портов вообще, и не
// спасает, когда рядом стоит чужой порт. 70px — примерно две с половиной
// строки порта (ROW_H = 26).
const CONNECTION_RADIUS = 70

// Группа появляется в меню заголовком перед своими кнопками. Звук вынесен
// отдельно (просьба пользователя 19.08.2026): там три разные вещи — модель,
// склейка видео со звуком и извлечение дорожки, и вперемешку с картинками
// они читались как случайный набор.
const ADD_BUTTONS: Array<{ kind: NodeKind; label: string; group?: string }> = [
  { kind: 'input', label: 'Input' },
  { kind: 'media', label: 'File' },
  { kind: 'note', label: 'Text' },
  { kind: 'text', label: 'LLM' },
  { kind: 'image', label: 'Image' },
  { kind: 'video', label: 'Video' },
  { kind: 'combine', label: 'Combine' },
  { kind: 'other', label: 'Other' },
  { kind: 'audio', label: 'Sound', group: 'Audio' },
  { kind: 'muxAudio', label: 'Video + sound', group: 'Audio' },
  { kind: 'extractAudio', label: 'Extract audio', group: 'Audio' },
  { kind: 'output', label: 'Output' },
]

// живой индикатор масштаба (снизу слева)
function ZoomIndicator() {
  const zoom = useStore((s) => s.transform[2])
  return <div className="zoom-indicator">{Math.round(zoom * 100)}%</div>
}

interface AddMenuState {
  screenX: number
  screenY: number
  flowPos: { x: number; y: number }
}

interface SlotEditorProps {
  slot: number
  macroId: string | null
  // область макроса: у помощника палитра урезана до текстовых нод
  scope?: MacroScope
  source?: ProjectSource
  theme: 'light' | 'dark'
  onClose: (options?: MacroLeaveOptions) => Promise<boolean>
  registerLeaveGuard: (finalize: MacroFinalize) => () => void
}

interface FlowProps extends SlotEditorProps {
  catalogError: string | null
  onRetryCatalog(): void
}

function Flow({
  slot,
  macroId,
  scope = 'canvas',
  source = 'local',
  theme,
  onClose,
  registerLeaveGuard,
  catalogError,
  onRetryCatalog,
}: FlowProps) {
  const translate = useT()
  const compact = useCompactLayout()
  const navigationMode = useNavigationMode()
  const flowNavigation = reactFlowNavigationProps(navigationMode)
  const graph = useNodesGraph(slot, macroId, scope, source)
  const { nodes, edges, setNodes, setEdges, onNodesChange, onEdgesChange, addNode } = graph
  const addButtons = ADD_BUTTONS
  const rf = useReactFlow()
  const [addMenu, setAddMenu] = useState<AddMenuState | null>(null)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const diagnostics = useMemo(() => validateGraph(nodes, edges, scope), [nodes, edges, scope])
  const diagnosticSummary = useMemo(
    () => summarizeDiagnostics(diagnostics),
    [diagnostics],
  )
  const hasDiagnostics = diagnostics.length > 0
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  useEffect(() => {
    if (!hasDiagnostics) setDiagnosticsOpen(false)
  }, [hasDiagnostics])

  useLayoutEffect(
    () => registerLeaveGuard(graph.finalize),
    [graph.finalize, registerLeaveGuard],
  )

  useEffect(() => {
    if (!graph.hasUnsavedChanges) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [graph.hasUnsavedChanges])

  // «‹ Канвас»: пустой граф освобождает слот, непустой — сохраняется
  async function close(): Promise<void> {
    const closed = await onClose()
    if (closed) {
      notifyMacrosChanged()
    }
  }

  async function clearAndClose(): Promise<void> {
    const ok = await askConfirm({
      title: 'Delete macro?',
      detail: `Graph with ${nodes.length}  nodes will disappear and the button ${slot + 1}  will be freed. It cannot be restored.`,
      confirmLabel: 'Delete macro',
      cancelLabel: 'Keep',
      danger: true,
    })
    if (!ok) return
    try {
      await graph.clearSlot()
      notifyMacrosChanged()
      await onClose({ discard: true })
    } catch {
      // Ошибка уже показана graph.saveError; редактор оставляем открытым.
    }
  }

  async function discardAndClose(): Promise<void> {
    const ok = await askConfirm({
      title: 'Exit without saving?',
      detail: 'Unsaved changes to this macro cannot be recovered.',
      confirmLabel: 'Exit and discard',
      cancelLabel: 'Stay',
      danger: true,
    })
    if (!ok) return
    await onClose({ discard: true })
  }

  // Все команды, включая удаление React Flow, проходят одну проверку фокуса.
  const graphRef = useRef(graph)
  graphRef.current = graph
  const rfRef = useRef(rf)
  rfRef.current = rf
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const t = e.target as HTMLElement | null
      const inField = Boolean(t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable))
      if (inField || document.querySelector('[aria-modal="true"]')) return
      if (e.key === 'Escape') {
        setAddMenu(null)
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const g = graphRef.current
        if (!g.loaded) return
        e.preventDefault()
        void rfRef.current.deleteElements({
          nodes: g.nodes.filter((node) => node.selected),
          edges: g.edges.filter((edge) => edge.selected),
        })
        return
      }
      // Ctrl+Space — меню добавления ноды в центре холста
      if (e.code === 'Space' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        const el = document.querySelector('.nodes-space')?.getBoundingClientRect()
        const sx = el ? el.x + el.width / 2 : 400
        const sy = el ? el.y + el.height / 2 : 300
        setAddMenu({ screenX: sx, screenY: sy, flowPos: rfRef.current.screenToFlowPosition({ x: sx, y: sy }) })
        return
      }
      if (!(e.ctrlKey || e.metaKey)) return
      const g = graphRef.current
      const k = e.key.toLowerCase()
      if (hits('nodes.save', e)) {
        e.preventDefault()
        void g.forceSave()
          .then(() => notifyMacrosChanged())
          .catch((cause) => showErrorToast(cause instanceof Error ? cause.message : 'Could not save macro'))
      } else if (k === 'a' || k === 'ф') {
        e.preventDefault()
        g.selectAll()
      } else if (k === 'd' || k === 'в') {
        e.preventDefault()
        g.duplicateSelected()
      } else if (k === 'c' || k === 'с') {
        e.preventDefault()
        g.copySelected()
      } else if (k === 'v' || k === 'м') {
        e.preventDefault()
        g.paste()
      } else if ((k === 'z' || k === 'я') && !e.shiftKey) {
        e.preventDefault()
        g.undo()
      } else if ((k === 'z' || k === 'я') && e.shiftKey) {
        e.preventDefault()
        g.redo()
      } else if (k === 'y' || k === 'н') {
        e.preventDefault()
        g.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // dev-ручка для живой проверки из превью (эмуляция drag-соединения там
  // ненадёжна), см. .claude/skills/verify. В проде не добавляется.
  // Идёт через НАСТОЯЩИЙ onConnect: раньше она вызывала addEdge напрямую и
  // проверок не видела вовсе — проверка связей через неё была фикцией.
  if (import.meta.env.DEV) {
    ;(window as unknown as { __canaiNodes?: unknown }).__canaiNodes = {
      connect: (source: string, sourceHandle: string, target: string, targetHandle: string) =>
        onConnectRef.current({ source, sourceHandle, target, targetHandle }),
      state: () => ({ nodes: nodes.length, edges: edges.length }),
    }
  }

  const onEdgeDoubleClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
    setEdges((eds) => eds.filter((e) => e.id !== edge.id))
  }, [setEdges])

  const nodeById = useCallback(
    (id: string): CanaiNode | undefined => nodes.find((n) => n.id === id),
    [nodes],
  )

  const models = useModels()
  const inputTypeOf = useCallback(
    (node: CanaiNode, handleId: string) => {
      if (node.data.kind === 'text' || node.data.kind === 'video' || node.data.kind === 'other') {
        const dynamic = nodeInputPorts({
          models,
          kind: node.data.kind,
          modelId: node.data.model,
          connectedHandles: edgesRef.current
            .filter((edge) => edge.target === node.id)
            .map((edge) => edge.targetHandle ?? ''),
        })
        return dynamic.find((port) => port.id === handleId)?.type ?? null
      }
      return portType(node.data.kind, 'inputs', handleId)
    },
    [models],
  )

  const outputTypeOf = useCallback(
    (node: CanaiNode, handleId: string) => {
      const dynamic = nodeOutputPorts({
        models,
        kind: node.data.kind,
        modelId: node.data.model,
      })
      return dynamic.find((port) => port.id === handleId)?.type
        ?? portType(node.data.kind, 'outputs', handleId)
    },
    [models],
  )

  const focusDiagnostic = useCallback(
    (diagnostic: GraphDiagnostic) => {
      if (!diagnostic.nodeId) return
      const nodeId = diagnostic.nodeId
      setNodes((items) =>
        items.map((item) => ({
          ...item,
          selected: item.id === nodeId,
        })),
      )
      void rf.fitView({
        nodes: [{ id: nodeId }],
        padding: 0.6,
        duration: 250,
      }).then(() => {
        window.requestAnimationFrame(() => {
          if (!diagnostic.fieldId) return
          document
            .querySelector<HTMLElement>(
              `.react-flow__node[data-id="${CSS.escape(nodeId)}"] textarea`,
            )
            ?.focus()
        })
      })
    },
    [rf, setNodes],
  )

  const referenceErrorForConnection = useCallback(
    (connection: Connection | Edge): string | null => {
      const target = nodeById(connection.target)
      if (!target) return null
      const counts = { image: 0, video: 0, audio: 0 }
      const addSource = (sourceId: string, sourceHandle: string | null | undefined) => {
        const source = nodeById(sourceId)
        if (!source) return
        const type = outputTypeOf(source, sourceHandle ?? '')
        if (type === 'image' || type === 'video' || type === 'audio') counts[type]++
      }

      for (const edge of edgesRef.current) {
        if (edge.target !== connection.target) continue
        if ('id' in connection && edge.id === connection.id) continue
        if (edge.targetHandle === connection.targetHandle) continue
        addSource(edge.source, edge.sourceHandle)
      }
      addSource(connection.source, connection.sourceHandle)

      return referenceLimitError(
        models,
        target.data.kind,
        target.data.model,
        counts,
      )
    },
    [models, nodeById, outputTypeOf],
  )

  // Почему связь нельзя создать — человеческим языком, или null если можно.
  // Один источник правды и для подсветки портов, и для сообщения: раньше
  // отказ в onConnect был молчаливым, и провод просто не цеплялся без причин.
  const connectionRefusal = useCallback(
    (c: Connection | Edge): string | null => {
      if (c.source === c.target) return selfLoopMessage()
      const src = nodeById(c.source)
      const tgt = nodeById(c.target)
      if (!src || !tgt) return null
      const sType = outputTypeOf(src, c.sourceHandle ?? '')
      const tType = inputTypeOf(tgt, c.targetHandle ?? '')
      if (!canConnect(sType, tType)) return connectionMismatchMessage(sType, tType)
      return referenceErrorForConnection(c)
    },
    [nodeById, inputTypeOf, outputTypeOf, referenceErrorForConnection],
  )

  // тип портов совпадает? иначе связь не создаём
  const isValid = useCallback(
    (c: Connection | Edge): boolean => connectionRefusal(c) === null,
    [connectionRefusal],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      // отказ обязан быть с объяснением: без него пользователь видит только
      // то, что провод «не липнет», и не понимает, чего от него хотят
      const refusal = connectionRefusal(c)
      if (refusal) {
        setConnectionError(refusal)
        return
      }
      const occupied = edgesRef.current.find(
        (edge) =>
          edge.target === c.target &&
          edge.targetHandle === c.targetHandle,
      )
      // «Этот вход уже подключён. Заменить связь?» больше не спрашиваем:
      // замена обратима обычным Ctrl+Z, а вопрос стоял на пути обычного
      // действия — протянуть провод в занятый вход и есть намерение заменить.
      void occupied
      setConnectionError((current) =>
        connectionErrorAfterAttempt(current, true),
      )
      const src = nodeById(c.source)
      const sType = src ? outputTypeOf(src, c.sourceHandle ?? '') : null
      const color = sType ? PORT_COLORS[sType] : '#888'
      setEdges((es) => {
        // один вход — одна связь: убираем прежнее ребро на этот же вход
        const cleaned = es.filter((e) => !(e.target === c.target && e.targetHandle === c.targetHandle))
        return addEdge({ ...c, style: { stroke: color, strokeWidth: 2 }, animated: true }, cleaned)
      })
    },
    [isValid, nodeById, setEdges],
  )

  // dev-ручка объявлена выше по файлу, поэтому обработчик отдаём ей через ref
  const onConnectRef = useRef(onConnect)
  onConnectRef.current = onConnect

  const onConnectEnd: OnConnectEnd = useCallback(
    (_event, state) => {
      if (state.isValid !== false || !state.fromNode || !state.toNode) return
      const refusal = connectionRefusal({
        source: state.fromNode.id,
        sourceHandle: state.fromHandle?.id ?? null,
        target: state.toNode.id,
        targetHandle: state.toHandle?.id ?? null,
      })
      if (refusal) setConnectionError(refusal)
    },
    [connectionRefusal],
  )

  function placeNode(kind: NodeKind, preferred: { x: number; y: number }): void {
    const bounds = document.querySelector('.nodes-flow')?.getBoundingClientRect()
    const toolbarBounds = document.querySelector('.nodes-toolbar')?.getBoundingClientRect()
    const placementArea = bounds
      ? placementScreenArea({
          flow: {
            x: bounds.left,
            y: bounds.top,
            width: bounds.width,
            height: bounds.height,
          },
          toolbar: toolbarBounds
            ? {
                x: toolbarBounds.left,
                y: toolbarBounds.top,
                width: toolbarBounds.width,
                height: toolbarBounds.height,
              }
            : null,
          baseGap: NEW_NODE_GAP,
          compactGap: 32,
          compactWidth: 900,
        })
      : null
    const flowViewport = bounds
      ? visibleFlowViewportForPlacement({
          center: rf.screenToFlowPosition({
            x: placementArea!.rect.x + placementArea!.rect.width / 2,
            y: placementArea!.rect.y + placementArea!.rect.height / 2,
          }),
          screenSize: {
            width: placementArea!.rect.width,
            height: placementArea!.rect.height,
          },
          currentZoom: rf.getZoom(),
          maxZoom: 1,
        })
      : {
          viewport: {
            x: preferred.x - 600,
            y: preferred.y - 350,
            width: 1200,
            height: 700,
          },
          zoom: 1,
        }
    if (bounds && rf.getZoom() > flowViewport.zoom) {
      const centerX = flowViewport.viewport.x + flowViewport.viewport.width / 2
      const centerY = flowViewport.viewport.y + flowViewport.viewport.height / 2
      void rf.setViewport(
        {
          x:
            placementArea!.rect.x -
            bounds.left +
            placementArea!.rect.width / 2 -
            centerX * flowViewport.zoom,
          y:
            placementArea!.rect.y -
            bounds.top +
            placementArea!.rect.height / 2 -
            centerY * flowViewport.zoom,
          zoom: flowViewport.zoom,
        },
        { duration: 180 },
      )
    }
    const position = findFreeNodePosition({
      preferred,
      existing: nodes.map((node) => ({
        x: node.position.x,
        y: node.position.y,
        width: node.measured?.width ?? node.width ?? NEW_NODE_SIZE.width,
        height: node.measured?.height ?? node.height ?? NEW_NODE_SIZE.height,
      })),
      viewport: flowViewport.viewport,
      nodeSize: NEW_NODE_SIZE,
      gap: placementArea?.gap ?? NEW_NODE_GAP,
    })
    addNode(kind, position)
  }

  function handleAdd(kind: NodeKind): void {
    const bounds = document.querySelector('.nodes-flow')?.getBoundingClientRect()
    const center = bounds
      ? rf.screenToFlowPosition({
          x: bounds.left + bounds.width / 2,
          y: bounds.top + bounds.height / 2,
        })
      : { x: 0, y: 0 }
    placeNode(kind, {
      x: center.x - NEW_NODE_SIZE.width / 2,
      y: center.y - NEW_NODE_SIZE.height / 2,
    })
  }

  // правый клик по холсту — меню добавления ноды прямо в точке курсора
  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault()
      const flowPos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      setAddMenu({ screenX: e.clientX, screenY: e.clientY, flowPos })
    },
    [rf],
  )

  function addFromMenu(kind: NodeKind): void {
    if (addMenu) placeNode(kind, addMenu.flowPos)
    setAddMenu(null)
  }

  const onPaletteDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(NODE_PALETTE_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onPaletteDrop = useCallback((event: React.DragEvent) => {
    const kind = nodeKindFromDrop(event.dataTransfer)
    if (!kind || !graph.loaded) return
    event.preventDefault()
    addNode(
      kind,
      nodePositionFromDrop(event, rf.screenToFlowPosition, NEW_NODE_SIZE),
    )
  }, [addNode, graph.loaded, rf])

  const addActions = addButtons.map((button) => (
    <NodePaletteButton
      key={button.kind}
      kind={button.kind}
      label={button.label}
      loaded={graph.loaded}
      onAdd={handleAdd}
    />
  ))
  const validationAction = nodes.length > 0 ? (
    <GraphValidationStatus
      summary={diagnosticSummary}
      diagnosticsOpen={diagnosticsOpen}
      onToggle={() => setDiagnosticsOpen((value) => !value)}
    />
  ) : null
  const saveAction = (
    <button
      className={`node-add-btn icon-btn node-save-btn ${
        graph.saveState === 'saved' ? 'just-saved' : ''
      } ${
        graph.saveState === 'save_failed' || graph.saveState === 'conflict' ? 'save-error' : ''
      }`}
      disabled={!graph.loaded || graph.isLoading || graph.saveState === 'saving'}
      onClick={() => {
        void graph.forceSave()
          .then(() => notifyMacrosChanged())
          .catch((cause) => showErrorToast(cause instanceof Error ? cause.message : 'Could not save macro'))
      }}
      title={
        graph.saveState === 'saving'
          ? translate('Saving…')
          : graph.saveState === 'saved'
            ? 'Saved ✓'
            : 'Save macro (Ctrl+S)'
      }
    >
      {graph.saveState === 'saved' ? <IconDone size={16} /> : <IconSave size={16} />}
    </button>
  )
  const deleteAction = graph.canClearSlot ? (
    <button
      className="node-add-btn icon-btn node-delete-btn"
      onClick={() => void clearAndClose()}
      title={translate('Delete macro and free slot')}
    >
      <IconTrash size={16} />
    </button>
  ) : null
  const toolbarAttention = (
    graph.saveState === 'save_failed' ||
    graph.saveState === 'conflict' ||
    diagnosticSummary.errors > 0
  )

  return (
    <NodeActionsContext.Provider
      value={{
        updateNode: graph.updateNode,
        scope,
      }}
    >
    <div className="nodes-space">
      {compact ? (
        <NodesCompactToolbar
          name={graph.name}
          placeholder={translate('Macro {0}', { 0: slot + 1 })}
          loaded={graph.loaded}
          attention={toolbarAttention}
          onBack={() => void close()}
          onNameChange={graph.setName}
          addActions={addActions}
          validationAction={validationAction}
          saveAction={saveAction}
          deleteAction={deleteAction}
        />
      ) : (
        <div className="nodes-toolbar">
          <button className="node-add-btn nodes-back icon-tab" onClick={() => void close()} title={translate('Back to canvas')}>
            <IconBack size={16} />  {translate('Canvas')}
          </button>
          <input
            className="macro-name-input"
            aria-label={translate('Macro name')}
            placeholder={translate('Macro {0}', { 0: slot + 1 })}
            value={graph.name}
            onChange={(e) => graph.setName(e.target.value)}
            title={translate('Macro name (slot button label)')}
            disabled={!graph.loaded}
          />
          <span className="nodes-toolbar-label">{translate('Add a node:')}</span>
          {/* Group 1: Вход, Файл, Текст */}
          {addButtons
            .filter((b) => ['input', 'media', 'note'].includes(b.kind))
            .map((b) => (
              <NodePaletteButton
                key={b.kind}
                kind={b.kind}
                label={b.label}
                loaded={graph.loaded}
                onAdd={handleAdd}
              />
            ))}
          {/* Разделитель 1-2 */}
          {addButtons.some((b) => ['input', 'media', 'note'].includes(b.kind)) &&
            addButtons.some((b) => ['text', 'image', 'video'].includes(b.kind)) && (
              <div className="nodes-toolbar-divider" />
            )}
          {/* Group 2: LLM, Ответ, Картинка, Видео */}
          {addButtons
            .filter((b) => ['text', 'wait', 'image', 'video'].includes(b.kind))
            .map((b) => (
              <NodePaletteButton
                key={b.kind}
                kind={b.kind}
                label={b.label}
                loaded={graph.loaded}
                onAdd={handleAdd}
              />
            ))}
          {/* Разделитель 2-3 */}
          {addButtons.some((b) => ['text', 'wait', 'image', 'video'].includes(b.kind)) &&
            addButtons.some((b) => ['combine', 'other', 'output'].includes(b.kind)) && (
              <div className="nodes-toolbar-divider" />
            )}
          {/* Group 3: Склейка, Другое, Выход */}
          {addButtons
            .filter((b) => ['combine', 'other', 'output'].includes(b.kind))
            .map((b) => (
              <NodePaletteButton
                key={b.kind}
                kind={b.kind}
                label={b.label}
                loaded={graph.loaded}
                onAdd={handleAdd}
              />
            ))}
          <div className="nodes-toolbar-spacer" />
          {validationAction}
          {saveAction}
          {deleteAction}
        </div>
      )}

      {(graph.loadError || graph.saveError) && (
        <InlineNotice
          className="nodes-inline-notice"
          tone="error"
          title={graph.saveState === 'conflict'
            ? translate('Macro version changed')
            : graph.loadError ? 'Macro did not load' : 'Macro was not saved'}
          detail={graph.saveError ?? graph.loadError ?? undefined}
          action={graph.saveState === 'conflict'
            ? {
                label: 'Load from server',
                disabled: graph.isLoading,
                onClick: () => {
                  void askConfirm({
                    title: 'Load the server version?',
                    detail: 'This macro changed in another window. Your unsaved changes will be discarded and cannot be recovered.',
                    confirmLabel: 'Load and discard mine',
                    cancelLabel: 'Keep mine',
                    danger: true,
                  }).then((ok) => {
                    if (ok) graph.reloadAfterConflict()
                  })
                },
              }
            : {
                label: 'Retry',
                disabled: graph.isLoading,
                onClick: graph.loadError ? graph.retryLoad : graph.retrySave,
              }}
          secondary={{ label: 'Exit without saving', onClick: () => void discardAndClose() }}
        />
      )}
      {catalogError && (
        <InlineNotice
          className="nodes-inline-notice"
          tone="error"
          title={translate('Model catalog did not load')}
          detail={catalogError}
          action={{ label: 'Retry', onClick: onRetryCatalog }}
        />
      )}

      {/* Мышь сохраняет прежнюю навигацию; для тачпада React Flow разделяет
          прокрутку двумя пальцами (пан) и pinch (зум). */}
      <div className="nodes-flow">
      <ReactFlow<CanaiNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onPaneContextMenu={onPaneContextMenu}
        onPaneClick={() => setAddMenu(null)}
        onDragOver={onPaletteDragOver}
        onDrop={onPaletteDrop}
        onEdgeDoubleClick={onEdgeDoubleClick}
        isValidConnection={isValid}
        connectionRadius={CONNECTION_RADIUS}
        nodesDraggable={graph.loaded}
        nodesConnectable={graph.loaded}
        elementsSelectable={graph.loaded}
        deleteKeyCode={null}
        fitView
        zoomOnScroll={flowNavigation.zoomOnScroll}
        zoomOnPinch={flowNavigation.zoomOnPinch}
        panOnScroll={flowNavigation.panOnScroll}
        zoomOnDoubleClick={false}
        panOnDrag={[1]}
        selectionOnDrag
        panActivationKeyCode="Space"
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ animated: true }}
      >
        <Background gap={20} color={theme === 'dark' ? 'rgba(255,255,255,0.12)' : '#d9d5cd'} />
        <Controls />
        <ZoomIndicator />
      </ReactFlow>
      </div>

      {hasDiagnostics && diagnosticsOpen && (
        <GraphDiagnosticsPanel diagnostics={diagnostics} onFocus={focusDiagnostic} />
      )}

      {connectionError && (
        <InlineNotice
          className="nodes-inline-notice connection-inline-notice"
          tone="warning"
          system
          title={translate('Connection was not created')}
          detail={connectionError}
          onDismiss={() => setConnectionError(null)}
        />
      )}

      {addMenu && (
        <div className="add-menu" style={{ left: addMenu.screenX, top: addMenu.screenY }}>
          <div className="add-menu-title">{translate('Add node')}</div>
          {addButtons.map((b, index) => {
            const NodeIcon = NODE_META[b.kind].icon
            // Заголовок рисуем один раз — на первой кнопке своей группы.
            const groupStart = b.group && b.group !== addButtons[index - 1]?.group
            return (
              <Fragment key={b.kind}>
                {groupStart && <div className="add-menu-group">{translate(b.group ?? '')}</div>}
                <button className="add-menu-item" onClick={() => addFromMenu(b.kind)}>
                  <NodeIcon size={16} />
                  <span className="mi-label">{translate(b.label)}</span>
                </button>
              </Fragment>
            )
          })}
        </div>
      )}

      {graph.loaded && nodes.length === 0 && (
        <div className="nodes-empty">
          <div className="nodes-empty-card">
            <h3>{`Build a macro for slot ${slot + 1}`}</h3>
            <p>

              {translate('Start with the')} <b>📥 {translate('Input')}</b>  {translate('— it receives what you select on the board. Finish with the')}
              <b>📤 Output</b>  {translate('— its result appears on the board. Wires are highlighted by type:')}{' '}
              <b style={{ color: PORT_COLORS.text }}>{translate('text')}</b>,{' '}
              <b style={{ color: PORT_COLORS.image }}>{translate('image')}</b>,{' '}
              <b style={{ color: PORT_COLORS.video }}>{translate('video')}</b>.
            </p>
            <p className="nodes-empty-example">
              Example: 📥 Input → 🖼 Image → 🎬 Video → 📤 Output
            </p>
            <p className="nodes-empty-hint">
              Drag a node from the top palette to where you want it. Right-click or Ctrl+Space opens an
              alternative menu. Delete removes it, Ctrl+D duplicates it, and Ctrl+Z undoes. The “Canvas” button takes you back to the board.
            </p>
          </div>
        </div>
      )}
    </div>
    </NodeActionsContext.Provider>
  )
}

// Редактор макроса одного слота (открывается кликом по слоту на канвасе).
export function NodesSpace({
  slot,
  macroId,
  scope,
  source,
  theme,
  onClose,
  registerLeaveGuard,
}: SlotEditorProps) {
  const [models, setModels] = useState<CatalogModel[]>([])
  const [modelDefaults, setModelDefaults] = useState<CatalogDefaults | undefined>()
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  useEffect(() => {
    const refresh = () => setCatalogAttempt(value => value + 1)
    window.addEventListener('canai:catalog-changed', refresh)
    return () => window.removeEventListener('canai:catalog-changed', refresh)
  }, [])

  useEffect(() => {
    let active = true
    setCatalogError(null)
    const request = api.models()
    request
      .then((r) => {
        if (!active) return
        setModels(r.models)
        const localResponse = r as { models: CatalogModel[]; defaults?: CatalogDefaults }
        setModelDefaults(localResponse.defaults)
        setCatalogError(null)
      })
      .catch((cause) => {
        if (!active) return
        setCatalogError(
          cause instanceof Error ? cause.message : 'Could not load model catalog',
        )
      })
    return () => {
      active = false
    }
  }, [catalogAttempt, source])

  return (
    <ModelsContext.Provider value={{ models, defaults: modelDefaults }}>
      <ReactFlowProvider>
        <Flow
          slot={slot}
          macroId={macroId}
          scope={scope}
          source={source}
          theme={theme}
          onClose={onClose}
          registerLeaveGuard={registerLeaveGuard}
          catalogError={catalogError}
          onRetryCatalog={() => setCatalogAttempt((attempt) => attempt + 1)}
        />
      </ReactFlowProvider>
    </ModelsContext.Provider>
  )
}

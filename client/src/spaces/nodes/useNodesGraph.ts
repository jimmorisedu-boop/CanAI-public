import { useCallback, useEffect, useRef, useState } from 'react'
import { useEdgesState, useNodesState, type XYPosition } from '@xyflow/react'
import { ApiError, api, type MacroScope } from '../../api'
import { askConfirm } from '../../ui/confirmBus'
import { notify } from '../canvas/toastBus'
import {
  cleanMacroGraph,
  macroLoadState,
  macroFingerprint,
  parseStoredMacroGraph,
  type MacroSaveState,
} from './macroPersistence'
import {
  canClearMacroSlot,
  createMacroSaveCoordinator,
  deleteConfirmedMacroAfterSave,
  MacroLoadGuard,
  saveMacroBeforeLeave,
  UnconfirmedMacroRevisionError,
} from './macroSaveCoordinator'
import type { CanaiEdge, CanaiNode, GenNodeData, GraphSnapshot, NodeKind } from './types'
import { newId } from '../../ui/ids'
import type { ProjectSource } from '../../types'

const SAVE_DEBOUNCE_MS = 800
// Стартовые размеры ноды: RF рисует по ним связи, пока ResizeObserver не
// измерит реальные (без этого рёбра появляются с задержкой). Задаются ТОЛЬКО
// как initialWidth/initialHeight — width/height в React Flow означают жёсткий
// размер, который измерение уже не перебьёт.
const NODE_START_W = 240
const NODE_START_H = 150
const OFFSET = 40 // сдвиг копий/вставки
const UNDO_LIMIT = 60

// буфер copy/paste — модульный, чтобы работал между инстансами пространства
let clipboard: GraphSnapshot | null = null

// Клонирует ноды (+рёбра между ними) с новыми id и сдвигом; сбрасывает статусы.
function cloneSelection(
  srcNodes: CanaiNode[],
  srcEdges: CanaiEdge[],
  offset: number,
): { nodes: CanaiNode[]; edges: CanaiEdge[] } {
  const idMap = new Map<string, string>()
  const nodes = srcNodes.map((n) => {
    const nid = newId()
    idMap.set(n.id, nid)
    return {
      ...n,
      id: nid,
      position: { x: n.position.x + offset, y: n.position.y + offset },
      selected: true,
      data: { ...n.data, status: 'idle' as const, result: n.data.kind === 'media' ? n.data.result : undefined, progress: undefined, error: undefined },
    }
  })
  const inside = new Set(srcNodes.map((n) => n.id))
  const edges = srcEdges
    .filter((e) => inside.has(e.source) && inside.has(e.target))
    .map((e) => ({ ...e, id: newId(), source: idMap.get(e.source)!, target: idMap.get(e.target)! }))
  return { nodes, edges }
}

// Состояние нодового графа одного СЛОТА: загрузка графа из макроса слота и
// автосохранение обратно (macros.json на сервере — портативность). Макрос
// создаётся при первом изменении; пустой граф при закрытии удаляет макрос.
export function useNodesGraph(
  slot: number,
  initialMacroId: string | null,
  scope: MacroScope = 'canvas',
  _source: ProjectSource = 'local',
) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanaiNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanaiEdge>([])
  const [loaded, setLoaded] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [saveState, setSaveState] = useState<MacroSaveState>('loading')
  const saveStateRef = useRef(saveState)
  saveStateRef.current = saveState
  const [macroId, setMacroId] = useState<string | null>(initialMacroId)
  const [name, setName] = useState(scope === 'assistant' ? `Chain ${slot + 1}` : `Macro ${slot + 1}`)
  const slotRef = useRef(slot)
  slotRef.current = slot
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const macroIdRef = useRef(macroId)
  macroIdRef.current = macroId
  const revisionRef = useRef<number | null>(null)
  // был ли у макроса сохранённый НЕПУСТОЙ граф: тогда выход с пустым графом
  // требует подтверждения — случайный Ctrl+A+Delete молча удалял макрос навсегда
  const hadContentRef = useRef(false)
  const savedFingerprintRef = useRef<string | null>(null)
  const inFlightSaveRef = useRef<Promise<void> | null>(null)
  const clearInProgressRef = useRef(false)
  const loadGuardRef = useRef(new MacroLoadGuard())
  const nameRef = useRef(name)
  nameRef.current = name
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  const saveCoordinatorRef = useRef<ReturnType<typeof createMacroSaveCoordinator> | null>(null)
  if (!saveCoordinatorRef.current) {
    saveCoordinatorRef.current = createMacroSaveCoordinator({
      getSnapshot: () => {
        const nameForSave = nameRef.current.trim() || (scopeRef.current === 'assistant' ? `Chain ${slotRef.current + 1}` : `Macro ${slotRef.current + 1}`)
        const graph = cleanMacroGraph(nodesRef.current, edgesRef.current)
        return {
          fingerprint: macroFingerprint(nameForSave, graph),
          name: nameForSave,
          graph,
          id: macroIdRef.current,
          revision: revisionRef.current,
        }
      },
      getSavedFingerprint: () => savedFingerprintRef.current,
      setSavedFingerprint: (fingerprint) => {
        savedFingerprintRef.current = fingerprint
      },
      save: async (snapshot) => {
        const saved = (await api.saveMacro(
          snapshot.name,
          snapshot.graph,
          snapshot.id ?? undefined,
          slotRef.current,
          snapshot.id ? snapshot.revision ?? undefined : undefined,
          scopeRef.current,
        )).macro
        macroIdRef.current = saved.id
        revisionRef.current = saved.revision
        // непустой граф лёг на сервер — с этого момента опустевший при выходе
        // граф означает потерю содержимого и требует подтверждения (важно и
        // для макроса, СОЗДАННОГО в этой же сессии, — load его не видел)
        if ((snapshot.graph.nodes?.length ?? 0) > 0) hadContentRef.current = true
        setMacroId(saved.id)
        setSaveError(null)
      },
      onState: setSaveState,
      onError: (err) => {
        const conflict = err instanceof ApiError && err.status === 409
        if (conflict) savedFingerprintRef.current = null
        setSaveState(conflict ? 'conflict' : 'save_failed')
        setSaveError(
          conflict
            ? 'This macro changed in another window. Your changes were not overwritten.'
            : err instanceof Error
              ? err.message
              : 'Could not save macro',
        )
      },
    })
  }

  // стеки отмены/повтора: снапшоты графа; restoring гасит запись во время undo/redo
  const undoStack = useRef<GraphSnapshot[]>([])
  const redoStack = useRef<GraphSnapshot[]>([])
  const restoringRef = useRef(false)
  // что именно вернули undo/redo: по ссылкам отличаем ЭХО восстановления от
  // правки пользователя, сделанной раньше, чем погас restoringRef (раньше такая
  // правка терялась из истории и следующий Ctrl+Z откатывал её молча)
  const restoredSnapshotRef = useRef<GraphSnapshot | null>(null)
  // ⚠️ Отметка «граф заменили программно» едет ВНУТРИ данных нод: только так
  // она приходит в ноду тем же рендером, что и возвращённые связи. Нода ведёт
  // правило «авто по референсу» на переходах, и возврат связи через Ctrl+Z
  // выглядел для неё как «человек подключил референс» — она писала 'auto'
  // поверх возвращённого выбора и сжигала «повтор» (проверка 01.10.2026).
  // Отметка в ref или в контексте приезжала бы раньше данных React Flow.
  const restoreSeq = useRef(0)
  const stampRestored = (snapshot: GraphSnapshot): GraphSnapshot => {
    const restoredAt = ++restoreSeq.current
    return {
      nodes: snapshot.nodes.map((node) => ({ ...node, data: { ...node.data, restoredAt } })),
      edges: snapshot.edges,
    }
  }

  // загрузка графа слота (если у слота уже есть макрос)
  useEffect(() => {
    const loadGuard = loadGuardRef.current
    const loadToken = loadGuard.begin()
    setLoaded(false)
    setIsLoading(true)
    setLoadError(null)
    setSaveError(null)
    setSaveState(macroLoadState('start'))
    revisionRef.current = null
    hadContentRef.current = false
    savedFingerprintRef.current = null
    void (async () => {
      try {
        if (initialMacroId) {
          const { macros } = await api.listMacros()
          if (!loadGuard.isCurrent(loadToken)) return
          const macro = macros.find((m) => m.id === initialMacroId)
          if (!macro) throw new Error('Macro not found')
          setName(macro.name)
          // Подтверждаем id+revision до разбора графа: если старый JSON
          // повреждён, редактор останется read-only, но сможет безопасно удалить
          // ровно эту серверную ревизию.
          revisionRef.current = macro.revision
          const g = parseStoredMacroGraph(macro.graph)
          // статусы прошлого прогона в файле бессмысленны — сбрасываем;
          // стартовые размеры нужны, чтобы связи рисовались сразу (до ResizeObserver)
          // Размеры из файла НЕ восстанавливаем: в React Flow width/height —
          // это ЖЁСТКИЙ размер, обёртка навсегда застревала на 240×150, пока
          // карточка росла до реальных ~280×295, и рамка выделения считалась по
          // устаревшей коробке. measured в старых файлах хранит тот же
          // испорченный замер, поэтому тоже выбрасываем — пусть RF измерит сам.
          const restoredAt = ++restoreSeq.current
          const normalizedNodes = g.nodes.map(({ width, height, measured, ...node }) => ({
            ...node,
            initialWidth: NODE_START_W,
            initialHeight: NODE_START_H,
            data: {
              ...node.data,
              status: 'idle' as const,
              progress: undefined,
              error: undefined,
              restoredAt,
            },
          }))
          const loadedEdges = g.edges
          setNodes(normalizedNodes)
          setEdges(loadedEdges)
          hadContentRef.current = normalizedNodes.length > 0
          savedFingerprintRef.current = macroFingerprint(
            macro.name,
            cleanMacroGraph(normalizedNodes, loadedEdges),
          )
        } else {
          const initialName = `Macro ${slot + 1}`
          savedFingerprintRef.current = macroFingerprint(
            initialName,
            cleanMacroGraph([], []),
          )
        }
      } catch (err) {
        if (!loadGuard.complete(loadToken)) return
        setIsLoading(false)
        setSaveState(macroLoadState('failed'))
        setLoadError(err instanceof Error ? err.message : 'Could not load macro')
        return
      }
      if (!loadGuard.complete(loadToken)) return
      setIsLoading(false)
      setSaveState(macroLoadState('loaded'))
      setLoaded(true)
    })()
    return () => loadGuard.invalidate()
  }, [initialMacroId, loadAttempt, setNodes, setEdges, _source])

  const persist = useCallback((): Promise<void> => {
    if (clearInProgressRef.current) return Promise.resolve()
    const task = saveCoordinatorRef.current!.requestSave()
    inFlightSaveRef.current = task
    void task.then(
      () => {
        if (inFlightSaveRef.current === task) inFlightSaveRef.current = null
      },
      () => {
        if (inFlightSaveRef.current === task) inFlightSaveRef.current = null
      },
    )
    return task
  }, [])

  // Отслеживание изменений (без автосохранения по таймеру!)
  useEffect(() => {
    if (!loaded) return
    const fingerprint = macroFingerprint(
      nameRef.current,
      cleanMacroGraph(nodesRef.current, edgesRef.current),
    )
    if (fingerprint === savedFingerprintRef.current) {
      if (saveStateRef.current !== 'saving') {
        setSaveState('saved')
      }
      return
    }
    setSaveState('dirty')
  }, [nodes, edges, name, loaded])

  // копим снапшоты графа для отмены (Ctrl+Z)
  useEffect(() => {
    if (!loaded) return
    if (restoringRef.current) {
      const restored = restoredSnapshotRef.current
      if (restored && restored.nodes === nodes && restored.edges === edges) {
        // это эхо применения undo/redo, а не действие пользователя
        restoringRef.current = false
        restoredSnapshotRef.current = null
        return
      }
      // правка пользователя пришла раньше эха — она обязана попасть в историю
      restoringRef.current = false
      restoredSnapshotRef.current = null
    }
    const timer = window.setTimeout(() => {
      undoStack.current.push({ nodes: nodesRef.current, edges: edgesRef.current })
      if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift()
      redoStack.current = [] // новое действие пользователя — ветка повтора сгорает
    }, 300)
    return () => window.clearTimeout(timer)
  }, [nodes, edges, loaded])

  const updateNode = useCallback(
    (id: string, patch: Partial<GenNodeData>) => {
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== id) return n
          const data = { ...n.data, ...patch }
          // новый результат — копим в историю и показываем его
          if (patch.result) {
            const hist = [...(n.data.outputHistory ?? []), patch.result]
            data.outputHistory = hist
            data.viewIndex = hist.length - 1
          }
          return { ...n, data }
        }),
      )
    },
    [setNodes],
  )

  const addNode = useCallback(
    (kind: NodeKind, position: XYPosition) => {
      const node: CanaiNode = {
        id: newId(),
        type: 'gen',
        position,
        initialWidth: NODE_START_W,
        initialHeight: NODE_START_H,
        data: { kind, prompt: '', status: 'idle' },
      }
      setNodes((ns) => [...ns, node])
    },
    [setNodes],
  )

  // запуск из редактора удалён по решению пользователя (макросы запускаются
  // с канваса) — вместе с ним ушла и вся обвязка run/runOne/cancel

  // вставить клон выделения (общее для дублирования и paste)
  function insertClone(src: { nodes: CanaiNode[]; edges: CanaiEdge[] }): void {
    if (!src.nodes.length) return
    const clone = cloneSelection(src.nodes, src.edges, OFFSET)
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...clone.nodes])
    setEdges((es) => [...es, ...clone.edges])
  }

  const duplicateSelected = useCallback(() => {
    const sel = nodesRef.current.filter((n) => n.selected)
    insertClone({ nodes: sel, edges: edgesRef.current })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNodes, setEdges])

  const copySelected = useCallback(() => {
    const sel = nodesRef.current.filter((n) => n.selected)
    if (!sel.length) return
    const ids = new Set(sel.map((n) => n.id))
    clipboard = { nodes: sel, edges: edgesRef.current.filter((e) => ids.has(e.source) && ids.has(e.target)) }
  }, [])

  const paste = useCallback(() => {
    if (clipboard) insertClone(clipboard)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNodes, setEdges])

  // У редактора макросов история СВОЯ, отдельная от холста. Молчаливый Ctrl+Z
  // не давал понять даже того, какая из двух сработала, — теперь шаг называется
  // (тот же replaceKey, что у холста: два ответа на один вопрос не нужны).
  const undo = useCallback(() => {
    if (undoStack.current.length < 2) {
      notify({ kind: 'info', message: 'Nothing left to undo', replaceKey: 'history' })
      return
    }
    const current = undoStack.current.pop()! // текущее состояние → в повтор
    redoStack.current.push(current)
    const prev = stampRestored(undoStack.current[undoStack.current.length - 1])
    undoStack.current[undoStack.current.length - 1] = prev
    restoringRef.current = true
    restoredSnapshotRef.current = prev
    setNodes(prev.nodes)
    setEdges(prev.edges)
    // Молчим об удачной отмене — граф на экране уже всё сказал.
  }, [setNodes, setEdges])

  const redo = useCallback(() => {
    const popped = redoStack.current.pop()
    if (!popped) {
      notify({ kind: 'info', message: 'Nothing left to redo', replaceKey: 'history' })
      return
    }
    const next = stampRestored(popped)
    undoStack.current.push(next)
    restoringRef.current = true
    restoredSnapshotRef.current = next
    setNodes(next.nodes)
    setEdges(next.edges)
  }, [setNodes, setEdges])

  // выход из редактора: пустой граф освобождает слот, непустой — проверяем изменения
  const finalize = useCallback(async (): Promise<void> => {
    if (!loaded || loadError) throw new Error(loadError ?? 'Macro is still loading')

    if (saveStateRef.current === 'conflict') {
      throw new Error(saveError ?? 'Macro version conflict')
    }

    // граф опустел у макроса, в котором раньше было содержимое (например,
    // случайный Ctrl+A + Delete) — без подтверждения не удаляем и не
    // сохраняем пустоту: «Отмена» оставляет прежнюю серверную версию
    if (nodesRef.current.length === 0 && hadContentRef.current && macroIdRef.current) {
      const confirmed = await askConfirm({
        title: `Delete macro “${nameRef.current}”?`,
        detail: 'The graph is empty. If this was accidental, “Keep as is” restores the previous server version.',
        confirmLabel: 'Delete permanently',
        cancelLabel: 'Keep as is',
        danger: true,
      })
      if (!confirmed) return
    }

    await saveMacroBeforeLeave({
      state: saveStateRef.current,
      persist,
      currentSave: inFlightSaveRef.current,
    })

    if (nodesRef.current.length === 0) {
      if (macroIdRef.current && revisionRef.current != null) {
        try {
          await api.deleteMacro(macroIdRef.current, revisionRef.current)
        } catch (err) {
          const conflict = err instanceof ApiError && err.status === 409
          setSaveState(conflict ? 'conflict' : 'save_failed')
          setSaveError(
            conflict
              ? 'This macro changed in another window. The empty macro was not deleted.'
              : err instanceof Error
                ? err.message
                : 'Could not free slot',
          )
          throw err
        }
      }
      return
    }
  }, [loaded, loadError, persist, saveError])

  // очистить слот: удалить макрос целиком
  const clearSlot = useCallback(async (): Promise<void> => {
    const expectedMacroId = macroIdRef.current
    if (
      expectedMacroId &&
      !canClearMacroSlot({
        macroId: expectedMacroId,
        revision: revisionRef.current,
        loaded,
        isLoading,
        loadError,
      })
    ) {
      throw new UnconfirmedMacroRevisionError()
    }
    clearInProgressRef.current = true
    try {
      try {
        await deleteConfirmedMacroAfterSave({
          currentSave: inFlightSaveRef.current,
          expectedMacroId,
          getConfirmedMacro: () =>
            macroIdRef.current && revisionRef.current != null
              ? { id: macroIdRef.current, revision: revisionRef.current }
              : null,
          deleteMacro: async (id, revision) => {
            await api.deleteMacro(id, revision)
          },
        })
      } catch (err) {
        if (err instanceof UnconfirmedMacroRevisionError) throw err
        if (!(err instanceof ApiError && err.status === 404)) {
          const conflict = err instanceof ApiError && err.status === 409
          setSaveState(conflict ? 'conflict' : 'save_failed')
          setSaveError(
            conflict
              ? 'This macro changed in another window. The slot was not cleared.'
              : err instanceof Error
                ? err.message
                : 'Could not clear slot',
          )
          throw err
        }
      }
      macroIdRef.current = null
      revisionRef.current = null
      savedFingerprintRef.current = macroFingerprint(
        `Macro ${slot + 1}`,
        cleanMacroGraph([], []),
      )
      setSaveError(null)
      setSaveState('saved')
      setMacroId(null)
      setNodes([])
      setEdges([])
    } finally {
      clearInProgressRef.current = false
    }
  }, [slot, setNodes, setEdges, loaded, isLoading, loadError])

  const selectAll = useCallback(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: true })))
    setEdges((eds) => eds.map((e) => ({ ...e, selected: true })))
  }, [setNodes, setEdges])

  return {
    nodes,
    edges,
    setNodes,
    setEdges,
    onNodesChange,
    onEdgesChange,
    addNode,
    duplicateSelected,
    copySelected,
    paste,
    selectAll,
    undo,
    redo,
    loaded,
    isLoading,
    loadError,
    saveError,
    saveState,
    canClearSlot: canClearMacroSlot({
      macroId,
      revision: revisionRef.current,
      loaded,
      isLoading,
      loadError,
    }),
    hasUnsavedChanges:
      saveState === 'dirty' ||
      saveState === 'saving' ||
      saveState === 'save_failed' ||
      saveState === 'conflict',
    forceSave: async (): Promise<void> => {
      if (!loaded || isLoading) return
      // Ctrl+S с опустевшим графом молча перезаписывал бы прежнюю версию
      // макроса пустотой — тогда обещание диалога при выходе («Отмена»
      // сохранит прежнюю версию) становилось бы ложью
      if (nodesRef.current.length === 0 && hadContentRef.current && macroIdRef.current) {
        const confirmed = await askConfirm({
          title: 'Save the empty graph?',
          detail: `Previous macro version “${nameRef.current}” will be overwritten with an empty graph. “Discard” leaves it on the server; Ctrl+Z can restore the graph.`,
          confirmLabel: 'Save empty',
          cancelLabel: 'Discard',
          danger: true,
        })
        if (!confirmed) return
      }
      await persist()
    },
    retryLoad: () => {
      if (!loadGuardRef.current.canRetry(Boolean(loadError))) return
      loadGuardRef.current.invalidate()
      setLoaded(false)
      setIsLoading(true)
      setSaveState(macroLoadState('retry'))
      setLoadAttempt((value) => value + 1)
    },
    retrySave: () => {
      if (!loaded || isLoading) return
      void persist().catch(() => {})
    },
    reloadAfterConflict: () => {
      if (!loaded || isLoading) return
      loadGuardRef.current.invalidate(() => {
        setSaveError(null)
        setLoadError(null)
      })
      setLoadAttempt((value) => value + 1)
    },
    macroId,
    name,
    setName,
    finalize,
    clearSlot,
    updateNode,
  }
}

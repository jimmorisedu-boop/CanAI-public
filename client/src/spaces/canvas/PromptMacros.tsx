import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Macro } from '../../api'
import {
  bindMacroRunToBoard,
  dismissUnusedSlots,
  isMacroRunFinished,
  macroRunSummary,
  planMacroRun,
  startMacroRun,
  trackMacroJobs,
  watchMacroRun,
} from './macroRunClient'
import { resolveMacroInputs, type MacroInputRunSnapshot } from '../nodes/macroContextPreflight'
import { macroRunnable } from '../nodes/macroPersistence'
import type { GraphSnapshot } from '../nodes/types'
import type { CatalogModel } from '../../types'
import type { ProjectSource } from '../../types'
import { askConfirm } from '../../ui/confirmBus'
import { estimateMacroCost, macroCostContext } from './macroEstimate'
import type { CanvasStore } from './konva/canvasStore'
import type { SelectionRef } from './konva/selection'
import { useSelectionRefs } from './konva/useStore'
import { requestMacroEdit } from './macroEditBus'
import { onMacrosChanged } from './macrosBus'
import { showErrorToast } from './toastBus'
import { startAfterMacroPreflight } from './macroLaunchPreflight'
import { createMacroLaunchRegistry } from './macroLaunches'
import { beginMacroRun, endMacroRun, updateMacroRun } from './macroRuns'
import { MacroLibrary } from './MacroLibrary'
import { pluralWithCount } from '../../ui/plural'
import { deliverMacroResult, parkedMacroResults, registerMacroDeliverySink } from './macroDeliveries'
import { macroShortLabel } from './macroShortLabel'
import { planMacroSeedBatches } from './macroRunInputs'
import { toMacroSeedRefs } from './macroSeedRefs'
import { macroCompletionStatus, type MacroStatusKind } from './macroStatus'
import { notify } from './notifications'
import { newId } from '../../ui/ids'
import { useMacroClipboard } from './useMacroClipboard'
import type { LibraryNotice } from './useMacroLibraryActions'

// Макросы прямо в промпт-баре (иконочный ряд, в стиле переключателя типа):
// показываем только занятые слоты как иконки.
// Клик по макросу — выполнить на текущем выделении (по работающему — «Стоп»),
// правый клик — редактировать.
export function PromptMacros({
  store,
  models = [],
  confirmCostAboveUsd = 1,
  falConfigured = false,
  generationAvailable = false,
  projectId,
  projectSource = 'local',
}: {
  store: CanvasStore
  models?: CatalogModel[]
  confirmCostAboveUsd?: number
  falConfigured?: boolean
  generationAvailable?: boolean
  projectId?: string
  projectSource?: ProjectSource
}) {
  const [macros, setMacros] = useState<Macro[]>([])
  const [runningCount, setRunningCount] = useState<Record<string, number>>({})
  const [libraryOpen, setLibraryOpen] = useState(false)
  // Итог вставки из буфера, с которым открывается окно макросов: что при
  // переносе пришлось заменить, человек обязан успеть прочесть.
  const [libraryNotice, setLibraryNotice] = useState<LibraryNotice | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const refs = useSelectionRefs(store)
  // Отмена запрашивается только отдельной кнопкой Stop после подтверждения и
  // живёт НА ЗАПУСК: серия кликов = параллельные прогоны (см. macroLaunches.ts)
  const launches = useRef(createMacroLaunchRegistry())
  const recoveredRuns = useRef(new Set<string>())
  const localSource: ProjectSource = 'local'

  const reload = useCallback(() => {
    api.listMacros()
      .then((result) => setMacros(result.macros.filter((m) => m.scope !== 'assistant')))
      .catch((cause) => showErrorToast(cause instanceof Error ? cause.message : 'Failed to load macros'))
  }, [])

  useEffect(() => {
    reload()
    return onMacrosChanged(reload)
  }, [reload])

  const openEditor = (macro: Macro) => {
    requestMacroEdit({ slot: macro.slot ?? 0, macroId: macro.id, source: 'local' })
  }

  // Пока доска открыта — принимаем результаты макросов, в том числе те, что
  // накопились, пока её не было на экране. Регистрация здесь, а не в самом
  // прогоне, потому что прогон принадлежит ЗАПУСКУ, а приём — ДОСКЕ: макрос
  // может доделывать своё, когда открыта уже совсем другая.
  useEffect(() => {
    if (!projectId) return
    const waiting = parkedMacroResults(projectId)
    const stop = registerMacroDeliverySink(projectId, ({ result, label, jobId }) => {
      // resolveJob сам положит рядом, если болванки уже нет (её и не будет:
      // болванки не переживают уход с доски — они transient).
      if (jobId) void store.resolveJob(jobId, result, label, { prompt: `Macro: ${label}` })
      else void store.placeResult(result, label)
    })
    if (waiting > 0) {
      notify({
        kind: 'success',
        message: `Macro finished while the board was closed: ${pluralWithCount(waiting, ["result", "results", "results"])} on canvas`,
      })
    }
    return stop
  }, [projectId, store])

  // Прогоны живут на локальном сервере и восстанавливаются при повторном входе.
  useEffect(() => {
    if (!projectId) return
    let disposed = false
    void api.listMacroRuns(projectId).then(({ runs }) => {
      for (const initial of runs) {
        if (disposed || recoveredRuns.current.has(initial.id)) continue
        recoveredRuns.current.add(initial.id)
        const bound = new Set<string>()
        const accept = (state: typeof initial) => {
          const fresh = bindMacroRunToBoard(state, store, bound, localSource)
          trackMacroJobs(fresh, projectId)
          if (isMacroRunFinished(state)) dismissUnusedSlots(state, store, localSource)
        }
        accept(initial)
        if (!isMacroRunFinished(initial)) {
          void watchMacroRun(initial.id, projectId, { isStopped: () => disposed, onState: accept }, localSource)
        }
      }
    }).catch(() => {})
    return () => { disposed = true }
  }, [projectId, store])

  // Ctrl+C / Ctrl+V макроса над рядом кнопок — useMacroClipboard: в буфере тот
  // же файл обмена, что «Сохранить в файл», и вставка идёт тем же путём, что
  // «Из файла». Какой макрос под курсором, хук спрашивает у страницы по
  // `data-macro-id` кнопки — памяти о наведении здесь нет, и залипать нечему.
  const showPasteNotes = useCallback((notice: LibraryNotice) => {
    setLibraryNotice(notice)
    setLibraryOpen(true)
  }, [])
  useMacroClipboard({ rowRef, macros, models, projectSource: localSource, onNotes: showPasteNotes })

  const occupied = macros.filter((m) => m.slot != null).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))

  const selectionHint = refs.length > 0 ? `highlighted: ${refs.length}` : "no selection"

  // Исход прогона — тост: это «свершившийся факт», а для него в продукте один
  // канал (DESIGN.md). Прогресс сюда больше не идёт: его показывает центр задач
  // в шапке, причём для КАЖДОГО прогона, а не только для последнего (F-09).
  // Прежняя строка под рядом слотов показывала ровно один статус и потому
  // теряла все остальные — теперь она не нужна.
  const publishStatus = useCallback(
    (_macroId: string, kind: MacroStatusKind, message: string) => {
      if (kind === 'progress') return
      notify({
        kind: kind === 'success' ? 'success' : kind === 'error' ? 'error' : 'info',
        message,
      })
    },
    [],
  )

  const clearStatusForAction = useCallback((_macroId: string) => {}, [])


  async function runMacro(macro: Macro): Promise<void> {
    clearStatusForAction(macro.id)
    const storedGraph = macro.graph as Partial<GraphSnapshot>
    if (!storedGraph?.nodes?.length) {
      publishStatus(macro.id, 'error', `${macro.name}: empty macro - right click to configure`)
      return
    }
    const graph: GraphSnapshot = {
      nodes: storedGraph.nodes,
      edges: storedGraph.edges ?? [],
    }
    const needsGeneration = graph.nodes.some((node) =>
      ['text', 'image', 'video', 'other'].includes(node.data.kind),
    )
    if (needsGeneration && !generationAvailable) {
      publishStatus(macro.id, 'error', `${macro.name}: generation not available - add a fal.ai key in Settings`)
      return
    }
    const seedPlan = planMacroSeedBatches(graph, refs)

    // Тот же порог, что у «Сгенерировать» на канвасе, и на КАЖДЫЙ прогон.
    // Раньше цену показывали только на первом запуске серии, и второй-десятый
    // клик списывались молча — порог «подтверждать дороже $N» переставал
    // что-либо значить именно там, где расходы растут быстрее всего.
    // Дешёвые прогоны не спрашивают вообще: их видно и можно снять в центре задач.
    if (falConfigured) {
      const runCount = Math.max(1, seedPlan.batches.length)
      const { perRun, total, unknownCount: unknownCost } = estimateMacroCost(
        graph,
        models,
        runCount,
        macroCostContext(refs),
      )
      if ((perRun > 0 && total >= confirmCostAboveUsd) || unknownCost > 0) {
        const rows: Array<[string, string]> = [["Macro", macro.name]]
        if (runCount > 1) rows.push(["Runs for selection", String(runCount)])
        const running = launches.current.activeCount(macro.id)
        if (running > 0) rows.push(["Runs already in progress", String(running)])
        const ok = await askConfirm({
          title: total > 0 ? `Run for ~$${total.toFixed(2)}?` : "Run a macro?",
          detail: unknownCost > 0
            ? "For some nodes the price is unknown - the result may be higher."
            : undefined,
          rows,
          confirmLabel: total > 0 ? `Run for ~$${total.toFixed(2)}` : "Run",
        })
        if (!ok) {
          publishStatus(macro.id, 'stopped', `${macro.name}: run cancelled`)
          return
        }
      }
    }

    const inputResolution = resolveMacroInputs(graph, {
      refBatches: seedPlan.batches,
      getAsset: store.getAsset,
    })
    // токен этого прогона: выдаётся ровно когда preflight разрешил старт
    let launchToken = 0
    const preflight = startAfterMacroPreflight(
      graph,
      inputResolution.runs,
      () => {
        launchToken = launches.current.begin(macro.id)
        // прогон становится видимым в центре задач в шапке: остановить можно
        // и точечно (эту строку), и всё сразу — кнопкой в закрытом виде
        beginMacroRun({
          token: launchToken,
          macroId: macro.id,
          macroName: macro.name,
          stop: () => launches.current.cancel(launchToken),
        })
        setRunningCount((prev) => ({ ...prev, [macro.id]: (prev[macro.id] ?? 0) + 1 }))
        publishStatus(macro.id, 'progress', `${macro.name}: starting…`)
      },
    )
    if (!preflight.started) {
      publishStatus(macro.id, 'error', `${macro.name}: ${preflight.message}`)
      return
    }

    let allPendingSlots: string[] = []
    let totalPlaced = 0
    // Прогоны живут на сервере: чтобы «Стоп» действительно останавливал, надо
    // сказать об этом ему, а не только погасить ожидание во вкладке.
    const serverRunIds: string[] = []

    try {
      const edges = graph.edges ?? []
      const hasInputNode = graph.nodes.some((n) => n.data.kind === 'input')

      // Динамические Входы получают только совместимые типы. Несколько Входов,
      // ref2/ref3 или одновременные image+video handles идут одним общим запуском.
      const { isMultiInput } = seedPlan
      const runCount = seedPlan.batches.length

      // Сколько мест на доске займёт один прогон, знает сервер: правило «чей
      // результат уезжает на холст» живёт в графе, и второй его копии в
      // браузере быть не должно.
      const deliveringNodes = await planMacroRun(macro.id, localSource)
      const expectedCount = Math.max(1, deliveringNodes.length)

      // Подготавливаем запуски
      const runs: Array<{
        requestId: string
        seedRefs: SelectionRef[]
        inputSnapshot: MacroInputRunSnapshot
        pendingSlots: string[]
      }> = []

      const hasVideoNode = graph.nodes.some((n) => n.data.kind === 'video')

      for (let k = 0; k < runCount; k++) {
        const runSeedRefs = seedPlan.batches[k]
        const requestId = newId()
        const inputSnapshot = inputResolution.runs[k]!
        const seedRefs = hasInputNode
          ? [...inputSnapshot.refs]
          : await toMacroSeedRefs(runSeedRefs, false)
        const runMediaRefs = runSeedRefs.filter((ref) => ref.kind !== 'text')
        const runMediaRef = isMultiInput ? null : runMediaRefs[0]

        runs.push({
          requestId,
          seedRefs: runSeedRefs,
          inputSnapshot,
          pendingSlots: [],
        })
      }


      for (let k = 0; k < runs.length; k++) {
        const run = runs[k]!
        const runSeedRefs = run.seedRefs
        const runMediaRefs = runSeedRefs.filter((ref) => ref.kind !== 'text')
        const runMediaRef = isMultiInput ? null : runMediaRefs[0]

        // Болванка создаётся прямо рядом со своим исходным референсом
        const anchorIds = isMultiInput
          ? runMediaRefs.map((r) => r.shapeId).filter((id) => !id.startsWith('asset:'))
          : runMediaRef && !runMediaRef.shapeId.startsWith('asset:')
            ? [runMediaRef.shapeId]
            : []
        const anchorItem = anchorIds[0] ? store.getItem(anchorIds[0]) : undefined
        const aspect = anchorItem && anchorItem.w > 0 && anchorItem.h > 0 ? anchorItem.w / anchorItem.h : 1

        const runSlots = store.addPendingRow(expectedCount, {
          kind: hasVideoNode ? 'video' : 'image',
          label: runCount > 1 ? `${macro.name} (${k + 1}/${runCount})` : macro.name,
          anchorIds: anchorIds.length > 0 ? anchorIds : undefined,
          aspect,
          prompt: `Macro: ${macro.name}`,
          modelId: macro.id,
          // ⚠️ Родословную пишем и у макроса. Без неё двойной клик по
          // результату подставлял промпт, но не выделял референсы, по которым
          // он сделан (жалоба 07.09.2026), и «Сравнить с…» не могло само найти
          // исходник: он определяется как раз по этому полю.
          referenceIds: runSeedRefs
            .filter((ref) => ref.kind !== 'text' && !ref.shapeId.startsWith('asset:'))
            .map((ref) => ref.shapeId),
          usedReferences: runMediaRefs.length > 0,
        })

        // Фальшивых jobId больше нет: задачи настоящие, их заводит сервер и
        // сообщает в состоянии прогона — тогда же они и привяжутся к местам.
        allPendingSlots.push(...runSlots)
        run.pendingSlots = runSlots
      }

      // Запускаем все в параллели без очереди!
      // Прогоны уходят на СЕРВЕР и живут там: уходить со страницы, закрывать
      // ноутбук и блокировать планшет можно в любой момент. Браузер здесь
      // только смотрит и привязывает пришедшие задачи к местам на доске.
      const results = await Promise.allSettled(
        runs.map(async (run, runIdx) => {
          try {
            const seedRefs = hasInputNode
              ? [...run.inputSnapshot.refs]
              : await toMacroSeedRefs(run.seedRefs, false)
            const started = await startMacroRun({
              requestId: run.requestId,
              macroId: macro.id,
              projectId: projectId ?? '',
              refs: seedRefs,
              snapshot: run.inputSnapshot,
              placeholderIds: run.pendingSlots,
            }, localSource)
            serverRunIds.push(started.id)
            const bound = new Set<string>()
            const finished = await watchMacroRun(started.id, projectId ?? '', {
              isStopped: () => launches.current.isCancelled(launchToken),
              onState: (state) => {
                // Задачи настоящие: как только сервер их завёл, доска берёт их
                // на карандаш и ставит результат сама — а если её закроют,
                // это сделает сервер.
                const fresh = bindMacroRunToBoard(state, store, bound, localSource)
                trackMacroJobs(fresh, projectId ?? '')
                const note = macroRunSummary(state)
                publishStatus(macro.id, 'progress', runCount > 1 ? `${note} (${runIdx + 1}/${runCount})` : note)
                updateMacroRun(launchToken, { progress: note })
              },
            }, localSource)
            if (!finished) return
            totalPlaced += finished.delivered
            dismissUnusedSlots(finished, store, localSource)
            if (finished.status === 'error') throw new Error(finished.error ?? "failed")
          } catch (err) {
            const message = err instanceof Error ? err.message : "error"
            for (const slotId of run.pendingSlots) {
              const pending = store.getPending().find((entry) => entry.id === slotId)
              if (pending && !pending.jobId) store.failPendingById(slotId, message)
            }
            throw err
          }
        })
      )

      const errors = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
      if (launches.current.isCancelled(launchToken)) {
        publishStatus(macro.id, 'stopped', `${macro.name}: stopped`)
      } else if (errors.length > 0) {
        if (errors.length === runs.length) {
          throw errors[0].reason
        } else {
          publishStatus(macro.id, 'partial', `${macro.name}: partially complete (${runs.length - errors.length}/${runs.length})`)
        }
      } else {
        const completion = macroCompletionStatus(macro.name, totalPlaced)
        publishStatus(macro.id, completion.kind, completion.message)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "error"
      // При критической ошибке красим все оставшиеся болванки в красный
      for (const slotId of allPendingSlots) {
        store.failPendingById(slotId, message)
      }
      const stopped = launches.current.isCancelled(launchToken)
      if (stopped) for (const id of serverRunIds) {
        const cancel = api.cancelMacroRun(id)
        void cancel.catch(() => {})
      }
      publishStatus(
        macro.id,
        stopped ? 'stopped' : 'error',
        stopped ? `${macro.name}: stopped` : `${macro.name}: ${message}`,
      )
    } finally {
      // этот запуск закончился — снимаем его токен (остальные прогоны того же
      // макроса продолжают жить со своими токенами)
      if (launchToken) endMacroRun(launchToken)
      launches.current.end(macro.id, launchToken)
      setRunningCount((prev) => {
        const next = { ...prev }
        if (next[macro.id] > 1) next[macro.id]--
        else delete next[macro.id]
        return next
      })
    }
  }

  // Остановка живёт в центре задач в шапке (macroRuns), а не у кнопки запуска:
  // по слоту жмут сериями, и разрушающая цель под тем же курсором — ловушка.

  return (
    <div className="macros-inline" ref={rowRef}>
      {occupied.map((m) => {
        const active = (runningCount[m.id] ?? 0) > 0
        const storedGraph = m.graph as Partial<GraphSnapshot>
        const graph: GraphSnapshot = {
          nodes: Array.isArray(storedGraph?.nodes) ? storedGraph.nodes : [],
          edges: Array.isArray(storedGraph?.edges) ? storedGraph.edges : [],
        }
        const runnable = macroRunnable(graph)
        return (
          <div key={m.id} className="macro-control">
            <button
              className={`macros-inline-btn ${active ? 'running' : ''} ${runnable ? '' : 'draft'}`}
              // По этой метке Ctrl+C узнаёт макрос под курсором (useMacroClipboard).
              data-macro-id={m.id}
              // На сетевой доске в одном ряду стоят и свои макросы, и общие —
              // подсказка говорит чей, как у помощников.
              title={m.name}
              aria-label={
                active
                  ? `Run macro ${m.name} again; runs in progress: ${runningCount[m.id]}`
                  : runnable
                    ? `Macro ${m.name}`
                    : `Draft macro ${m.name}, open editor`
              }
              onClick={() => {
                // клик по работающему макросу = ещё один ПАРАЛЛЕЛЬНЫЙ прогон
                // (решение пользователя); остановка — отдельной кнопкой «Стоп»
                if (runnable) void runMacro(m)
                else openEditor(m)
              }}
              onMouseDown={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                if (e.key === 'F2') {
                  e.preventDefault()
                  openEditor(m)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                openEditor(m)
              }}
            >
              <span className="macro-slot-name">{macroShortLabel(m.name)}</span>
            </button>
          </div>
        )
      })}
      {(
        <button
          type="button"
          className="macros-inline-btn more"
          // На сетевой доске порядок кнопок не меняют: свои идут первыми, общие за ними.
          title="All macros: rename, duplicate, move slot, delete"
          aria-label="All macros"
          onClick={() => setLibraryOpen(true)}
        >
          ⋯
        </button>
      )}
      {libraryOpen && (
        <MacroLibrary
          scope="canvas"
          projectSource={localSource}
          initialNotice={libraryNotice}
          onClose={() => {
            setLibraryOpen(false)
            setLibraryNotice(null)
          }}
        />
      )}
    </div>
  )
}

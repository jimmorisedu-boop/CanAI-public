import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { InlineNotice } from '../ui/InlineNotice'
import { ParamControls } from '../ui/ParamControls'
import { PriceBadge } from '../ui/PriceBadge'
import { priceBadgeTitle } from '../ui/quotePresentation'
import { IconClose, IconCollapse, IconFitAll, IconImage, IconKeyboard, IconSettings, IconVideo, IconSound } from '../ui/icons'
import { baseModels, panelParams, useCatalogModels } from '../spaces/canvas/genOptions'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { toGenRefs, type SelectionRef } from '../spaces/canvas/konva/selection'
import { useSelectionRefs } from '../spaces/canvas/konva/useStore'
import { useModelSelection } from '../spaces/canvas/useModelSelection'
import { AUTO_MODEL_ID, isAutoModelId, selectableModelId } from '../spaces/canvas/smartModelSelection'
import { autoOptionLabel } from '../spaces/canvas/smartModelMessages'
import { usePromptDraft } from '../spaces/canvas/continuity/usePromptDraft'
import { draftModelCatalog } from '../spaces/canvas/continuity/sessionDraftModel'
import { onAddPromptAsset } from '../spaces/canvas/promptAssetBus'
import { onPromptFill } from '../spaces/canvas/promptFillBus'
import { appendUniqueReferences } from '../spaces/canvas/referenceComposer'
import { askAssistant, useActiveAssistantMessageId } from '../spaces/canvas/assistantAsk'
import { boardMemoryToggleShown, promptChatStore } from '../spaces/canvas/promptChatStore'
import { assistantModelOptions, modelSelectHint } from '../spaces/canvas/assistantModelHint'
import { draftFromComposer } from '../spaces/canvas/promptChatComposer'
import type { PromptChatEstimate } from '../spaces/canvas/promptChatTypes'
import { notify } from '../spaces/canvas/notifications'
import { previewSrc } from './remoteSession'
import { useTabletGeneration } from './useTabletGeneration'
import { TabletAssistant } from './TabletAssistant'
import { TabletAssistantPresets } from './TabletAssistantPresets'
import { useTabletAssistantSelection } from './useTabletAssistantSelection'
import {
  applyPreparedPrompt,
  dockHelperEligibility,
  dockHelperHint,
  helperEstimateUsd,
  helperInstruction,
  helperSampleRefs,
  preparedPromptProblem,
} from '../spaces/canvas/dockHelper'
import { executeDockHelperRun } from '../spaces/canvas/dockHelperRun'
import { canvasActionTransport } from '../spaces/canvas/canvasActionTransport'
import { newId } from '../ui/ids'
import { TabletAssistantChats } from './TabletAssistantChats'
import { TabletMacros } from './TabletMacros'
import { promptFocusesTextarea, tabletPromptLayout, tabletSettingsPlacement } from './visualViewportModel'
import { projectKey } from '../projects/projectRef'
import type { GenRef, JobKind, PricingMode, ProjectSource } from '../types'
import { executorCompatibilityError } from '../../../packages/model-catalog/version'
import { usePromptFieldHeight } from './usePromptFieldHeight'
import { usePromptHeightBudget } from './usePromptHeightBudget'
import { bindTabletKeyboardButton } from './tabletKeyboardButton'
import { assistantInputHeight } from './assistantReading'
import { ActionDockBatchSwitch, ActionDockModeTabs, actionDockCreateLabel, type ActionDockMode } from '../spaces/canvas/ActionDock'
import type { ActionBatchMode } from '../spaces/canvas/actionDockBatch'
import {
  dockLeadRefs,
  dockModelSelector,
  planDockLaunch,
  type DockLaunchState,
} from '../spaces/canvas/actionDockLaunch'
import type { AgentPanelController } from '../spaces/canvas/agents/agentPanelController'
import { AgentLaunchComposer } from '../spaces/canvas/agents/AgentLaunchComposer'
import type { AgentPresentationCapability } from '../spaces/canvas/agents/agentCapabilities'
import { tabletSystemMessage } from './tabletSystemMessage'
import { useT } from '../i18n/context.js'


// Док создания: нижняя полка планшета.
//
// Не сжатый десктопный, а свой. Разница не в ширине, а в том, чем работают:
// пальцем, часто одной рукой, при поднявшейся на пол-экрана клавиатуре.
// Отсюда решения — крупные цели, один главный ряд, настройки в раскрывашке,
// и никаких действий, доступных только с клавиатуры.
//
// ⚠️ ИНВАРИАНТ: поле ввода не блокируется НИКОГДА, а «Создать» не получает
// disabled из-за помощника. Пока идёт ответ, «Спросить» превращается в «Стоп» —
// это другое действие, а не блокировка (правило общее с компьютером: перенос
// такого замка в общее поле убил бы серию платных запусков).

const KINDS: Array<{ id: 'image' | 'video' | 'audio'; label: string; icon: ReactNode }> = [
  { id: 'image', label: 'Image', icon: <IconImage aria-hidden="true" /> },
  { id: 'video', label: 'Video', icon: <IconVideo aria-hidden="true" /> },
  { id: 'audio', label: 'Sound', icon: <IconSound aria-hidden="true" /> },
]

export function tabletActionText(
  label: string,
  amount: number | null,
  precision = 2,
  pricingMode?: PricingMode,
  meteredUncapped = false,
): string {
  if (amount == null) return label
  const prefix = meteredUncapped
    ? '≈'
    : pricingMode === 'fal-metered' ? 'up to ' : label === 'Ask' ? '≈' : ''
  return `${label} · ${prefix}$${amount.toFixed(precision)}`
}

export function tabletModelButtonAction(
  expanded: boolean,
  settingsOpen: boolean,
): { expanded: boolean; settingsOpen: boolean } {
  // На iPad focus capture может раскрыть dock между pointerdown и click.
  // Первый tap по модели всё равно должен открыть её меню, а не только dock.
  return {
    expanded: true,
    settingsOpen: expanded ? !settingsOpen : true,
  }
}

export function TabletPromptOptionRows({
  controls,
  macros,
}: {
  controls: ReactNode
  macros: ReactNode
}) {
  return (
    <div className="tablet-prompt-options">
      <div className="tablet-prompt-primary-row">{controls}</div>
      <div className="tablet-prompt-macro-row">{macros}</div>
    </div>
  )
}

export function TabletPrompt({
  store,
  projectId,
  projectSource = 'local',
  ready,
  readOnly,
  keyboardOpen = false,
  visibleHeight = 820,
  dragHandle,
  agentController,
  agentCapability,
  flushBoardBeforeCapture,
  preparationAvailable = true,
}: {
  store: CanvasStore
  projectId: string
  projectSource?: ProjectSource
  ready: boolean
  readOnly?: boolean
  keyboardOpen?: boolean
  visibleHeight?: number
  dragHandle?: ReactNode
  agentController?: AgentPanelController
  agentCapability?: AgentPresentationCapability
  /** Persist optimistic local/paired edits before Host freezes native media. */
  flushBoardBeforeCapture?: () => Promise<{ revision: number }>
  preparationAvailable?: boolean
}) {
  const t = useT()
  const promptChatProjectId = projectKey({ source: projectSource, id: projectId })
  const assistantSelection = useTabletAssistantSelection({
    projectSource,
    onChanged: () => {},
  })
  const [prompt, setPrompt] = useState('')
  const latestPrompt = useRef(prompt)
  const askingRef = useRef(false)
  latestPrompt.current = prompt
  const [previousPrompt, setPreviousPrompt] = useState<string | null>(null)
  const [kind, setKind] = useState<'image' | 'video' | 'audio'>('image')
  const [count, setCount] = useState(1)
  const [batchMode, setBatchMode] = useState<ActionBatchMode>('together')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tab, setTab] = useState<'prompt' | 'assistant' | 'agents'>('prompt')
  useEffect(() => {
    if (tab === 'prompt') {
      assistantSelection.reload()
    }
  }, [tab])
  const [helperPreparing, setHelperPreparing] = useState(false)
  const helperAbortRef = useRef<AbortController | null>(null)
  const [manualRefs, setManualRefs] = useState<SelectionRef[]>([])
  const [lastDiscussRefs, setLastDiscussRefs] = useState<SelectionRef[]>([])
  const [chatEstimate, setChatEstimate] = useState<PromptChatEstimate | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [largeEditor, setLargeEditor] = useState(false)
  // ⚠️ Пока ввод не начат, поле держим readOnly: оно фокусируется
  // касанием само, мимо наших обработчиков, и клавиатура вылезала от любого
  // тычка в поле — в том числе когда человек просто читает написанное.
  // Просьба 09.09.2026: клавиатура появляется по кнопке клавиатуры.
  const [typingArmed, setTypingArmed] = useState(false)
  const promptRef = useRef<HTMLElement>(null)
  const settingsPopRef = useRef<HTMLDivElement>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const [settingsPlacement, setSettingsPlacement] = useState<'above' | 'viewport-top'>('above')
  const [settingsTop, setSettingsTop] = useState<number | null>(null)
  const [settingsMaxHeight, setSettingsMaxHeight] = useState<number | null>(null)
  const settingsOpenRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const assistantAreaRef = useRef<HTMLDivElement>(null)
  const keyboardButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const button = keyboardButtonRef.current
    if (!button) return
    return bindTabletKeyboardButton(button, () => {
      const field = textareaRef.current
      if (!field || !promptFocusesTextarea('keyboard')) return
      if (!field.readOnly) {
        field.blur()
        field.readOnly = true
        setTypingArmed(false)
        return
      }
      if (document.activeElement === field) field.blur()
      flushSync(() => { setExpanded(true); setTypingArmed(true) })
      field.readOnly = false
      field.focus({ preventScroll: true })
    })
  }, [])
  // Разрешение ввода снимает только кнопка клавиатуры: системное меню языка
  // может временно менять фокус, не завершая редактирование.
  const chat = useSyncExternalStore(
    useCallback((listener: () => void) => promptChatStore.subscribe(promptChatProjectId, listener), [promptChatProjectId]),
    useCallback(() => promptChatStore.getSnapshot(promptChatProjectId), [promptChatProjectId]),
  )
  const assistantModelId = chat.active?.meta.selectedModelId ?? ''
  const [changingAssistantModel, setChangingAssistantModel] = useState(false)
  const { models, defaults } = useCatalogModels(projectSource)
  const selRefs = useSelectionRefs(store)
  const activeAnswer = useActiveAssistantMessageId(promptChatProjectId)
  settingsOpenRef.current = settingsOpen

  const setSettingsVisibility = (open: boolean): void => {
    // Ref обновляем синхронно: native select на iPad может на один кадр
    // отдать фокус body, и blur не должен успеть свернуть весь промпт.
    settingsOpenRef.current = open
    setSettingsOpen(open)
  }

  useEffect(() => {
    if (!settingsOpen) return
    const onPointerDown = (event: PointerEvent) => {
      // ⚠️ Мимо — значит мимо САМОГО окна, а не мимо всей полки промпта.
      // Проверка по полке оставляла окно открытым при касании поля промпта и
      // соседних кнопок: человек уже занят другим, а поверх висит выбор
      // модели (просьба 09.09.2026 «должна прятаться при любом клике мимо
      // неё, даже если в окно промпта»). Кнопку, которая его открывает, из-под
      // удара выводим ТОЛЬКО саму кнопку модели: она читает состояние на click
      // и иначе открывала бы меню заново сразу после нашего закрытия.
      const target = typeof Node !== 'undefined' && event.target instanceof Node ? event.target : null
      if (target && modelBtnRef.current?.contains(target)) return
      const pop = settingsPopRef.current
      if (pop && typeof Node !== 'undefined' && event.target instanceof Node && pop.contains(event.target)) return
      setSettingsVisibility(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setSettingsVisibility(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [settingsOpen])

  useEffect(() => {
    void promptChatStore.loadProject(promptChatProjectId)
  }, [promptChatProjectId])

  // Ручные чипы с полки живут ПОВЕРХ выделения — как на компьютере: полка
  // затем и нужна, чтобы держать под рукой то, чего сейчас нет в выделении.
  useEffect(() => {
    onAddPromptAsset((ref) => {
      setManualRefs((current) => appendUniqueReferences(current, [ref], {
        dedupeContent: kind !== 'image',
      }))
    })
    return () => onAddPromptAsset(null)
  }, [batchMode, kind])

  const refs = useMemo(
    () => appendUniqueReferences(selRefs, manualRefs, {
      dedupeContent: kind !== 'image',
    }),
    [batchMode, kind, manualRefs, selRefs],
  )
  const refsRef = useRef<SelectionRef[]>([])
  refsRef.current = refs
  const refsKey = refs.map((ref) => `${ref.shapeId}:${ref.kind}`).join(',')

  // Цена текста считается тем же серверным прогнозом, что на компьютере.
  // Задержка не шлёт запрос на каждый набранный символ.
  useEffect(() => {
    if (tab !== 'assistant' || activeAnswer || chat.boardMemorySaving || !prompt.trim()) {
      setChatEstimate(null)
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      const draft = draftFromComposer(
        prompt,
        refs,
        textareaRef.current?.selectionStart ?? prompt.length,
        textareaRef.current?.selectionEnd ?? prompt.length,
      )
      void promptChatStore.estimate(promptChatProjectId, prompt, draft.attachments)
        .then((estimate) => { if (alive) setChatEstimate(estimate) })
        .catch(() => { if (alive) setChatEstimate(null) })
    }, 300)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [activeAnswer, assistantModelId, chat.boardMemorySaving, chat.boardMemoryEnabled, promptChatProjectId, prompt, refsKey, tab])

  const hasImageRefs = refs.some((ref) => ref.kind !== 'text')
  const mediaRefKey = refs.filter((ref) => ref.kind !== 'text').map((ref) => ref.shapeId).join(',')
  // Подбор модели видит референсы ПЕРВОГО запроса — те же, по которым ниже
  // строятся предпросмотр и запуск (правило общее с компьютером).
  const latestRefs = useRef(refs)
  latestRefs.current = refs
  const leadRefsFor = useCallback(
    (nextKind: JobKind) => dockLeadRefs({ batchMode, refs: latestRefs.current, sketchTarget: null }, nextKind),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refsKey, batchMode],
  )
  const { modelId, params, updateParams, chooseModel, resetForKind } = useModelSelection({
    models,
    defaults,
    kind,
    hasMediaRefs: hasImageRefs,
    mediaRefKey,
    smartAuto: { refsFor: leadRefsFor },
  })
  const activePreset = assistantSelection.activeId
    ? assistantSelection.presets.find((p) => p.id === assistantSelection.activeId)
    : null

  const helperEligible = dockHelperEligibility({
    kind,
    assistantId: assistantSelection.activeId,
    assistantKnown: assistantSelection.loadState === 'ready',
    isStandaloneCloudTablet: false,
    imageRefsCount: refs.filter((r) => r.kind === 'image').length,
    hasPreparationCapability: preparationAvailable,
  })

  const helperEstimate = helperEstimateUsd(models, activePreset?.modelId)
  const helperHint = dockHelperHint(
    tab === 'prompt' ? 'make' : tab === 'assistant' ? 'discuss' : 'agents',
    helperEligible,
    helperEstimate,
  )

  const textPreparation = helperEligible.eligible && assistantSelection.activeId
    ? {
        assistantId: assistantSelection.activeId,
        versionId: activePreset?.versionId ?? null,
      }
    : undefined

  // Состояние дока для плана запуска — то же, из которого запуск строит свой
  // план (planDockLaunch и подбор модели общие с компьютером).
  const dockState: DockLaunchState = {
    projectRef: { source: projectSource, id: projectId },
    kind,
    models,
    defaults,
    modelId,
    batchMode,
    refs,
    prompt,
    count,
    params,
    sketchTarget: null,
    itemById: (id) => store.getItem(id),
    textPreparation,
  }
  const dockPreview = planDockLaunch(dockState)
  const actionBatchPreview = dockPreview.batch
  const displayRequest = actionBatchPreview.requests[0]
  // Показана модель первого запроса плана. Плана нет (набор не проходит) — на
  // виду остаются ручки модели из подбора, а цены нет: запускать нечего.
  const displayModel = displayRequest?.plan.model ?? dockPreview.selection.panelModel
  const displayedPrice = actionBatchPreview.totalCost
  const { launch, error, setError, busy } = useTabletGeneration(store, projectId, ready, projectSource)
  useEffect(() => {
    onPromptFill((request) => {
      const item = store.getItem(request.shapeId)
      if (!item || !request.prompt || readOnly) return
      if (latestPrompt.current && latestPrompt.current !== request.prompt) setPreviousPrompt(latestPrompt.current)
      setPrompt(request.prompt)
      setTab('prompt')
      setExpanded(true)
      setSettingsVisibility(false)
      // На объекте мог остаться номер варианта («…-edit»): в списке его нет.
      const restoredId = selectableModelId(models, request.modelId)
      const model = restoredId ? models.find((entry) => entry.id === restoredId) : undefined
      if (model && (model.kind === 'image' || model.kind === 'video' || model.kind === 'audio')) {
        setKind(model.kind)
        chooseModel(model.id, undefined, model.kind)
      } else if (item.kind === 'image' || item.kind === 'video' || item.kind === 'audio') {
        setKind(item.kind)
        resetForKind(item.kind)
        if (request.modelId) setError('The saved model is unavailable. Check the selected model before running.')
      }
      // Выделение результата не должно становиться случайным новым референсом.
      store.setSelection((request.referenceIds ?? []).filter((id) => Boolean(store.getItem(id))))
      const pinned = (request.referenceIds ?? []).flatMap((id): SelectionRef[] => {
        if (!id.startsWith('asset:')) return []
        const asset = store.getAssets().find((entry) => entry.slot === Number(id.slice(6)))
        return asset ? [{ shapeId: id, kind: asset.kind, label: asset.name || 'Reference', src: asset.src, assetId: asset.assetId, text: asset.text, w: asset.width, h: asset.height }] : []
      })
      setManualRefs(pinned)
    })
    return () => onPromptFill(null)
  }, [store, models, readOnly, chooseModel, resetForKind])
  const composerLayout = tabletPromptLayout({ expanded, largeEditor, keyboardOpen, visibleHeight })
  const heightBudget = usePromptHeightBudget(promptRef, textareaRef, assistantAreaRef, visibleHeight)
  const fieldSizing = usePromptFieldHeight(textareaRef, heightBudget.field, () => setExpanded(true))
  const fieldMaxHeight = expanded && fieldSizing.height != null ? heightBudget.field : composerLayout.maxHeight
  const assistantSizing = usePromptFieldHeight(assistantAreaRef, heightBudget.area, () => setExpanded(true), 180)
  const assistantHeight = Math.max(180, Math.min(assistantSizing.height ?? 340, heightBudget.area))
  const assistantSplit = usePromptFieldHeight(textareaRef, Math.max(44, assistantHeight * .55), () => setExpanded(true))
  const readingAssistant = tab === 'assistant' && expanded && !largeEditor
  const assistantComposerHeight = Math.min(assistantHeight * .55, assistantSplit.height ?? assistantInputHeight(assistantHeight))

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    if (readingAssistant) {
      textarea.style.height = `${assistantComposerHeight}px`
      return
    }
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(
      fieldMaxHeight,
      Math.max(composerLayout.minHeight, !largeEditor && expanded && fieldSizing.height != null ? fieldSizing.height : textarea.scrollHeight),
    )}px`
  }, [fieldMaxHeight, composerLayout.minHeight, prompt, tab, expanded, largeEditor, fieldSizing.height, readingAssistant, assistantComposerHeight])

  // На высокой доске меню обычно помещается над доком. При коротком viewport
  // или большом наборе параметров оно иначе уезжает под верхнюю панель: CSS
  // `bottom: 100%` знает только размер промпта, но не оставшееся место экрана.
  // Перемещаем меню в верхнюю часть видимого viewport и оставляем ему свою
  // прокрутку; сам prompt при этом сохраняет обычную геометрию и фокус.
  useLayoutEffect(() => {
    if (!settingsOpen) {
      setSettingsPlacement('above')
      setSettingsTop(null)
      setSettingsMaxHeight(null)
      return
    }

    const viewport = typeof window !== 'undefined' ? window.visualViewport : null
    const updatePlacement = () => {
      const promptElement = promptRef.current
      const popover = settingsPopRef.current
      if (!promptElement || !popover) return

      const promptRect = promptElement.getBoundingClientRect()
      const scale = promptRect.width / promptElement.offsetWidth || 1
      const viewportTop = viewport?.offsetTop ?? 0
      const viewportHeight = viewport?.height ?? visibleHeight
      // Верхняя панель занимает 52px; запас в 8px не даёт меню прилипнуть к её
      // границе на iPad с safe-area inset.
      const topMargin = viewportTop + 60
      const placement = tabletSettingsPlacement({
        promptTop: promptRect.top,
        popoverHeight: popover.getBoundingClientRect().height,
        viewportTop,
        viewportHeight,
        topInset: topMargin - viewportTop,
        gap: 8,
      })
      setSettingsPlacement(placement.placement)
      setSettingsTop(placement.top === null ? null : placement.top / scale)
      setSettingsMaxHeight(placement.maxHeight === null ? null : placement.maxHeight / scale)
    }

    const frame = window.requestAnimationFrame(updatePlacement)
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('orientationchange', updatePlacement)
    window.addEventListener('canai-tablet-ui-scale', updatePlacement)
    viewport?.addEventListener('resize', updatePlacement)
    viewport?.addEventListener('scroll', updatePlacement)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('orientationchange', updatePlacement)
      window.removeEventListener('canai-tablet-ui-scale', updatePlacement)
      viewport?.removeEventListener('resize', updatePlacement)
      viewport?.removeEventListener('scroll', updatePlacement)
    }
  }, [displayModel?.id, expanded, hasImageRefs, keyboardOpen, largeEditor, settingsOpen, tab, visibleHeight])

  const multiImageBatch = kind === 'image' && actionBatchPreview.admission.imageCount > 1
  const createLabel = actionDockCreateLabel(kind, batchMode, actionBatchPreview.admission.imageCount)
  const autoModelLabel = autoOptionLabel({
    selected: isAutoModelId(modelId),
    modelName: (displayRequest?.baseModel ?? dockPreview.selection.baseModel)?.name ?? null,
    catalogReady: models.length > 0,
  })
  const localizedAutoModelLabel = autoModelLabel === 'Auto'
    ? t('Auto')
    : autoModelLabel === 'Auto · no model'
      ? t('Auto · no model')
      : `${t('Auto')} · ${autoModelLabel.slice('Auto · '.length)}`

  const pricingNote = displayModel?.pricingNote
  // Почему модель не берёт выбранный набор, видно до нажатия — тем же
  // сообщением, что и после него; пока запускать нечего, молчим.
  const modelRefusal = tab === 'prompt' && ready && models.length > 0 && !readOnly
    && (Boolean(prompt.trim()) || refs.some((ref) => ref.kind === 'text'))
    ? dockPreview.selection.error
    : null
  const [dismissedModelRefusal, setDismissedModelRefusal] = useState<string | null>(null)
  useEffect(() => {
    if (!modelRefusal) setDismissedModelRefusal(null)
  }, [modelRefusal])
  const shownErrorRaw = error ?? (modelRefusal !== dismissedModelRefusal ? modelRefusal : null)
  const shownError = shownErrorRaw
    ? tabletSystemMessage(shownErrorRaw, t('Could not prepare the request.'))
    : null
  const draftCatalog = useMemo(() => draftModelCatalog(models, defaults), [models, defaults])

  // Черновик сеанса — тот же, что на компьютере. Ради него всё и затевалось:
  // начал там, продолжил здесь.
  usePromptDraft({
    projectId,
    projectSource,
    ready,
    canWrite: ready && !readOnly,
    modelsReady: models.length > 0,
    catalog: draftCatalog,
    state: {
      prompt,
      kind,
      modelId,
      params,
      count,
      // Какое окно было открыто — тоже часть «того же места»: компьютер пишет
      // сюда своё (PromptBar), планшет своё, и оба читают одно поле.
      pane: tab === 'agents' ? 'prompt' : tab,
      selection: selRefs.map((ref) => ref.shapeId),
      manualRefs,
    },
    apply: {
      setPrompt,
      applyKind: (next) => {
        if (next === kind) return
        setKind(next)
        resetForKind(next)
        setCount(1)
      },
      setCount,
      chooseModel,
      setManualRefs,
      setSelection: (ids) => store.setSelection(ids),
    },
  })

  // Выделили видео — генерация сама переключается на видео (как на компьютере).
  const selectionHasVideo = refs.some((ref) => ref.kind === 'video')
  useEffect(() => {
    if (!selectionHasVideo || kind === 'video') return
    setKind('video')
    resetForKind('video')
    setCount(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionHasVideo])

  const panel = panelParams(displayModel, hasImageRefs)
  const pickable = baseModels(models, kind)

  async function submit(): Promise<void> {
    if (readOnly) return
    const frozenRefs = refs.map((ref) => ({ ...ref }))
    // Сначала сам набор, потом согласие — как на компьютере: без модели
    // согласие «не готово» по построению, и человек прочёл бы не ту причину.
    const admissionError = dockPreview.batch.admission.error
    if (admissionError) {
      if (admissionError === modelRefusal) {
        // Отказ подбора модели уже стоит в панели и уйдёт сам, когда набор
        // изменится: возвращаем его на глаза, а не закрепляем копией.
        setError(null)
        setDismissedModelRefusal(null)
      } else {
        setError(admissionError)
      }
      return
    }
    const ok = await launch({
      kind,
      prompt,
      refs: frozenRefs,
      count,
      params,
      selectModel: dockModelSelector(dockState),
      batchMode,
      mediaTransferConsent: true,
      beforeLaunch: async (batchToRun) => {
        if (!helperEligible.eligible || !assistantSelection.activeId) {
          return batchToRun
        }
        setHelperPreparing(true)
        const controller = new AbortController()
        helperAbortRef.current = controller

        const sampleRefs = helperSampleRefs(frozenRefs, batchMode)
        let sampleGenRefs: GenRef[] = []
        try {
          sampleGenRefs = await toGenRefs(sampleRefs, 'image')
        } catch (err) {
          setHelperPreparing(false)
          helperAbortRef.current = null
          throw new Error(err instanceof Error ? err.message : t('Could not prepare references.'))
        }

        const instruction = helperInstruction(
          prompt,
          frozenRefs.filter((r) => r.kind === 'text'),
        )
        const imageGenRefs = sampleGenRefs.filter((r): r is { kind: 'image'; src: string; assetId?: string; width?: number; height?: number; role?: string } => r.kind === 'image')

        try {
          const runResult = await executeDockHelperRun({
            projectRef: { source: projectSource, id: projectId },
            prompt: instruction,
            refs: imageGenRefs,
            assistantId: assistantSelection.activeId,
            profileVersionId: activePreset?.versionId ?? undefined,
            idempotencyKey: `tablet_prep_${Date.now()}_${newId().slice(0, 6)}`,
            transport: canvasActionTransport,
            signal: controller.signal,
            isCurrentScope: () => tab === 'prompt',
            expectedEstimateUsd: helperEstimate,
          })

          if (runResult.status === 'cancelled') {
            return false
          }
          if (runResult.status === 'stale') {
            return false
          }
          if (runResult.status === 'error') {
            throw new Error(`${t('The assistant did not prepare a request — nothing was started:')} ${runResult.error}`)
          }

          const problem = preparedPromptProblem(runResult.prompt, batchMode, sampleRefs.length)
          if (problem) {
            throw new Error(`${t('The assistant did not prepare a request — nothing was started:')} ${problem}`)
          }

          return applyPreparedPrompt(batchToRun, runResult.prompt)
        } finally {
          setHelperPreparing(false)
          helperAbortRef.current = null
        }
      },
    })
    if (ok) {
      if (latestPrompt.current === prompt) {
        setPrompt('')
      }
      setExpanded(false)
      setLargeEditor(false)
      textareaRef.current?.blur()
    }
  }

  async function ask(): Promise<void> {
    const text = prompt.trim()
    if (!text || activeAnswer) return
    // кадр из ролика снимается до отправки — второй тап не должен отправить
    // второй оплаченный вопрос (то же правило, что в PromptBar.ask)
    if (askingRef.current) return
    askingRef.current = true
    setError(null)
    const sentRefs = refs.map((ref) => ({ ...ref }))
    const sentRefsKey = JSON.stringify(sentRefs)
    const sentConversationId = promptChatStore.getSnapshot(promptChatProjectId).activeId
    setLastDiscussRefs(sentRefs)
    try {
      await askAssistant(promptChatProjectId, text, sentRefs)
      // ⚠️ Текст стираем ТОЛЬКО после того, как вопрос принят. Раньше поле
      // чистилось до сетевого круга, и неудачная отправка молча съедала
      // написанное: со стороны это и есть «помощник не реагирует».
      if (
        promptChatStore.getSnapshot(promptChatProjectId).activeId === sentConversationId
        && latestPrompt.current.trim() === text
        && JSON.stringify(refsRef.current) === sentRefsKey
      ) {
        setPrompt('')
        setManualRefs([])
      }
    } catch (err) {
      // Отказ живёт в панели, а не во всплывашке на две секунды: человек
      // смотрит сюда и должен узнать причину, а не гадать о молчании.
      setError(tabletSystemMessage(err, t('The assistant did not respond')))
    } finally {
      askingRef.current = false
    }
  }

  return (
    <section
      ref={promptRef}
      data-tablet-prompt-dropzone={readOnly ? undefined : ''}
      className={`tablet-prompt ${expanded ? 'expanded' : 'collapsed'} ${keyboardOpen ? 'viewport-keyboard-open' : ''} ${largeEditor ? 'large-editor' : ''} ${readingAssistant ? 'reading-assistant' : ''}`}
      aria-label={t('Creating')}
      style={{ '--tablet-prompt-visible-height': `${Math.max(320, visibleHeight)}px`, '--tablet-panel-max-height': `${heightBudget.panel}px`, '--tablet-area-max-height': `${heightBudget.area}px`, '--tablet-assistant-height': `${assistantHeight}px` } as CSSProperties}

    >
      <div className="tablet-prompt-head">
        <ActionDockModeTabs
          mode={tab === 'assistant' ? 'discuss' : tab === 'agents' ? 'agents' : 'make'}
          available={{ agents: !readOnly && Boolean(agentController && agentCapability?.canLaunch) }}
          signal={activeAnswer ? 'working' : 'none'}
          signalLabel={activeAnswer ? 'Assistant is responding' : undefined}
          onChange={(next: ActionDockMode) => {
            if (readOnly) return
            if (next === 'make') {
              setTab('prompt')
              setSettingsVisibility(false)
              return
            }
            if (next === 'discuss') {
              setTab('assistant')
              setExpanded(true)
              setSettingsVisibility(false)
              return
            }
            if (next === 'agents' && agentController && (agentCapability?.canLaunch || agentCapability?.canObserve)) {
              setTab('agents')
              setExpanded(true)
              setSettingsVisibility(false)
              agentController.setCollapsed(false)
            }
          }}
        />
        <div className="tablet-prompt-handles">
          {dragHandle}
          <button
            type="button"
            className="ui-btn quiet tablet-prompt-height-handle"
            aria-label={tab === 'assistant' ? t('Resize assistant panel') : tab === 'agents' ? 'Resize agents panel' : 'Resize prompt field'}
            title={t('Drag up to read more text')}
            {...(tab === 'assistant' ? assistantSizing.handle : fieldSizing.handle)}
          ><span aria-hidden="true" /></button>
        </div>
        {tab === 'prompt' && (
          <button
            type="button"
            ref={modelBtnRef}
            className={`ui-btn quiet tablet-model-btn ${settingsOpen ? 'on' : ''}`}
            aria-expanded={settingsOpen}
            aria-controls="tablet-settings-pop"
            aria-haspopup="dialog"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              const next = tabletModelButtonAction(expanded, settingsOpenRef.current)
              setExpanded(next.expanded)
              setSettingsVisibility(next.settingsOpen)
            }}
          >
            <IconSettings size={15} /> {displayModel?.name ?? 'Model'}
          </button>
        )}
        {tab === 'assistant' && <select
          className="ui-field tablet-assistant-model"
          aria-label={t('Model for this conversation')}
          value={assistantModelId}
          title={chat.active ? undefined : modelSelectHint(chat.loadState)}
          disabled={!chat.active || readOnly || changingAssistantModel || Boolean(activeAnswer)}
          onChange={(event) => {
            setChangingAssistantModel(true)
            void promptChatStore.setModel(promptChatProjectId, event.target.value)
              .catch((error) => notify({ kind: 'error', message: tabletSystemMessage(error, t('Could not change model')) }))
              .finally(() => setChangingAssistantModel(false))
          }}
        >
          {assistantModelOptions({ models, selectedModelId: chat.active?.meta.selectedModelId, chatLoadState: chat.loadState }).map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled} title={option.title}>{option.label}</option>
          ))}
        </select>}
        {/* на сетевой доске — только если сервер команды память доски умеет, см. boardMemoryToggleShown */}
        {tab === 'assistant' && boardMemoryToggleShown(projectSource, chat.boardMemoryControlSupported) && (
          <button
            type="button"
            role="switch"
            className="ui-btn quiet tablet-board-memory-toggle"
            aria-label={t('Board memory')}
            aria-checked={chat.boardMemoryEnabled}
            aria-busy={chat.boardMemorySaving}
            disabled={readOnly || !chat.boardMemoryControlSupported || chat.loadState !== 'ready' || chat.boardMemorySaving}
            title={chat.boardMemoryControlSupported
              ? t('Affects only automatic context and model selection. History and explicit references are kept.')
              : t('The Host did not confirm board memory support.')}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              void promptChatStore.setBoardMemoryEnabled(promptChatProjectId, !chat.boardMemoryEnabled)
                .catch((error) => notify({ kind: 'error', message: tabletSystemMessage(error, t('Could not save board memory')) }))
            }}
          >
            <span className="tablet-board-memory-label" aria-hidden="true">{t('Board memory')}</span>
            <span className="tablet-board-memory-state" aria-hidden="true">{chat.boardMemoryEnabled ? t('On') : t('Off')}</span>
          </button>
        )}
        <button
          type="button"
          className="ui-btn quiet icon-only tablet-prompt-disclosure"
          aria-label={expanded ? t('Collapse prompt panel') : t('Expand prompt panel')}
          aria-expanded={expanded}
          aria-controls="tablet-prompt-scroll"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? <IconCollapse size={18} /> : <IconFitAll size={18} />}
        </button>
        <button
          type="button"
          className={`ui-btn quiet icon-only tablet-prompt-keyboard ${tab === 'agents' ? 'tablet-prompt-keyboard-hidden' : ''}`}
          ref={keyboardButtonRef}
          aria-label={typingArmed ? t('Hide keyboard') : t('Show keyboard')}
          aria-pressed={typingArmed}
          disabled={readOnly || tab === 'agents'}
          onPointerDown={(event) => event.preventDefault()}
        >
          <IconKeyboard size={18} />
        </button>
      </div>

      <div className="tablet-prompt-scroll" id="tablet-prompt-scroll" ref={assistantAreaRef}>
        {tab === 'agents' ? (
          <div className="tablet-agents-pane" role="region" aria-label={t('Agents')}>
            {agentController && (agentCapability?.canLaunch || agentCapability?.canObserve) ? (
              <AgentLaunchComposer
                controller={agentController}
                projectRef={{ source: projectSource, id: projectId }}
                store={store}
                enabled={!readOnly && ready}
                compact
                capability={agentCapability}
                flushBoardBeforeCapture={flushBoardBeforeCapture}
              />
            ) : (
              <InlineNotice
                tone="info"
                title={t('Agents are unavailable with this connection')}
                detail={agentCapability?.reason ?? 'The server did not advertise agent controls for this board.'}
              />
            )}
          </div>
        ) : (
        <>
        {previousPrompt !== null && tab === 'prompt' && <button type="button" className="ui-btn quiet" onClick={() => { setPrompt(previousPrompt); setPreviousPrompt(null) }}>{t('Restore draft text')}</button>}
        {tab === 'assistant' && (
            <div id="tablet-panel-assistant" role="region" aria-label={t('Discuss')}>
            <div className="tablet-assistant-bar">
              <TabletAssistantPresets
                projectSource={projectSource}
                onChanged={() => {}}
              />
              <TabletAssistantChats projectId={promptChatProjectId} />
            </div>
            <TabletAssistant
              store={store}
              projectId={promptChatProjectId}
              onUsePrompt={(text) => {
                setPrompt(text)
                // «В строку» is a transfer, not a fresh composer: preserve
                // exactly the attachments of the question that produced this
                // answer and do not launch generation here.
                if (lastDiscussRefs.length > 0) {
                  store.setSelection([])
                  setManualRefs(lastDiscussRefs.map((ref) => ({ ...ref })))
                }
                setTab('prompt')
                setSettingsVisibility(false)
                if (promptFocusesTextarea('textarea')) textareaRef.current?.focus({ preventScroll: true })
              }}
            />
          </div>
        )}

        {tab === 'prompt' && (
          <div className="tablet-assistant-row">
            <select
              className="ui-field tablet-assistant-select"
              value={assistantSelection.activeId ?? '__canai_universal__'}
              disabled={readOnly || assistantSelection.loadState !== 'ready'}
              aria-label={t('Assistant')}
              onChange={(e) => {
                const val = e.target.value
                void assistantSelection.select(val === '__canai_universal__' ? null : val)
              }}
            >
              <option value="__canai_universal__">{t('Assistant: Universal')}</option>
              {assistantSelection.presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            {helperHint && <span className="action-dock-mode-hint">{helperHint}</span>}
          </div>
        )}

        {refs.length > 0 && (
          <div className="tablet-refs" role="list">
          {refs.map((ref, index) => (
            <span className="tablet-ref" role="listitem" key={ref.shapeId}>
              {ref.kind === 'video' ? <IconVideo size={24} /> : ref.kind === 'audio' ? <IconSound size={24} /> : ref.src && ref.kind !== 'text'
                ? <img src={previewSrc(ref.src)} alt="" />
                : <span className="tablet-ref-text">{ref.text?.slice(0, 40) ?? ref.label}</span>}
              <em className="tablet-ref-num">@{index + 1}</em>
              {manualRefs.some((manual) => manual.shapeId === ref.shapeId) && (
                <button
                  type="button"
                  className="tablet-ref-drop"
                  aria-label={t('Remove reference')}
                  onClick={() => setManualRefs((current) => current.filter((manual) => manual.shapeId !== ref.shapeId))}
                >
                  <IconClose size={11} />
                </button>
              )}
            </span>
          ))}
          <button
            type="button"
            className="ui-btn quiet tablet-ref-clear"
            onClick={() => {
              store.setSelection([])
              setManualRefs([])
            }}
          >
            Capture
          </button>
          </div>
        )}

        {shownError && (
          <InlineNotice
            className="tablet-error"
            tone="error"
            title={shownError}
            onDismiss={() => {
              setError(null)
              setDismissedModelRefusal(modelRefusal)
            }}
          />
        )}

        {readingAssistant && <button type="button" className="tablet-assistant-divider" aria-label={t('Resize response and input areas')} title={t('Drag to change input height')} {...assistantSplit.handle}><span /></button>}
        <div className={`tablet-composer ${tab === 'prompt' && multiImageBatch ? 'tablet-composer-batch' : ''}`} id="tablet-panel-prompt" role="region" aria-label={t('Make')}>
          <div className="tablet-input-shell">
          <textarea
            ref={textareaRef}
            className="ui-field tablet-input"
            aria-label={tab === 'assistant' ? t('Question for assistant') : t('Prompt')}
            value={prompt}
            placeholder={
              readOnly
                ? t('Board is open on another device')
                : tab === 'assistant' ? 'Ask assistant…' : 'What should we create?'
            }
            rows={composerLayout.rows}
            style={{
              minHeight: composerLayout.minHeight,
              maxHeight: readingAssistant ? assistantComposerHeight : fieldMaxHeight,
            } as CSSProperties}
            disabled={readOnly}
            readOnly={!typingArmed}
            onFocus={() => setExpanded(true)}
            onChange={(event) => setPrompt(event.target.value)}
          />
          {expanded && (
            <button
              type="button"
              className={`ui-btn quiet icon-only tablet-input-expand ${largeEditor ? 'on' : ''}`}
              aria-label={largeEditor ? t('Collapse editor') : t('Expand editor')}
              aria-pressed={largeEditor}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setLargeEditor((current) => !current)
              }}
            >
              {largeEditor ? <IconCollapse size={19} /> : <IconFitAll size={19} />}
            </button>
          )}
          </div>
          {tab === 'prompt' && kind === 'image' && (
            <ActionDockBatchSwitch
              mode={batchMode}
              onChange={setBatchMode}
              imageCount={actionBatchPreview.admission.imageCount}
              jobs={actionBatchPreview.jobs}
              disabled={readOnly || !ready}
            />
          )}
          {tab === 'assistant' ? (
          activeAnswer ? (
            <button
              type="button"
              className="ui-btn tablet-create"
              onClick={() => promptChatStore.cancel(promptChatProjectId, activeAnswer)}
            >

              {t('Stop')}
            </button>
          ) : (
            <button
              type="button"
              className="ui-btn primary tablet-create paid-action"
              aria-label={tabletActionText('Ask', chatEstimate?.costUsd ?? null, 3)}
              disabled={!prompt.trim() || chat.boardMemorySaving}
              // ⚠️ Без этого кнопка НЕ СРАБАТЫВАЕТ, пока открыта клавиатура:
              // нажатие уводит фокус из поля, iPad убирает клавиатуру, полка
              // тут же переезжает вниз на её высоту — и `click` приходит уже
              // не на кнопку (жалоба 14.09.2026 «помощник не реагирует»).
              // Тот же приём, что у остальных кнопок этой полки.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => void ask()}
            >
              <span className="tablet-action-label paid-action-label">{t('Ask')}</span>
              <PriceBadge
                amount={chatEstimate?.costUsd ?? null}
                precision={3}
                title={t('Approximate response cost')}
                variant="action"
              />
            </button>
          )
        ) : helperPreparing ? (
          <button
            type="button"
            className="ui-btn quiet tablet-create"
            onClick={() => {
              helperAbortRef.current?.abort()
            }}
          >

            {t('Stop')}
          </button>
        ) : (
          <button
            type="button"
            className="ui-btn primary tablet-create paid-action"
            aria-label={tabletActionText(createLabel, displayedPrice, 2, displayModel?.pricingMode, displayModel?.meteredUncapped)}
            disabled={busy || readOnly}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void submit()}
          >
            <span className="tablet-action-label paid-action-label">{createLabel === 'Generate' ? t('Generate') : createLabel}</span>
            {displayedPrice != null && (
              <PriceBadge
                amount={displayedPrice}
                precision={2}
                title={priceBadgeTitle(displayModel)}
                pricingMode={displayModel?.pricingMode}
                meteredUncapped={displayModel?.meteredUncapped}
                variant="action"
              />
            )}
          </button>
          )}
        </div>

        {tab === 'prompt' && (
          <TabletPromptOptionRows
          controls={(
            <>
              <div className="ui-toggle tablet-kinds" role="radiogroup" aria-label={t('What are we creating')}>
                {KINDS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="radio"
                    aria-label={entry.label}
                    title={entry.label}
                    aria-checked={kind === entry.id}
                    className={kind === entry.id ? 'on' : ''}
                    onClick={() => {
                      if (kind === entry.id) return
                      setKind(entry.id)
                      resetForKind(entry.id)
                      setCount(1)
                    }}
                  >
                    {entry.icon}
                  </button>
                ))}
              </div>

              {kind === 'image' && (
                <div className="ui-toggle tablet-count" role="group" aria-label={t('Number of variants')}>
                  {[1, 2, 3, 4].map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={count === value}
                      className={count === value ? 'on' : ''}
                      onClick={() => setCount(value)}
                    >
                      {value}×
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          macros={<TabletMacros store={store} projectId={projectId} projectSource={projectSource} disabled={readOnly} />}
          />
        )}
        </>
        )}
      </div>

      {settingsOpen && tab === 'prompt' && (
        <div
          id="tablet-settings-pop"
          ref={settingsPopRef}
          className={`tablet-settings-pop ${settingsPlacement === 'viewport-top' ? 'viewport-top' : ''}`}
          role="dialog"
          aria-label={t('Model and parameters')}
          style={{
            ...(settingsTop == null ? {} : { '--tablet-settings-top': `${settingsTop}px` }),
            ...(settingsMaxHeight == null ? {} : { '--tablet-settings-max-height': `${settingsMaxHeight}px` }),
          } as CSSProperties}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="tablet-settings-pop-head">
            <strong>{t('Model and parameters')}</strong>
            <button
              type="button"
              className="ui-btn quiet icon-only tablet-settings-pop-close"
              aria-label={t('Close model and parameters')}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => setSettingsVisibility(false)}
            >
              <IconClose size={16} />
            </button>
          </div>
          <label className="tablet-field">
            <span>{t('Model')}</span>
            <select
              className="ui-field tablet-model-select"
              value={isAutoModelId(modelId) ? AUTO_MODEL_ID : modelId ?? ''}
              aria-label={t('Model')}
              onChange={(event) => chooseModel(event.target.value)}
            >
              <option value={AUTO_MODEL_ID}>
                {localizedAutoModelLabel}
              </option>
              {modelId && !isAutoModelId(modelId) && !pickable.some(model => model.id === modelId) && <option value={modelId} disabled>{models.find(model => model.id === modelId)?.name ?? modelId}{t(' · saved choice')}</option>}
              {pickable.map((model) => (
                <option key={model.id} value={model.id} disabled={Boolean(executorCompatibilityError(model))}>{model.name}{executorCompatibilityError(model) ? t(' · update CanAI') : ''}</option>
              ))}
            </select>
          </label>
          {pricingNote && <p className="tablet-pricing-note" role="note">{pricingNote}</p>}
          {panel.length > 0 && (
            <ParamControls params={panel} values={params} onChange={updateParams} compact comfortable />
          )}
        </div>
      )}
    </section>
  )
}

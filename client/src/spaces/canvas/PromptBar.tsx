import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, type Macro } from '../../api'
import type { GenRef, Job, JobKind, ProjectSource, ServerStatus } from '../../types'
import { IconCombine, IconCopy, IconEdit, IconGenerate, IconImage, IconLLM, IconSound, IconStop, IconVideo, IconTrash, IconCollapse, IconMinus, IconMemory } from '../../ui/icons'
import { usePromptCollapse } from './usePromptCollapse'
import { useT } from '../../i18n/context.js'
import { PriceBadge } from '../../ui/PriceBadge'
import { priceBadgeTitle } from '../../ui/quotePresentation'
import { useCompactLayout } from '../../ui/useCompactLayout'
import { onSettingsSaved, openSettings } from '../../settings/settingsBus'
import { onImageEditRequest } from './editorBus'
import { askConfirm } from '../../ui/confirmBus'
import {
  trackFailedGeneration,
  type GenerationRetryDescriptor,
} from './generationRegistry'
import { createGenerationLaunch, launchGenerationVariants } from './generationLaunches'
import { shouldAskLocalCostConfirmation } from './generationEstimate'
import { canGenerate, canStartGeneration } from './generationAvailability'
import { startServerStatusMonitor } from './serverStatusMonitor'
import { acceptsImageReference, panelParams, useCatalogModels } from './genOptions'
import { isAutoModelId, selectableModelId } from './smartModelSelection'
import {
  registerGenerationComposer,
  type GenerationComposerRequest,
} from './generationComposerBus'
import { PromptComposerField } from './PromptComposerField'
import { promptPlaceholder } from './promptPlaceholder'
import { onAddPromptAsset } from './promptAssetBus'
import { onPromptFill } from './promptFillBus'
import { PromptMacros } from './PromptMacros'
import { AssistantShelf, AssistantShelfResizeGrip } from './AssistantShelf'
import { AssistantPresets } from './AssistantPresets'
import { askAssistant, recordAssistantScenarioInput } from './assistantAsk'
import { assistantScenarioInput } from './assistantScenarioInput'
import { clampShelfHeight } from './assistantShelfHeight'
import { boardMemoryToggleShown, promptChatStore } from './promptChatStore'
import { usePromptDraft } from './continuity/usePromptDraft'
import { draftModelCatalog } from './continuity/sessionDraftModel'
import {
  draftFromComposer,
  refsFromConversationDraft,
  resolvePromptEnterAction,
} from './promptChatComposer'
import { pendingDiscussDraftToRestore } from './promptChatDraftRestore'
import { registerPromptChatDropHandler } from './promptChatDropBus'
import { composerReferenceView } from './composerReferenceView'
import { PromptNotices } from './PromptNotices'
import { PromptSettingsRow } from './PromptSettingsRow'
import { PromptSettingsSection } from './PromptSettingsSection'
import { withoutPromptAspectPersistence } from './modelAspect'
import { ReferenceChips } from './ReferenceChips'
import { shortText } from './RefChip'
import {
  clampMentionIndex,
  detectReferenceMention,
  insertReferenceTag,
  mediaReferences,
  referenceMentionCandidates,
  replaceComposerReference,
  removeComposerReference,
} from './referenceComposer'
import type { CanvasStore } from './konva/canvasStore'
import { isGifReference, toGenRefs, type SelectionRef } from './konva/selection'
import type { PinnedAsset, Placeholder } from './konva/types'
import { exportImageWithSketch } from './konva/sketchExport'
import { useSelectionRefs } from './konva/useStore'
import { getSketchTarget, onSketchTarget, setSketchTarget } from './sketchBus'
import { useExternalEdit } from './useExternalEdit'
import { useGeneration, type GenerationPreparation } from './useGeneration'
import { useAssistantPanel } from './useAssistantPanel'
import { useModelSelection } from './useModelSelection'
import { usePromptInputSize } from './usePromptInputSize'
import { usePromptTextHistory } from './usePromptTextHistory'
import { createPromptTargetHandlers, registerPromptOnboardingTargets, showOnboardingTarget } from './onboardingTargets'
import { announce } from '../../ui/announce'
import { reportOnboardingSuccess } from './onboardingEvents'
import { projectKey } from '../../projects/projectRef'
import {
  ActionDockModeTabs,
  actionDockCreateLabel,
  type ActionDockMode,
} from './ActionDock'
import type { ActionBatchMode } from './actionDockBatch'
import {
  dockAttemptConsentInput,
  dockLeadRefs,
  planDockLaunch,
  type DockLaunchState,
} from './actionDockLaunch'
import { assistantAggregateEstimatedCost, planAssistantCanvasLaunch } from './assistantCanvasLaunch'
import { zoomToBounds } from './konva/cameraOps'
import { animateCamera } from './konva/cameraAnimation'
import { useDockHelperRuns } from './useDockHelperRuns'
import {
  dockHelperEligibility,
  dockHelperHint,
  helperInstruction,
  helperSampleRefs,
  helperEstimateUsd,
  preparedPromptProblem,
  applyPreparedPrompt,
  helperLaunchConfirmation,
} from './dockHelper'
import { executeDockHelperRun } from './dockHelperRun'
import { canvasActionTransport } from './canvasActionTransport'
import type { AssistantSelectionInfo } from './AssistantPresets'


// Типы генерации на канвасе: картинка, видео и звук. Текста здесь нет — он
// уехал в помощника, и ветка kind === 'text' была недостижимой, поэтому тип
// сужен намеренно: такую ветку не даст написать компилятор. «other» (SAM и
// т.п.) живёт только в нодах.
type CanvasKind = 'image' | 'video' | 'audio'

import {
  buildPendingGenerationMetadata,
  handleSettledCanvasGeneration,
} from './canvasGenerationSettle'


// Реэкспорт ради прежних импортов: доставка результата переехала в свой
// модуль, чтобы ею мог пользоваться и планшет, где промпт-бара нет.
export {
  buildPendingGenerationMetadata,
  handleSettledCanvasGeneration,
  hasUsedGenerationReferences,
  settleCanvasGeneration,
} from './canvasGenerationSettle'


interface ReferenceReplacementSession {
  targetShapeId: string
  baseRefs: SelectionRef[]
  baselineSelectionKey: string
}

function assetToRef(a: PinnedAsset): SelectionRef {
  if (a.kind === 'text') return { shapeId: `asset:${a.slot}`, kind: 'text', label: a.text || "text", text: a.text }
  return { shapeId: `asset:${a.slot}`, kind: a.kind, label: a.name || (a.kind === 'video' ? "video" : "image"), src: a.src, ...(a.mime ? { mime: a.mime } : {}), w: a.width, h: a.height }
}

export function PromptBar({
  store,
  projectId,
  projectSource = 'local',
  projectName,
  ready,
  chatOpen,
  onChatOpenChange,
}: {
  store: CanvasStore
  projectId: string
  projectSource?: ProjectSource
  /** Имя доски: у командной сеанс внешней правки берёт его только отсюда. */
  projectName?: string
  ready: boolean
  chatOpen: boolean
  onChatOpenChange(open: boolean): void
}) {
  const t = useT()
  const promptChatProjectId = projectKey({ source: projectSource, id: projectId })
  const compact = useCompactLayout()
  const [mode, setMode] = useState<ActionDockMode>(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('dockMode') === 'discuss') return 'discuss'
    return chatOpen ? 'discuss' : 'make'
  })
  const discussOpen = mode === 'discuss'
  const modeRef = useRef<ActionDockMode>(mode)
  const askingRef = useRef(false)
  modeRef.current = mode
  useEffect(() => {
    const next: ActionDockMode = chatOpen ? 'discuss' : 'make'
    if (modeRef.current !== next) {
      modeRef.current = next
      setMode(next)
    }
  }, [chatOpen])
  function changeMode(next: ActionDockMode): void {
    modeRef.current = next
    setMode(next)
    onChatOpenChange(next === 'discuss')
  }
  const [compactSettingsOpen, setCompactSettingsOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<CanvasKind>('image')
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  // null means «проверка ещё не завершилась», not «server is down». Keep the
  // first paint quiet until the monitor has either confirmed a response or
  // exhausted its retry grace window.
  const [serverStatusReady, setServerStatusReady] = useState(false)
  const generationAvailable = canGenerate(serverStatus, projectSource)
  const [localError, setLocalError] = useState<string | null>(null)
  const [sketchTarget, setSketchTargetState] = useState<string | null>(getSketchTarget())
  const subscribePromptChat = useCallback(
    (listener: () => void) => promptChatStore.subscribe(promptChatProjectId, listener),
    [promptChatProjectId],
  )
  const getPromptChatSnapshot = useCallback(
    () => promptChatStore.getSnapshot(promptChatProjectId),
    [promptChatProjectId],
  )
  const promptChatSnapshot = useSyncExternalStore(
    subscribePromptChat,
    getPromptChatSnapshot,
    getPromptChatSnapshot,
  )

  // опции генерации: модель, размер/пропорции, количество (как в Krea/Mixboard)
  const { models, defaults, catalogError, retryCatalog } = useCatalogModels(projectSource)
  const generationReady = canStartGeneration(serverStatus, models.length > 0, projectSource)
  const [count, setCount] = useState(1)
  const [batchMode, setBatchMode] = useState<ActionBatchMode>('together')
  const [confirmCostAboveUsd, setConfirmCostAboveUsd] = useState(1)
  // автокомплит inline-ссылок на референсы: печать «@» открывает список
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const promptDockRef = useRef<HTMLDivElement>(null)
  const { collapsed: panelCollapsed, toggle: togglePanel, expand: expandPanel } = usePromptCollapse(promptDockRef)
  const referenceChipsRef = useRef<HTMLDivElement>(null)
  const [mention, setMention] = useState<{
    query: string
    index: number
    start: number
  } | null>(null)

  // История поля для Ctrl+Z / Ctrl+Y живёт отдельным модулем (чистая логика +
  // тонкая обвязка): здесь она занимала полсотни строк посреди всего прочего.
  const { push: pushPromptHistory, undo: handleUndo, redo: handleRedo } =
    usePromptTextHistory(setPrompt)

  // размер поля (автовысота + тяга за верхнюю кромку) — отдельный хук
  const { isFocused, setIsFocused, startResize: startPromptResize, adjustHeight } =
    usePromptInputSize({ textareaRef, prompt, chatOpen: discussOpen })


  useEffect(() => {
    const statusMonitor = startServerStatusMonitor({
      read: api.status,
      publish: setServerStatus,
      onReady: () => setServerStatusReady(true),
    })
    window.addEventListener('online', statusMonitor.refresh)
    window.addEventListener('focus', statusMonitor.refresh)
    api.getSettings().then((settings) => setConfirmCostAboveUsd(settings.confirmCostAboveUsd)).catch(() => {})
    // после сохранения настроек статус перечитывается — баннер мок-режима
    // гаснет сразу после ввода ключа, без перезагрузки страницы
    const unsubscribe = onSettingsSaved(() => {
      statusMonitor.refresh()
      api.getSettings().then((settings) => setConfirmCostAboveUsd(settings.confirmCostAboveUsd)).catch(() => {})
    })
    return () => {
      unsubscribe()
      statusMonitor.dispose()
      window.removeEventListener('online', statusMonitor.refresh)
      window.removeEventListener('focus', statusMonitor.refresh)
    }
  }, [])

  useEffect(() => onSketchTarget(setSketchTargetState), [])

  // референсы = выделение канваса + вручную добавленные из полки ассетов
  const selRefs = useSelectionRefs(store)
  const [manualRefs, setManualRefs] = useState<SelectionRef[]>([])
  const manualRefsRef = useRef<SelectionRef[]>([])
  manualRefsRef.current = manualRefs
  const [replacementSession, setReplacementSessionState] = useState<ReferenceReplacementSession | null>(null)
  const replacementSessionRef = useRef<ReferenceReplacementSession | null>(null)
  const promptAssetHandlerRef = useRef<(ref: SelectionRef) => void>(() => {})
  function setReplacementSession(next: ReferenceReplacementSession | null): void {
    replacementSessionRef.current = next
    setReplacementSessionState(next)
  }
  const canvasComposerRef = useRef<{
    projectId: string
    prompt: string
    refs: SelectionRef[]
  }>({ projectId, prompt: '', refs: [] })
  // Discuss can open before the first local conversation finishes loading.
  // Keep edits made in that small window until an active conversation exists;
  // otherwise the empty server draft would overwrite the visible composer.
  const pendingDiscussDraftRef = useRef<ReturnType<typeof draftFromComposer> | null>(null)
  const previousChatOpenRef = useRef(false)
  const previousConversationRef = useRef<string | null>(null)
  useEffect(() => {
    onAddPromptAsset((ref) => promptAssetHandlerRef.current(ref))
    return () => onAddPromptAsset(null)
  }, [])

  // При смене проекта очищаем ручные референсы и текст промпта
  useEffect(() => {
    setPrompt('')
    setManualRefs([])
    setBatchMode('together')
    setReplacementSession(null)
    canvasComposerRef.current = { projectId, prompt: '', refs: [] }
    pendingDiscussDraftRef.current = null
  }, [projectId, projectSource])

  useEffect(() => {
    const activeId = promptChatSnapshot.activeId
    const wasOpen = previousChatOpenRef.current
    const previousId = previousConversationRef.current
    const pending = promptChatSnapshot.active
      ? pendingDiscussDraftToRestore({
          pending: pendingDiscussDraftRef.current,
          wasOpen,
          previousConversationId: previousId,
          activeConversationId: activeId,
        })
      : null
    if (pending) {
      pendingDiscussDraftRef.current = null
      void promptChatStore.patchDraft(promptChatProjectId, pending).catch((error) => {
        setLocalError(error instanceof Error ? error.message : "Failed to save draft")
      })
    }
    if (discussOpen) {
      setReplacementSession(null)
      if (!wasOpen) {
        canvasComposerRef.current = {
          projectId,
          prompt,
          refs: manualRefs.map((ref) => ({ ...ref })),
        }
      }
      if ((!wasOpen || previousId !== activeId) && promptChatSnapshot.active) {
        const draft = pending ?? promptChatSnapshot.active.meta.draft
        setPrompt(draft.text)
        setManualRefs(refsFromConversationDraft(draft))
        requestAnimationFrame(() => {
          const textarea = textareaRef.current
          if (!textarea) return
          textarea.focus()
          textarea.setSelectionRange(draft.selectionStart, draft.selectionEnd)
        })
      }
    } else if (wasOpen) {
      const saved = canvasComposerRef.current.projectId === projectId
        ? canvasComposerRef.current
        : { projectId, prompt: '', refs: [] }
      setPrompt(saved.prompt)
      setManualRefs(saved.refs.map((ref) => ({ ...ref })))
    }
    previousChatOpenRef.current = discussOpen
    previousConversationRef.current = activeId
  }, [discussOpen, promptChatSnapshot.activeId, projectId, projectSource])

  // Храним хронологический порядок выделения/добавления shapeId
  const orderedIdsRef = useRef<string[]>([])
  const lastProjectIdRef = useRef(projectId)
  if (lastProjectIdRef.current !== projectId) {
    lastProjectIdRef.current = projectId
    orderedIdsRef.current = []
  }

  // Что показываем чипами и отправляем на сервер — чистая функция с тестами:
  // порядок @-ссылок обязан совпадать с раскладкой image_urls на сервере, а во
  // время точечной замены чипы не должны шевелиться от нового выделения.
  const {
    order,
    refs,
    composerRefs,
    composerRefsKey,
    mediaRefs,
    textRefs,
    replacementTarget,
    replacementMediaNumber,
  } = composerReferenceView({
    chatOpen: discussOpen,
    selRefs,
    manualRefs,
    previousOrder: orderedIdsRef.current,
    replacement: replacementSession,
    // In image/every mode each selected shape is an independent source even
    // when two cards happen to reuse one media URL. Together mode keeps the
    // historical content de-duplication so one source is not sent twice.
    preserveContentDuplicates: kind === 'image',
  })
  orderedIdsRef.current = order
  const refsRef = useRef(composerRefs)
  refsRef.current = composerRefs
  const imageRefCount = mediaRefs.length


  // хук сам следит за текстом и своими состояниями; снаружи остаются только
  // причины, от которых меняется высота БАРА вокруг поля
  useEffect(() => {
    adjustHeight()
  }, [kind, mediaRefs.length, adjustHeight])

  /**
   * ⚠️ Текст, который человек НАПИСАЛ САМ, переписывает ровно одно действие —
   * снятие чипа (см. removeRef). Раньше это делал эффект по составу
   * референсов: пропал медиа-референс — @-ссылки в промпте молча
   * перенумеровывались. Но набор чипов зеркалит выделение канваса, а оно
   * пропадает не только по воле человека: сетевая доска перечитывает снимок
   * при каждом переподключении (store.loadDoc сбрасывает выделение), и клик
   * по пустому месту тоже снимает всё. Жалоба 08.09.2026: промпт «сделай фото
   * @1 в профиль, нос возьми от сюда @2» ушёл в оплаченную генерацию как
   * «сделай фото в профиль, нос возьми от сюда @1» — чипы к тому моменту были
   * на месте, и понять, что случилось, со стороны нельзя вовсе.
   * Дословный @-тег без своего референса безвреден: сервер его либо
   * переведёт, либо уберёт (applyRefTags).
   */

  function beginReferenceReplacement(ref: SelectionRef): void {
    if (discussOpen) return
    setLocalError(null)
    setReplacementSession({
      targetShapeId: ref.shapeId,
      baseRefs: refsRef.current.map((item) => ({ ...item })),
      baselineSelectionKey: selRefs.map((item) => item.shapeId).join(','),
    })
  }

  function cancelReferenceReplacement(): void {
    setReplacementSession(null)
    setLocalError(null)
  }

  function finishReferenceReplacement(nextRefs: SelectionRef[]): void {
    // Смена shapeId в первом слоте иначе выглядит для syncActiveReferences как
    // «старый удалён, новый добавлен» и новый уезжает в конец. Фиксируем слоты
    // явно: @1 обязана остаться @1, поменялся только объект под ней.
    orderedIdsRef.current = nextRefs.map((ref) => ref.shapeId)
    autoFilledIdRef.current = null
    autoFilledPromptRef.current = ''
    setManualRefs(nextRefs.map((ref) => ({ ...ref })))
    setReplacementSession(null)
    store.clearSelection()
    setLocalError(null)
  }

  function commitReferenceReplacement(replacement: SelectionRef): void {
    const session = replacementSessionRef.current
    if (!session) return
    const result = replaceComposerReference(
      session.baseRefs,
      session.targetShapeId,
      replacement,
    )
    if (result.status === 'missing') {
      setReplacementSession(null)
      setLocalError("The reference to replace is no longer available.")
      return
    }
    if (result.status === 'kind-mismatch') {
      setLocalError(
        replacement.kind === 'text'
          ? "A media reference can only be replaced with an image or video."
          : "A text reference can only be replaced with another text reference.",
      )
      return
    }
    if (result.status === 'duplicate') {
      const duplicate = result.refs[result.duplicateIndex]
      const duplicateNumber = duplicate.kind === 'text'
        ? null
        : mediaReferences(result.refs.slice(0, result.duplicateIndex + 1)).length
      setLocalError(
        duplicateNumber
          ? `This object is already used as a reference ${duplicateNumber}.`
          : "This text is already used as a reference.",
      )
      return
    }
    finishReferenceReplacement(result.refs)
  }

  promptAssetHandlerRef.current = (ref) => {
    if (replacementSessionRef.current) {
      commitReferenceReplacement(ref)
      return
    }
    setManualRefs((prev) => (
      prev.some((current) => current.shapeId === ref.shapeId)
        ? prev
        : [...prev, ref]
    ))
  }

  useEffect(() => {
    if (!replacementSession) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancelReferenceReplacement()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replacementSession])

  function persistChatDraft(
    text: string,
    nextRefs: SelectionRef[],
    selectionStart = text.length,
    selectionEnd = selectionStart,
  ): void {
    if (!discussOpen) return
    const draft = draftFromComposer(text, nextRefs, selectionStart, selectionEnd)
    if (!promptChatSnapshot.active) {
      pendingDiscussDraftRef.current = draft
      return
    }
    pendingDiscussDraftRef.current = null
    void promptChatStore.patchDraft(
      promptChatProjectId,
      draft,
    ).catch((error) => {
      setLocalError(error instanceof Error ? error.message : "Failed to save draft")
    })
  }

  function handleClearAll(): void {
    setReplacementSession(null)
    setPrompt('')
    setManualRefs([])
    if (discussOpen) {
      persistChatDraft('', [], 0, 0)
      setMention(null)
      return
    }
    store.clearSelection()
    autoFilledIdRef.current = null
    autoFilledPromptRef.current = ''
  }

  function handleClearAllPermanent(e: React.MouseEvent): void {
    e.preventDefault()
    setReplacementSession(null)
    setPrompt('')
    setManualRefs([])
    if (discussOpen) {
      persistChatDraft('', [], 0, 0)
      setMention(null)
      return
    }
    const selectedIds = store.getSelectedIds()
    for (const id of selectedIds) {
      if (!id.startsWith('asset:')) {
        store.updateItem(id, { prompt: undefined, referenceIds: undefined })
      }
    }
  }

  function removeRef(shapeId: string): void {
    if (replacementSessionRef.current?.targetShapeId === shapeId) {
      setReplacementSession(null)
    }
    // Человек убрал референс — значит @-ссылки на него в тексте больше не о
    // чем: убираем её и сдвигаем следующие. Это единственное место, где
    // приложение правит написанное человеком.
    const renumbered = removeComposerReference(refsRef.current, prompt, shapeId).text
    if (renumbered !== prompt) {
      setPrompt(renumbered)
      pushPromptHistory(renumbered, true)
    }
    if (discussOpen) {
      const nextRefs = manualRefs.filter((ref) => ref.shapeId !== shapeId)
      setManualRefs(nextRefs)
      const textarea = textareaRef.current
      persistChatDraft(
        renumbered,
        nextRefs,
        textarea?.selectionStart ?? renumbered.length,
        textarea?.selectionEnd ?? renumbered.length,
      )
      return
    }
    // Чип может держаться сразу двумя источниками: ручным списком (ассет с
    // полки или объект, бро́шенный на бар) и выделением на канвасе. Убираем из
    // обоих, иначе крестик «не срабатывает»: чип тут же возвращается из второго.
    if (manualRefs.some((ref) => ref.shapeId === shapeId)) {
      setManualRefs((prev) => prev.filter((r) => r.shapeId !== shapeId))
    }
    if (store.getSelectedIds().has(shapeId)) {
      store.setSelection([...store.getSelectedIds()].filter((id) => id !== shapeId))
    }
  }

  function insertTag(num: number): void {
    const textarea = textareaRef.current
    if (textarea) {
      const next = insertReferenceTag(
        textarea.value,
        textarea.selectionStart,
        textarea.selectionEnd,
        num,
      )
      setPrompt(next.text)
      pushPromptHistory(next.text, true)
      persistChatDraft(next.text, manualRefs, next.caret, next.caret)
      window.setTimeout(() => {
        textarea.focus()
        textarea.setSelectionRange(next.caret, next.caret)
      }, 0)
    } else {
      const current = promptRef.current
      const next = insertReferenceTag(current, current.length, current.length, num)
      setPrompt(next.text)
      pushPromptHistory(next.text, true)
      persistChatDraft(next.text, manualRefsRef.current, next.caret, next.caret)
    }
  }

  const { start, prepare, approvePreparedGenerationQuotes } = useGeneration(projectId, ready, (job, context) => {
    handleSettledCanvasGeneration(job, store, setLocalError, context)
  }, projectSource)

  // помощник: поле ввода одно на всё приложение, поэтому вопрос уходит отсюда же.
  // discussOpen === окно «Обсудить» вместо строки генерации.
  const {
    shelfHeight,
    setShelfHeight,
    dropActive,
    setDropActive,
    estimate: chatEstimate,
    activeAssistantId,
    signal,
    signalLabel,
  } = useAssistantPanel({
    projectId: promptChatProjectId,
    chatOpen: discussOpen,
    prompt,
    composerRefs,
    composerRefsKey,
    activeConversationId: promptChatSnapshot.activeId,
    hasConversation: Boolean(promptChatSnapshot.active),
    boardMemoryEnabled: promptChatSnapshot.boardMemoryEnabled,
    boardMemorySaving: promptChatSnapshot.boardMemorySaving,
    textareaRef,
  })

  // sessions/stopSession здесь больше не нужны: сообщения о внешних правках
  // ушли в общий угол (ExternalEditStatusHost), над холстом их больше нет
  const { notice, setNotice, startEdit } = useExternalEdit(projectId, projectSource, projectName)
  const startEditRef = useRef(startEdit)
  startEditRef.current = startEdit

  // двойной клик по картинке на канвасе (мостик через editorBus)
  useEffect(() => {
    onImageEditRequest((request) => void startEditRef.current(request))
    return () => onImageEditRequest(null)
  }, [])

  // F2 — открыть выделенную картинку во внешнем редакторе
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      e.preventDefault()
      const image = refsRef.current.find((r) => r.kind === 'image' && r.src)
      if (image?.src) {
        void startEditRef.current({ shapeId: image.shapeId, src: image.src, name: image.label })
      } else {
        setNotice("Select the picture on the canvas and press F2 to open it in the editor.")
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Параметры зависят от того, есть ли медиа-референс: выделение, ручной чип
  // или активный скетч (там референс собирается при отправке).
  const hasMediaRefs = refs.some((r) => r.kind !== 'text') || Boolean(sketchTarget)
  const mediaRefKey = refs.filter((r) => r.kind !== 'text').map((r) => r.shapeId).join(',')
  // Подбор модели видит референсы ПЕРВОГО запроса — те же, по которым ниже
  // строятся предпросмотр и запуск. Иначе в «Изменить каждое» ручки сверялись
  // бы под модель всего набора, а запускалась бы модель одного исходника.
  const leadRefsFor = useCallback(
    (nextKind: JobKind) => dockLeadRefs({ batchMode, refs: refsRef.current, sketchTarget }, nextKind),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [composerRefsKey, batchMode, sketchTarget],
  )

  // модель, её ручки и память настроек — отдельный хук
  const {
    modelId,
    setModelId,
    params,
    updateParams,
    chooseModel,
    resetForKind,
  } = useModelSelection({
    models,
    defaults,
    kind,
    hasMediaRefs,
    mediaRefKey,
    promptAspectSession: true,
    virtualAspectAuto: projectSource === 'cloud',
    smartAuto: { refsFor: leadRefsFor },
  })
  const [selectedAssistant, setSelectedAssistant] = useState<AssistantSelectionInfo>({
    id: null,
    versionId: null,
    name: "Universal",
    modelId: null,
  })
  const handleAssistantSelectionChanged = useCallback((selection: AssistantSelectionInfo) => {
    setSelectedAssistant(selection)
  }, [])

  const helperRuns = useDockHelperRuns({
    projectId,
    projectSource,
    mode,
  })

  const helperEligibility = dockHelperEligibility({
    kind,
    assistantId: selectedAssistant.id,
    imageRefsCount: composerRefs.filter((r) => r.kind === 'image' || !r.kind).length,
    hasPreparationCapability: generationAvailable,
  })
  const helperEstimate = helperEstimateUsd(models, selectedAssistant.modelId)
  const helperHint = dockHelperHint(mode, helperEligibility, helperEstimate)

  // Состояние дока для плана запуска. Предпросмотр и submit() строят план ОДНОЙ
  // функцией (planDockLaunch): ряд настроек, цена, согласие и платный запрос
  // говорят об одной и той же модели и одном числе задач. submit подставляет
  // сюда только замороженные копии того, что могло измениться за время запуска.
  const dockState: DockLaunchState = {
    projectRef: { source: projectSource, id: projectId },
    kind,
    models,
    defaults,
    modelId,
    batchMode,
    refs: composerRefs,
    prompt,
    count,
    params,
    sketchTarget,
    itemById: (id) => store.getItem(id),
    textPreparation: helperEligibility.eligible && selectedAssistant.id ? {
      assistantId: selectedAssistant.id,
      versionId: selectedAssistant.versionId ?? undefined,
    } : undefined,
  }
  const dockPreview = planDockLaunch(dockState)
  const actionBatchPreview = dockPreview.batch
  const displayRequest = actionBatchPreview.requests[0]
  // Показана модель первого запроса плана. Плана нет (набор не проходит) — на
  // виду остаются ручки модели из подбора, а цены нет: запускать нечего.
  const displayModel = displayRequest?.plan.model ?? dockPreview.selection.panelModel
  const displayPanel = panelParams(displayModel, hasMediaRefs, true, projectSource === 'cloud')
  const displayedGenerationPrice = actionBatchPreview.totalCost
  const createLabel = actionDockCreateLabel(kind, batchMode, sketchTarget ? 0 : actionBatchPreview.admission.imageCount)

  // Почему модель не берёт выбранный набор, видно ДО нажатия — тем же
  // сообщением, что и после него. Пока запускать нечего (промпта нет), молчим:
  // выделение ради раскладки объектов не должно зажигать ошибку под полем.
  const modelRefusal = mode === 'make' && ready && models.length > 0
    && (Boolean(prompt.trim()) || textRefs.length > 0)
    ? dockPreview.selection.error
    : null
  const [dismissedModelRefusal, setDismissedModelRefusal] = useState<string | null>(null)
  useEffect(() => {
    if (!modelRefusal) setDismissedModelRefusal(null)
  }, [modelRefusal])
  const shownError = localError ?? (modelRefusal !== dismissedModelRefusal ? modelRefusal : null)
  // Черновик сеанса сверяет сохранённую модель с каталогом этого устройства.
  const draftCatalog = useMemo(() => draftModelCatalog(models, defaults), [models, defaults])

  // смена типа подтягивает модель по умолчанию и её запомненные настройки
  function switchKind(next: CanvasKind): void {
    if (next === kind) return
    setKind(next)
    resetForKind(next)
    setCount(1)
  }

  // Черновик сеанса: набранный промпт, модель, параметры, счётчик и
  // референсы переезжают между устройствами вместе с доской. Всё, что для
  // этого нужно, — отдать хуку текущее состояние и способ его вернуть.
  usePromptDraft({
    projectId,
    projectSource,
    ready,
    canWrite: ready,
    modelsReady: models.length > 0,
    catalog: draftCatalog,
    state: {
      prompt,
      kind,
      modelId,
      params: withoutPromptAspectPersistence(params),
      count,
      pane: discussOpen ? 'assistant' : 'prompt',
      selection: selRefs.map((ref) => ref.shapeId),
      manualRefs,
    },
    apply: {
      setPrompt,
      applyKind: switchKind,
      setCount,
      chooseModel,
      setManualRefs,
      setSelection: (ids) => store.setSelection(ids),
    },
  })

  // при выделении видео на канвасе тип генерации сам переключается на «Видео»
  // (запрос пользователя) — только вперёд: убрал видео из выделения — тип
  // остаётся, где был (не дёргаем интерфейс на каждое снятие выделения)
  const selectionHasVideo = selRefs.some((r) => r.kind === 'video')
  useEffect(() => {
    if (selectionHasVideo) switchKind('video')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionHasVideo])

  // Гейт авто-заполнения: запоминаем для какого объекта заполняли промпт и какой текст,
  // чтобы сбросить именно его при снятии выделения (не затирать то, что юзер сам набрал)
  const autoFilledIdRef = useRef<string | null>(null)
  const autoFilledPromptRef = useRef('')
  const promptRef = useRef(prompt)
  promptRef.current = prompt
  const lastFillAtRef = useRef(0)

  // Подписка на явный запрос «заполни промпт» (двойной клик по объекту на канвасе).
  // Авто-заполнение при обычном выделении УБРАНО: промпт меняется только
  // по явному намерению пользователя (дабл-клик), не при каждом клике по объекту.
  useEffect(() => {
    return onPromptFill((request) => {
      lastFillAtRef.current = Date.now()
      const item = store.getItem(request.shapeId) || store.getPending().find((p) => p.id === request.shapeId)
      if (!item || !request.prompt) return
      autoFilledIdRef.current = request.shapeId
      autoFilledPromptRef.current = request.prompt
      setPrompt(request.prompt)
      if (request.modelId) {
        // На объекте мог остаться номер варианта («…-edit»): в списке его нет,
        // а запуск по нему без референса ушёл бы в ручку правки без входной
        // картинки. В док возвращается базовая модель.
        const restoredId = selectableModelId(models, request.modelId)
        const foundModel = restoredId ? models.find((m) => m.id === restoredId) : undefined
        // текстовые и служебные модели тумблера на канвасе не имеют — молча
        // переключаться в невидимый режим нельзя
        if (foundModel && (foundModel.kind === 'image' || foundModel.kind === 'video')) {
          setKind(foundModel.kind)
          setModelId(foundModel.id)
        }
      }
      if (request.referenceIds) {
        const assets = store.getAssets()
        const restoredRefs: SelectionRef[] = []
        for (const refId of request.referenceIds) {
          if (refId.startsWith('asset:')) {
            const slotStr = refId.split(':')[1]
            const slot = parseInt(slotStr, 10)
            if (!isNaN(slot)) {
              const asset = assets.find((a) => a.slot === slot)
              if (asset) {
                restoredRefs.push(assetToRef(asset))
              }
            }
          }
        }
        setManualRefs(restoredRefs)
      } else {
        setManualRefs([])
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, models])

  // Сброс авто-заполненного промпта при РЕАЛЬНОМ изменении выделения.
  // useSelectionRefs возвращает новый массив каждый рендер → useEffect([selRefs]) стреляет
  // при каждом рендере. Поэтому зависимость — стабильная СТРОКА из id-шников.
  // Временная метка lastFillAtRef: dblclick заполняет промпт и тут же снимает выделение
  // в одном батче. Если с момента fill прошло < 200ms — это dblclick, не сбрасываем.
  const selKey = selRefs.map((r) => r.shapeId).join(',')

  useEffect(() => {
    if (replacementSessionRef.current) return
    // Если с момента dblclick-заполнения прошло меньше 200ms — не сбрасываем промпт,
    // в том числе при наличии нескольких референсов (selKey содержит запятую)
    if (Date.now() - lastFillAtRef.current <= 200) {
      return
    }
    if (!selKey || selKey.includes(',')) {
      if (autoFilledIdRef.current && promptRef.current === autoFilledPromptRef.current) {
        setPrompt('')
      }
      autoFilledIdRef.current = null
      autoFilledPromptRef.current = ''
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey])

  useEffect(() => {
    const session = replacementSessionRef.current
    if (!session || selKey === session.baselineSelectionKey || selRefs.length === 0) return
    if (selRefs.length !== 1) {
      setLocalError("Select one object for a targeted replacement.")
      return
    }
    commitReferenceReplacement(selRefs[0])
    // selRefs создаётся заново на каждом рендере; достаточно стабильного ключа.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey])


  async function submit(override?: GenerationComposerRequest): Promise<void> {
    if (modeRef.current !== 'make') return
    if (!ready) return
    if (!generationAvailable) {
      setLocalError(projectSource === 'cloud'
        ? "Generation is not available: connect to the team server in the settings."
        : "Generation is not available: add the fal.ai key in the settings.")
      return
    }
    if (!generationReady) {
      setLocalError("Generation is not available: wait for the model catalog or click “Repeat”.")
      return
    }

    // Freeze both text and refs before any frame extraction, upload, quote or
    // generation request. A new selection while the request is preparing must
    // never alter the paid request that the user just admitted.
    // Без подсказки помощника уходит ровно то, что показано чипами: по тем же
    // референсам построены предпросмотр, цена и согласие.
    const launchState: DockLaunchState = {
      ...dockState,
      refs: (override?.refs ?? composerRefs).map((ref) => ({ ...ref })),
      prompt: override?.prompt ?? prompt,
      params: structuredClone(params),
      sketchTarget: override ? null : sketchTarget,
    }
    const activeSketchTarget = launchState.sketchTarget
    const launchPlan = planDockLaunch(launchState)
    const batch = launchPlan.batch
    if (batch.admission.error) {
      if (!override && batch.admission.error === modelRefusal) {
        // Отказ подбора модели уже стоит под полем и уйдёт сам, когда набор
        // изменится. Закреплять его копией незачем — только вернуть на глаза.
        setLocalError(null)
        setDismissedModelRefusal(null)
      } else {
        setLocalError(batch.admission.error)
      }
      return
    }
    if (batch.requests.length === 0 || batch.requests.some((request) => !request.plan.text)) return
    if (batch.requests.some((request) => (
      request.plan.refsToSend.some(isGifReference) && !acceptsImageReference(request.plan.model)
    ))) {
      setLocalError("This model does not accept GIF images. Select a model with a reference picture or remove the GIF.")
      return
    }
    setLocalError(null)

    const estimatedCost = batch.totalCost
    const firstPlan = batch.requests[0]?.plan
    const helperActive = Boolean(helperEligibility.eligible && selectedAssistant.id)
    const helperCost = helperActive && estimatedCost !== null ? estimatedCost + helperEstimate : helperEstimate
    const helperConf = helperActive && estimatedCost !== null && selectedAssistant.id
      ? helperLaunchConfirmation(
          firstPlan?.model?.name ?? "default",
          selectedAssistant.name || "Assistant",
          helperEstimate,
          estimatedCost,
          batch.jobs,
        )
      : null
    const costToCheck = helperActive ? helperCost : estimatedCost
    // Дешёвое уходит молча — вопрос перед каждым запуском мешал бы сериям.
    // Для «Изменить каждое» здесь одна aggregate-проверка до создания всех
    // рядов; отмена не оставляет призрачных карточек.
    if (costToCheck !== null && shouldAskLocalCostConfirmation(
      projectSource, Boolean(serverStatus?.falConfigured), costToCheck, confirmCostAboveUsd,
    )) {
      if (compact) setCompactSettingsOpen(true)
      const rows: Array<[string, string]> = helperConf
        ? helperConf.rows
        : [
            ["Model", firstPlan?.model?.name ?? "default"],
            ["Tasks", `${batch.jobs}`],
          ]
      const title = helperConf ? helperConf.title : `Run for $${costToCheck.toFixed(2)}?`
      const confirmLabel = helperConf ? helperConf.confirmLabel : `Run for $${costToCheck.toFixed(2)}`
      const ok = await askConfirm({
        title,
        rows,
        confirmLabel,
      })
      if (!ok) {
        setLocalError("Run cancelled.")
        return
      }
      if (modeRef.current !== 'make') return
    }

    let effectiveBatch = batch
    if (helperActive && selectedAssistant.id) {
      const runId = `prep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const controller = new AbortController()
      helperRuns.registerRun(runId, controller, selectedAssistant.name || "Assistant")

      const sampleRefs = helperSampleRefs(composerRefs, launchPlan.mode)
      let sampleGenRefs: GenRef[] = []
      try {
        sampleGenRefs = await toGenRefs(sampleRefs, 'image')
      } catch (err) {
        helperRuns.unregisterRun(runId)
        setLocalError(err instanceof Error ? err.message : "Failed to prepare references.")
        return
      }
      const instruction = helperInstruction(
        launchState.prompt,
        launchState.refs.filter((r) => r.kind === 'text'),
      )
      const imageGenRefs = sampleGenRefs.filter((r): r is { kind: 'image'; src: string; assetId?: string; width?: number; height?: number; role?: string } => r.kind === 'image')

      const runResult = await executeDockHelperRun({
        projectRef: { source: projectSource, id: projectId },
        prompt: instruction,
        refs: imageGenRefs,
        assistantId: selectedAssistant.id,
        profileVersionId: selectedAssistant.versionId ?? undefined,
        idempotencyKey: runId,
        transport: canvasActionTransport,
        signal: controller.signal,
        isCurrentScope: () => modeRef.current === 'make' && lastProjectIdRef.current === projectId,
        askConfirm: async (params) => {
          return askConfirm({
            title: params.title,
            rows: params.rows,
            confirmLabel: params.confirmLabel,
          })
        },
        expectedEstimateUsd: helperEstimate,
      })

      helperRuns.unregisterRun(runId)

      if (runResult.status === 'cancelled') {
        setLocalError("Run cancelled.")
        return
      }
      if (runResult.status === 'stale') {
        return
      }
      if (runResult.status === 'error') {
        setLocalError(`The assistant did not prepare the request - nothing was launched: ${runResult.error}`)
        return
      }

      const problem = preparedPromptProblem(runResult.prompt, launchPlan.mode, sampleRefs.length)
      if (problem) {
        setLocalError(`The assistant did not prepare the request - nothing was launched: ${problem}`)
        return
      }

      effectiveBatch = applyPreparedPrompt(batch, runResult.prompt)
    }

    type PendingBatch = {
      request: (typeof effectiveBatch.requests)[number]
      launch: ReturnType<typeof createGenerationLaunch>
      slots: string[]
      genRefs?: Awaited<ReturnType<typeof toGenRefs>>
      retry?: GenerationRetryDescriptor
    }
    const pendingBatches: PendingBatch[] = []
    try {
      // Every placeholder is committed synchronously before the first async
      // media conversion or cloud preflight. If the selection changes now,
      // these rows still belong to the frozen request below.
      for (const request of effectiveBatch.requests) {
        const plan = request.plan
        const n = plan.jobs
        const launch = createGenerationLaunch({
          variantCount: n,
          projectId,
          promptPreview: plan.text.trim().slice(0, 120),
          modelId: plan.model?.id,
          modelName: plan.model?.name ?? "Generation",
          estimatedTotalCostUsd: request.estimatedCost ?? undefined,
          createdAt: Date.now(),
        })
        const slots = store.addPendingRow(n, {
          kind,
          label: plan.model?.name ?? "Generation",
          anchorIds: plan.anchorIds.length > 0 ? plan.anchorIds : undefined,
          aspect: plan.aspect,
          prompt: plan.text,
          // На карточке и объекте — модель ИЗ СПИСКА: по ней строка сведений,
          // подписи сравнения и возврат модели в док двойным кликом. Номер
          // варианта («…-edit») в списке выбрать нельзя. В запрос, котировку и
          // описание повтора ниже идёт сама запускаемая модель.
          modelId: (request.baseModel ?? plan.model)?.id ?? undefined,
          referenceIds: request.refs.map((ref) => ref.shapeId),
          usedReferences: false,
          launch,
        })
        pendingBatches.push({ request, launch, slots })
      }

      await Promise.all(pendingBatches.map(async (entry) => {
        const plan = entry.request.plan
        const genRefs = activeSketchTarget
          ? [{
              kind: 'image' as const,
              src: await exportImageWithSketch(
                store,
                activeSketchTarget,
                store.getItem(activeSketchTarget)?.src ?? '',
              ),
            }]
          : await toGenRefs(plan.refsToSend, kind)
        entry.genRefs = genRefs
        const genParams = Object.keys(plan.params).length ? plan.params : undefined
        const retry: GenerationRetryDescriptor = {
          kind,
          prompt: plan.text,
          refs: structuredClone(genRefs),
          model: plan.model?.id ?? undefined,
          params: genParams ? structuredClone(genParams) : undefined,
          projectRef: { source: projectSource, id: projectId },
        }
        entry.retry = retry
        for (const slotId of entry.slots) {
          store.updatePending(slotId, {
            usedReferences: genRefs.length > 0,
            retry,
          }, { system: true })
        }
      }))
      if (modeRef.current !== 'make') {
        for (const entry of pendingBatches) {
          for (const slotId of entry.slots) store.failPendingById(slotId, "Run cancelled.")
        }
        return
      }

      const results = await Promise.all(pendingBatches.map(async (entry) => {
        const plan = entry.request.plan
        const genRefs = entry.genRefs ?? []
        const genParams = Object.keys(plan.params).length ? plan.params : undefined
        const retry = entry.retry ?? {
          kind,
          prompt: plan.text,
          refs: structuredClone(genRefs),
          model: plan.model?.id ?? undefined,
          params: genParams ? structuredClone(genParams) : undefined,
          projectRef: { source: projectSource, id: projectId },
        }
        return launchGenerationVariants({
          slots: entry.slots,
          launch: entry.launch,
          ...(projectSource === 'cloud' ? {
            prepare: (variant, slotId) => prepare(
              kind,
              plan.text,
              genRefs,
              plan.model?.id ?? undefined,
              genParams,
              slotId,
              dockAttemptConsentInput({
                projectRef: launchState.projectRef,
                kind,
                mode: launchPlan.mode,
                request: entry.request,
                genRefs,
                mediaTransferConsent: true,
              }),
            ),
            approve: approvePreparedGenerationQuotes,
          } : {}),
          start: (variant, slotId, prepared) => start(
            kind,
            plan.text,
            genRefs,
            plan.model?.id ?? undefined,
            genParams,
            variant,
            slotId,
            prepared as GenerationPreparation | undefined,
          ),
          recordFailure: (variant, message) => trackFailedGeneration(
            { kind: 'canvas', projectId },
            kind,
            retry,
            variant,
            message,
          ),
          bindJob: (slotId, jobId) => store.setPendingJob(slotId, jobId),
          failSlot: (slotId, message) => store.failPendingById(slotId, message),
          failLaunch: (slotId, jobId, message) => store.updatePending(
            slotId,
            { jobId, status: 'error', error: message },
            { system: true },
          ),
          fallbackError: "Failed to start generation",
        })
      }))
      const failedCount = results.reduce((sum, result) => sum + result.failedCount, 0)
      if (failedCount > 0) {
        if (compact && !generationAvailable) setCompactSettingsOpen(true)
        setLocalError(`Tasks did not start: ${failedCount} from ${batch.jobs}`)
      }
    } catch (err) {
      for (const entry of pendingBatches) {
        if (!entry.genRefs) {
          for (const slotId of entry.slots) store.failPendingById(slotId, err instanceof Error ? err.message : "Failed to prepare generation")
        }
      }
      if (compact && !generationAvailable) setCompactSettingsOpen(true)
      setLocalError(err instanceof Error ? err.message : "Failed to start generation")
    }
  }


  // Запуск цепочки помощника. На чём она пойдёт, решает assistantScenarioInput
  // (там же его тесты) — здесь остаются только запись входа и сам прогон.

  // «Спросить» — бесплатный вопрос помощнику из того же поля. Кнопка НИКОГДА
  // не блокирует поле и «Сгенерировать»: пока идёт ответ, она просто становится
  // «Стоп» (инвариант — серия платных запусков не должна страдать).

  async function ask(): Promise<void> {
    if (modeRef.current !== 'discuss') return
    if (!generationAvailable) {
      setLocalError(projectSource === 'cloud'
        ? "The assistant is unavailable: connect to the team server in settings."
        : "Assistant not available: add fal.ai key in settings.")
      return
    }
    if (!generationReady) {
      setLocalError("The assistant is not available: wait for the model catalog or click “Retry”.")
      return
    }
    const text = prompt.trim()
    if (!text) return
    // GIF, звук и видео для помощника сетевой доски решает askAssistant
    // (assistantCloudRefs) — одно правило на компьютер и планшет.
    // Alt+Enter не должен молчать, когда помощник ещё отвечает
    if (activeAssistantId) {
      setLocalError("The assistant is still responding. Wait or press Stop.")
      return
    }
    // ⚠️ Вопрос с роликом на сетевой доске уходит не сразу: сначала снимается
    // и заливается кадр. «Стоп» появляется только после ответа сервера, и
    // повторный клик в эти секунды отправил бы второй ОПЛАЧЕННЫЙ вопрос.
    // Замок синхронный и только на отправку вопроса: поле и «Создать» свободны.
    if (askingRef.current) return
    askingRef.current = true
    setLocalError(null)
    onChatOpenChange(true)
    const sentConversationId = promptChatSnapshot.activeId
    const sentRefs = composerRefs.map((ref) => ({ ...ref }))
    const sentRefsKey = JSON.stringify(sentRefs)
    try {
      await askAssistant(promptChatProjectId, text, sentRefs)
      if (
        promptChatStore.getSnapshot(promptChatProjectId).activeId === sentConversationId
        && promptRef.current.trim() === text
        && JSON.stringify(refsRef.current) === sentRefsKey
      ) {
        setPrompt('')
        setManualRefs([])
        pushPromptHistory('', true)
        setMention(null)
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to send question to assistant")
    } finally {
      askingRef.current = false
    }
  }

  const focusOnPendingSlots = useCallback((slotIds: string[]) => {
    const allPending = store.getPending()
    const matching = slotIds
      .map((id) => allPending.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))

    if (matching.length === 0) return

    const minX = Math.min(...matching.map((s) => s.x))
    const minY = Math.min(...matching.map((s) => s.y))
    const maxX = Math.max(...matching.map((s) => s.x + s.w))
    const maxY = Math.max(...matching.map((s) => s.y + s.h))

    const targetBounds = {
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
    }

    const targetCamera = zoomToBounds(
      store.getCamera(),
      targetBounds,
      { w: window.innerWidth, h: window.innerHeight },
      140,
    )

    animateCamera(store.getCamera(), targetCamera, {
      durationMs: 450,
      reducedMotion: false,
      onFrame: (nextCam) => store.setCamera(nextCam),
    })
  }, [store])

  const handleGenerateFromAssistant = useCallback(async (
    promptsToRun: Array<{ title?: string; prompt: string }>,
    requestedKind?: 'image' | 'video',
    sourceRefs: SelectionRef[] = [],
    requestBoardMemoryEnabled?: boolean,
  ): Promise<string[]> => {
    if (!ready) return []
    setLocalError(null)
    if (!generationAvailable) {
      setLocalError(projectSource === 'cloud'
        ? "Generation is not available: connect to the team server in the settings."
        : "Generation is not available: add the fal.ai key in the settings.")
      return []
    }
    if (!generationReady) {
      setLocalError("Generation is not available: wait for the model catalog or click “Repeat”.")
      return []
    }
    if (promptsToRun.length === 0) return []

    // 1. Определение типа медиа: видео или картинка
    const effKind: 'image' | 'video' = requestedKind ?? (
      promptsToRun.some((p) => /видео|ролик|motion|video|клип|анимац/i.test(p.prompt)) ? 'video' : 'image'
    )

    // Источники берём из исходного сообщения, а не из нового выделения.
    const frozenRefs = sourceRefs.map(ref => ({ ...ref }))
    // The current board switch is an upper bound: disabling it now must stop
    // late/manual dispatches, while a response created with it disabled stays
    // disabled even if the user re-enables the board preference meanwhile.
    const useBoardMemory = promptChatSnapshot.boardMemoryEnabled && requestBoardMemoryEnabled !== false
    const launches = promptsToRun.map(item => planAssistantCanvasLaunch({
      projectRef: { source: projectSource, id: projectId },
      kind: effKind, models, defaults, modelId, params,
      refs: frozenRefs, prompt: item.prompt, count: 1, batchMode: 'together',
      sketchTarget: null, itemById: id => store.getItem(id), items: store.getItems(),
      boardMemoryEnabled: useBoardMemory,
    }))
    const invalid = launches.find(launch => launch.batch.admission.error || !launch.batch.requests[0])
    if (invalid) {
      setLocalError(invalid.batch.admission.error || "Failed to prepare generation from helper response")
      return []
    }

    // Freeze launch metadata and convert every reference before opening a
    // consent dialog or sending a quote.  The selection/model/params may
    // change while an async preflight is running, but these entries remain the
    // exact requests that the user is about to approve.
    const entries = launches.map((launchPlan) => {
      const plan = launchPlan.batch.requests[0]!.plan
      const launch = createGenerationLaunch({
        variantCount: 1,
        projectId,
        promptPreview: plan.text.trim().slice(0, 120),
        modelId: plan.model?.id,
        modelName: plan.model?.name ?? "Generation",
        estimatedTotalCostUsd: launchPlan.batch.totalCost ?? undefined,
        createdAt: Date.now(),
      })
      return {
        launchPlan,
        plan,
        launch,
        // `prepare` needs a canvas target to quote a cloud request.  This id
        // is only a preflight address; the paid submit below uses the real
        // placeholder id and the same immutable quote/idempotency options.
        preflightSlotId: `assistant-preflight-${launch.launchId}`,
      }
    })

    let frozenEntries: Array<(typeof entries)[number] & { genRefs: GenRef[]; prepared?: GenerationPreparation }>
    try {
      frozenEntries = await Promise.all(entries.map(async (entry) => ({
        ...entry,
        genRefs: await toGenRefs(entry.plan.refsToSend, effKind),
      })))
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to prepare references for generation")
      return []
    }

    // Local fal jobs have no server quote.  Reuse the dock's threshold and
    // one aggregate dialog so ten individually cheap prompts cannot bypass a
    // confirmation required for their combined amount.
    const estimatedTotal = assistantAggregateEstimatedCost(launches)
    if (estimatedTotal !== null && shouldAskLocalCostConfirmation(
      projectSource,
      Boolean(serverStatus?.falConfigured),
      estimatedTotal,
      confirmCostAboveUsd,
    )) {
      const firstPlan = entries[0]?.plan
      const ok = await askConfirm({
        title: `Run for $${estimatedTotal.toFixed(2)}?`,
        rows: [
          ["Model", firstPlan?.model?.name ?? "default"],
          ["Tasks", `${entries.length}`],
        ],
        confirmLabel: `Run for $${estimatedTotal.toFixed(2)}`,
      })
      if (!ok) {
        setLocalError("Run cancelled.")
        return []
      }
      if (modeRef.current !== 'discuss') return []
    }

    // Cloud quotes are all fetched before any placeholder or paid submit is
    // created.  A single approval covers the exact batch; a missing quote or
    // one rejected preflight aborts the whole response, never a partial set.
    if (projectSource === 'cloud') {
      const preflight = await Promise.allSettled(frozenEntries.map((entry) => (
        prepare(
          effKind,
          entry.plan.text,
          entry.genRefs,
          entry.plan.model?.id,
          Object.keys(entry.plan.params).length ? entry.plan.params : undefined,
          entry.preflightSlotId,
        )
      )))
      const failed = preflight.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) {
        setLocalError(failed.reason instanceof Error ? failed.reason.message : "Failed to get generation quote")
        return []
      }
      const prepared = preflight.map((result) => (result as PromiseFulfilledResult<GenerationPreparation>).value)
      if (prepared.some((value) => !value.quote)) {
        setLocalError("Could not get full quote for all options - nothing running.")
        return []
      }
      frozenEntries = frozenEntries.map((entry, index) => ({ ...entry, prepared: prepared[index] }))
      const approved = await approvePreparedGenerationQuotes(frozenEntries.map((entry) => ({
        variant: { ...entry.launch, variantIndex: 1 },
        slotId: entry.preflightSlotId,
        value: entry.prepared!,
      })))
      if (!approved) {
        setLocalError("Run cancelled.")
        return []
      }
      if (modeRef.current !== 'discuss') return []
    }

    // 3. Создание карточек ожидающих генераций на канвасе.  Keep the
    // already-created ids if a later UI operation fails: AssistantShelf uses
    // a non-empty result to keep its one-dispatch claim.  Releasing that claim
    // after a partial placement would let a second click pay for duplicates.
    const placedSlotIds: string[] = []
    try {
      for (const entry of frozenEntries) {
        const { plan, launch } = entry
        const slots = store.addPendingRow(1, {
          kind: effKind,
          label: plan.model?.name ?? "Generation",
          anchorIds: plan.anchorIds.length ? plan.anchorIds : undefined,
          aspect: plan.aspect,
          prompt: plan.text,
          modelId: plan.model?.id,
          launch,
        })

        const slotId = slots[0]
        if (slotId) {
          placedSlotIds.push(slotId)

          // Запуск задачи в фоне
          void (async () => {
            try {
              const jobId = await start(
                effKind,
                plan.text,
                entry.genRefs,
                plan.model?.id,
                Object.keys(plan.params).length ? plan.params : undefined,
                { ...launch, variantIndex: 1 },
                slotId,
                entry.prepared,
              )
              store.setPendingJob(slotId, jobId)
            } catch (err) {
              store.failPendingById(slotId, err instanceof Error ? err.message : "Generation error")
            }
          })()
        }
      }

      // 4. Плавный перенос камеры к месту, где начались генерации
      if (placedSlotIds.length > 0) {
        focusOnPendingSlots(placedSlotIds)
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to place generation on canvas")
    }

    return placedSlotIds
  }, [ready, generationAvailable, generationReady, projectSource, models, defaults, modelId, params, projectId, store, start, prepare, approvePreparedGenerationQuotes, serverStatus, confirmCostAboveUsd, focusOnPendingSlots, promptChatSnapshot.boardMemoryEnabled])

  // объект с канваса, брошенный на промпт-бар, становится ручным референсом.
  // Регистрируем обработчик только пока открыто окно помощника — при закрытом
  // бар не должен перехватывать перетаскивание по холсту.
  useEffect(() => {
    if (!discussOpen) return
    return registerPromptChatDropHandler({
      hover: setDropActive,
      drop: (event) => {
        setDropActive(false)
        if (event.kind === 'error') {
          setLocalError(event.message)
          return
        }
        setLocalError(null)
        const current = manualRefsRef.current
        const next = current.some((ref) => ref.shapeId === event.ref.shapeId)
          ? current
          : [...current, event.ref]
        manualRefsRef.current = next
        setManualRefs(next)
        const textarea = textareaRef.current
        persistChatDraft(
          promptRef.current,
          next,
          textarea?.selectionStart ?? promptRef.current.length,
          textarea?.selectionEnd ?? promptRef.current.length,
        )
      },
    })
  }, [discussOpen])

  const submitRef = useRef(submit)
  submitRef.current = submit
  const closeChatRef = useRef(() => changeMode('make'))
  closeChatRef.current = () => {
    expandPanel()
    changeMode('make')
  }
  useEffect(() => {
    const handlers = createPromptTargetHandlers({
      switchToPrompt: () => onChatOpenChange(false),
      defer: (run) => window.requestAnimationFrame(run),
      focusPrompt: () => textareaRef.current?.focus({ preventScroll: true }),
      pulsePrompt: () => showOnboardingTarget(promptDockRef.current, {
        message: t('Enter a description and click “Generate” or Shift+Enter.'),
      }),
      firstCanvasReference: () => store.getItems().find((candidate) => (
        candidate.kind === 'image' || candidate.kind === 'video' || candidate.kind === 'text'
      )) ?? null,
      focusCanvasReference: (reference) => store.focusOnboardingItem(reference.id),
      pulseReferences: () => showOnboardingTarget(referenceChipsRef.current, {
        message: t('Select an object on the canvas to use it as a reference.'),
      }),
      announce,
      product: { generate: () => { void submitRef.current() } },
    })
    return registerPromptOnboardingTargets(handlers)
  }, [onChatOpenChange, store, t])

  useEffect(() => {
    return registerGenerationComposer({
      fill(request) {
        // Референсы забираем ТОЛЬКО если подсказка их принесла. Иначе «В строку»
        // молча стирало то, что пользователь выделил на холсте: подсказка без
        // вложений сбрасывала выделение и обнуляла ручные чипы. Сохранённый
        // набор канваса лежит в canvasComposerRef с момента открытия чата —
        // его и оставляем, чтобы возврат на вкладку «Промпт» ничего не потерял.
        const takeOverRefs = request.refs.length > 0
        canvasComposerRef.current = {
          projectId,
          prompt: request.prompt,
          refs: takeOverRefs
            ? request.refs.map((ref) => ({ ...ref }))
            : canvasComposerRef.current.refs.map((ref) => ({ ...ref })),
        }
        setPrompt(request.prompt)
        pushPromptHistory(request.prompt, true)
        if (takeOverRefs) {
          store.clearSelection()
          setManualRefs(canvasComposerRef.current.refs.map((ref) => ({ ...ref })))
          // ⚠️ Порядок задаёт ПОДСКАЗКА, а не память промпт-бара. В окне
          // помощника чипы показывают ручной набор (порядок, в котором объекты
          // туда бросили), а orderedIdsRef всё это время считался и по
          // выделению канваса — то есть помнил ДРУГОЙ порядок. После «В строку»
          // выигрывала эта память, и рефы менялись местами (жалоба 26.08.2026).
          // Это не косметика: промпт говорит «перенеси с изображения 1 на
          // изображение 2», и перестановка даёт обратный результат за те же
          // деньги.
          orderedIdsRef.current = canvasComposerRef.current.refs.map((ref) => ref.shapeId)
        }
        // «В строку» — текст ушёл в поле генерации, показываем именно его
        closeChatRef.current()
        requestAnimationFrame(() => textareaRef.current?.focus())
      },
      async generate(request) {
        // запуск из окна помощника: возвращаем пользователя к холсту, иначе
        // карточки-заглушки встают ровно за открытой панелью и кажется,
        // что клик ничего не сделал
        closeChatRef.current()
        return submitRef.current(request)
      },
    })
  }, [store])

  // ── автокомплит @-ссылок на референсы ──
  const mentionList = mention
    ? referenceMentionCandidates(composerRefs, mention.query)
    : []

  // пересчитать состояние «@…» по тексту до курсора (последний @ без пробела)
  function syncMention(value: string, caret: number): void {
    const next = detectReferenceMention(value, caret)
    if (next && mediaRefs.length > 0) {
      const candidateCount = referenceMentionCandidates(composerRefs, next.query).length
      setMention((prev) => ({
        ...next,
        index: clampMentionIndex(prev?.index ?? 0, candidateCount),
      }))
    }
    else setMention(null)
  }

  // вставить @n (n = номер референса в mediaRefs) вместо набранного «@query»
  function insertMention(ref: SelectionRef): void {
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart ?? prompt.length
    const activeMention = detectReferenceMention(prompt, caret)
    if (!activeMention) return
    const n = mediaRefs.findIndex((r) => r.shapeId === ref.shapeId) + 1
    const next = insertReferenceTag(
      prompt,
      caret,
      caret,
      n,
      activeMention.start,
    )
    setPrompt(next.text)
    pushPromptHistory(next.text, true)
    persistChatDraft(next.text, manualRefs, next.caret, next.caret)
    setMention(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  function onPromptKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (mention && mentionList.length > 0) {
      if (e.key === 'ArrowDown') return e.preventDefault(), setMention({ ...mention, index: (mention.index + 1) % mentionList.length })
      if (e.key === 'ArrowUp') return e.preventDefault(), setMention({ ...mention, index: (mention.index - 1 + mentionList.length) % mentionList.length })
      if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), insertMention(mentionList[mention.index])
      if (e.key === 'Escape') return e.preventDefault(), setMention(null)
    }

    // Перехватываем Ctrl+Z / Ctrl+Y для текстового поля
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase()
      if (key === 'z' || key === 'я') {
        e.preventDefault()
        if (e.shiftKey) {
          handleRedo()
        } else {
          handleUndo()
        }
        return
      }
      if (key === 'y' || key === 'н') {
        e.preventDefault()
        handleRedo()
        return
      }
    }

    const enterAction = resolvePromptEnterAction(e, discussOpen)
    if (enterAction) {
      e.preventDefault()
      if (enterAction === 'ask') void ask()
      else void submit()
    }
  }

  return (
    <>
    <div ref={promptDockRef} className={`prompt-dock${discussOpen ? ' has-assistant' : ''}${panelCollapsed ? ' is-collapsed' : ''}${panelCollapsed && selectedAssistant.id ? ' has-collapsed-helper' : ''}`}>
      {panelCollapsed && (
        <button type="button" className="prompt-dock-restore" aria-label={t('Expand prompt panel')} aria-expanded={false} title={t('Expand prompt panel · S')} onClick={togglePanel}>
          <span aria-hidden="true" />
        </button>
      )}
      {/* .prompt-dock — column-reverse: в DOM бар идёт первым, а эхо и шторка
          ниже по разметке, поэтому визуально они встают НАД баром */}
      {/* dropzone ТОЛЬКО в окне помощника: иначе бар навсегда становится
          мёртвой зоной — объект, отпущенный над ним, отскакивает назад вместо
          того чтобы лечь в нижнюю часть холста */}
      <div
        className={`prompt-bar ${isFocused ? 'is-focused' : ''} ${dropActive ? 'is-drop-target' : ''} ${discussOpen ? 'is-assistant' : ''}`}
        data-canvas-safe-edge="bottom"
        {...(discussOpen ? { 'data-prompt-chat-dropzone': true } : {})}
      >
        {discussOpen ? (
          <AssistantShelfResizeGrip
            height={shelfHeight}
            onHeightChange={(next) => setShelfHeight(clampShelfHeight(next, window.innerHeight))}
          />
        ) : (
          <div
            className="prompt-bar-grip"
            role="separator"
            aria-label={t('Change the maximum prompt height')}
            onPointerDown={startPromptResize}
          >
            <i aria-hidden="true" />
          </div>
        )}
        <ActionDockModeTabs
          mode={mode}
          onChange={changeMode}
          signal={signal}
          signalLabel={signalLabel ?? undefined}
        />

        {/* окно помощника: лента разговора над общим полем ввода.
            Смонтировано ВСЕГДА (прячется стилем внутри) — иначе переключение
            вкладок «Промпт ↔ Чат» пересоздавало DOM ленты и сбрасывало
            прокрутку на низ (жалоба пользователя: чат «прыгал» при возврате) */}
        <AssistantShelf
          projectId={promptChatProjectId}
          store={store}
          models={models}
          height={shelfHeight}
          hidden={!discussOpen}
          onGenerateOnCanvas={handleGenerateFromAssistant}
          onFocusSlots={focusOnPendingSlots}
          onCanvasAction={() => closeChatRef.current()}
        />

        <div className="prompt-header-actions">
          {!discussOpen && (prompt.trim() || composerRefs.length > 0 || sketchTarget) && (
            <button
              className="prompt-clear-btn"
              title={t('Clear prompt. Right-click to also clear prompts saved on selected images.')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleClearAll}
              onContextMenu={handleClearAllPermanent}
            >
              <IconTrash size={15} />
            </button>
          )}
          {mode === 'make' && (
            <div className="prompt-header-batch-toggle ui-toggle" role="group" aria-label={t('Reference usage')}>
              <button
                type="button"
                className={batchMode === 'together' ? 'on' : ''}
                aria-pressed={batchMode === 'together'}
                title={t('Use references together for one prompt')}
                aria-label={t('Use references together for one prompt')}
                onClick={() => setBatchMode('together')}
                disabled={!ready || kind !== 'image'}
              >
                <IconCombine size={15} />
              </button>
              <button
                type="button"
                className={batchMode === 'each' ? 'on' : ''}
                aria-pressed={batchMode === 'each'}
                title={kind === 'image' ? t('Use each reference separately') : t('Available for images only')}
                aria-label={t('Use each reference separately')}
                onClick={() => setBatchMode('each')}
                disabled={!ready || kind !== 'image'}
              >
                <IconCopy size={15} />
              </button>
            </div>
          )}
          {discussOpen && boardMemoryToggleShown(projectSource, promptChatSnapshot.boardMemoryControlSupported) && (
            <button
              type="button"
              role="switch"
              className="prompt-collapse-btn assistant-memory-toggle"
              aria-label={t('Board memory')}
              aria-checked={promptChatSnapshot.boardMemoryEnabled}
              aria-busy={promptChatSnapshot.boardMemorySaving}
              disabled={!promptChatSnapshot.boardMemoryControlSupported || promptChatSnapshot.loadState !== 'ready' || promptChatSnapshot.boardMemorySaving}
              title={promptChatSnapshot.boardMemoryControlSupported
                ? t('Board memory {0}. Uses board context for replies and model selection. Chat history and attached references stay available.', { 0: promptChatSnapshot.boardMemoryEnabled ? t('on') : t('off') })
                : t('The board memory cannot be changed: the server has not confirmed support for this setting.')}
              onClick={() => {
                setLocalError(null)
                void promptChatStore.setBoardMemoryEnabled(promptChatProjectId, !promptChatSnapshot.boardMemoryEnabled).catch((error) => {
                  setLocalError(error instanceof Error ? error.message : "Failed to save board memory")
                })
              }}
            >
              <IconMemory size={16} weight={promptChatSnapshot.boardMemoryEnabled ? 'fill' : 'regular'} />
            </button>
          )}
          <button type="button" className="prompt-collapse-btn" aria-label={t('Collapse prompt panel')} aria-expanded={true} title={t('Collapse prompt panel · S')} onClick={togglePanel}>
            {discussOpen ? <IconMinus size={16} /> : <IconCollapse size={16} />}
          </button>
        </div>
        <div className="assistant-composer" style={discussOpen ? undefined : { display: 'contents' }}>
        <div ref={referenceChipsRef} className="onboarding-reference-target">
          <ReferenceChips
            refs={composerRefs}
            onRemove={(ref) => removeRef(ref.shapeId)}
            onTag={(_, number) => insertTag(number)}
            onReplace={discussOpen ? undefined : beginReferenceReplacement}
            replacingShapeId={replacementSession?.targetShapeId}
            gifUsage={discussOpen && projectSource === 'cloud' ? 'unsupported' : 'frame'}
          />
        </div>
        <PromptComposerField
          textareaRef={textareaRef}
          value={prompt}
          ariaLabel={discussOpen ? t('Message assistant') : t('Prompt for generation')}
          placeholder={t(promptPlaceholder({
            chatOpen: discussOpen,
            sketchTarget,
            textRefCount: textRefs.length,
            mediaRefCount: mediaRefs.length,
          }))}
          mention={mention}
          mentionList={mentionList}
          mediaRefs={mediaRefs}
          onChange={(value: string, start: number, end: number) => {
            setPrompt(value)
            pushPromptHistory(value)
            persistChatDraft(value, manualRefs, start, end)
            syncMention(value, start)
          }}
          onCaretMove={(value: string, start: number, end: number) => {
            syncMention(value, start)
            persistChatDraft(value, manualRefs, start, end)
          }}
          onFocus={() => setIsFocused(true)}
          onBlur={(field: HTMLTextAreaElement) => {
            setTimeout(() => setMention(null), 120)
            setTimeout(() => {
              const active = document.activeElement
              const inside = active && field.closest('.prompt-bar')?.contains(active)
              if (!inside) setIsFocused(false)
            }, 200)
          }}
          onKeyDown={onPromptKeyDown}
          onMentionHover={(index: number) => setMention((prev) => (prev ? { ...prev, index } : prev))}
          onMentionPick={insertMention}
        />
        {/* ряд действий: в окне промпта — тип, макросы и «Сгенерировать»,
            в окне помощника — только «Спросить»/«Стоп» */}
        <div className="prompt-actions">
          <div className="gen-controls">
            {discussOpen && (prompt.trim() || composerRefs.length > 0) && (
              <button
                type="button"
                className="prompt-clear-btn"
                aria-label={t('Clear message')}
                title={t('Clear message and attachments')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleClearAll}
              >
                <IconTrash size={15} />
              </button>
            )}
            {mode === 'make' && (
              <div className="kind-toggle">
                <button
                  type="button"
                  className={kind === 'image' ? 'on' : ''}
                  title={t('Image')}
                  aria-label={t('Image')}
                  aria-pressed={kind === 'image'}
                  onClick={() => switchKind('image')}
                >
                  <IconImage size={15} />
                  {compact && <span>{t('Image')}</span>}
                </button>
                <button
                  type="button"
                  className={kind === 'video' ? 'on' : ''}
                  title={t('Video')}
                  aria-label={t('Video')}
                  aria-pressed={kind === 'video'}
                  onClick={() => switchKind('video')}
                >
                  <IconVideo size={15} />
                  {compact && <span>{t('Video')}</span>}
                </button>
                <button
                  type="button"
                  className={kind === 'audio' ? 'on' : ''}
                  title={t('Audio')}
                  aria-label={t('Audio')}
                  aria-pressed={kind === 'audio'}
                  onClick={() => switchKind('audio')}
                >
                  <IconSound size={15} />
                  {compact && <span>{t('Audio')}</span>}
                </button>
              </div>
            )}
          </div>
          <div className="prompt-actions-right">
            {mode === 'make' && !compact && (
              <PromptMacros
                store={store}
                projectId={projectId}
                projectSource={projectSource}
                models={models}
                confirmCostAboveUsd={confirmCostAboveUsd}
                falConfigured={serverStatus?.falConfigured ?? false}
                generationAvailable={generationReady}
              />
            )}
            {mode === 'discuss' && (
              <AssistantPresets
                models={models}
                variant="shelf"
                projectSource={projectSource}
                onCloudAssistantChanged={() => {
                  const activeId = promptChatStore.getSnapshot(promptChatProjectId).activeId
                  if (activeId) void promptChatStore.refreshConversation(promptChatProjectId, activeId).catch(() => {})
                }}
              />
            )}
            {mode === 'discuss' && activeAssistantId && (
              <button
                className="ask stop"
                type="button"
                title={t('Stop assistant')}
                onClick={() => promptChatStore.cancel(promptChatProjectId, activeAssistantId)}
              >
                <IconStop size={16} /> {t('Stop')}
              </button>
            )}
            {mode === 'discuss' && !activeAssistantId && (
                <button
                  className="ask paid-action"
                  type="button"
                  disabled={!ready || !generationReady || promptChatSnapshot.boardMemorySaving || !prompt.trim()}
                  title={t('Send to assistant: it returns ready prompts; explicit commands create a board result and ask for confirmation before an expensive batch (Shift+↵)')}
                  onClick={() => void ask()}
                >
                  <IconLLM size={16} />
                  <span className="paid-action-label">{t('Send')}</span>
                  <PriceBadge
                    amount={chatEstimate?.costUsd ?? null}
                    precision={3}
                    title={t('Approximate cost of response')}
                    variant="action"
                  />
                </button>
            )}
            {mode === 'make' && (
            <button
              className="generate paid-action"
              disabled={!ready || !generationReady || (!prompt.trim() && textRefs.length === 0)}
              title={displayedGenerationPrice == null && displayModel?.pricingNote
                ? t('Generate (Shift+Enter). Click again to run another generation in parallel. {0}', { 0: displayModel.pricingNote })
                : t('Generate (Shift+Enter). Click again to run another generation in parallel')}
              onClick={() => void submit()}
            >
              <IconGenerate size={17} weight="fill" />
                  <span className="paid-action-label">{createLabel === 'Generate' ? t('Generate') : createLabel}</span>
              {displayedGenerationPrice != null && (
                <PriceBadge
                  amount={displayedGenerationPrice}
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
        </div>
        </div>
        {/* нижний компактный ряд: модель, количество, параметры модели —
            только в окне промпта: в разговоре они не к чему относиться */}
        {mode === 'make' && (
        <PromptSettingsSection
            compact={compact}
            open={compactSettingsOpen}
            attention={Boolean(shownError)}
            onOpenChange={setCompactSettingsOpen}
          >
            <PromptSettingsRow
              models={models}
              kind={kind}
              modelId={modelId}
              onModelChange={chooseModel}
              count={count}
              onCountChange={setCount}
              panel={displayPanel}
              params={params}
              onParamsChange={updateParams}
              hasMediaRefs={hasMediaRefs}
              hasGifRef={composerRefs.some(isGifReference)}
              projectSource={projectSource}
              autoEnabled
              autoModelName={isAutoModelId(modelId)
                ? (displayRequest?.baseModel ?? dockPreview.selection.baseModel)?.name ?? null
                : null}
              modelTitle={displayRequest?.plan.model
                ? t('Model: {0}', { 0: displayRequest.plan.model.name })
                : dockPreview.selection.error ?? undefined}
              imageReferenceCount={
                sketchTarget
                  ? 1
                  : kind === 'image'
                    ? imageRefCount
                    : composerRefs.filter((ref) => ref.kind === 'image').length
              }
              layout={compact ? 'stacked' : 'inline'}
            />
            {compact && (
              <PromptMacros
                store={store}
                projectId={projectId}
                projectSource={projectSource}
                models={models}
                confirmCostAboveUsd={confirmCostAboveUsd}
                falConfigured={serverStatus?.falConfigured ?? false}
                generationAvailable={generationReady}
              />
            )}
          </PromptSettingsSection>
        )}
      </div>

      <PromptNotices
        projectSource={projectSource}
        serverStatus={serverStatus}
        serverStatusReady={serverStatusReady}
        catalogEmpty={models.length === 0}
        catalogError={catalogError}
        onRetryCatalog={retryCatalog}
        replacementNumber={
          replacementSession && replacementTarget ? replacementMediaNumber : undefined
        }
        onCancelReplacement={cancelReferenceReplacement}
        localError={shownError}
        onDismissLocalError={() => {
          setLocalError(null)
          setDismissedModelRefusal(modelRefusal)
        }}
        editorNotice={notice}
        onDismissEditorNotice={() => setNotice(null)}
      />
    </div>
    </>
  )
}

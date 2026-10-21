import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentPackageSummary,
  AgentPackageTaskTypeSummary,
  AgentLlmCatalogView,
  AgentGenerationCaptureInput,
  ProjectRef,
} from '../../../../../packages/agent-protocol/index'
import type { CanvasStore } from '../konva/canvasStore'
import { AgentLaunchFields } from './AgentLaunchFields'
import { AgentLaunchFeedback } from './AgentLaunchFeedback'
import { AgentSpendBudgetSection } from './AgentSpendBudgetSection'
import { taskInputPayload, type AgentTaskInputErrors, type AgentTaskInputValues } from './agentPackageModel'
import { llmAuthorization, llmLaunchInfo, parseUsdMicros } from './agentBudgetModel'
import {
  generationAuthorization as buildGenerationAuthorization,
  generationKinds,
  packageRequiresGeneration,
  type AgentGenerationCatalog,
  type AgentGenerationKind,
} from './agentGenerationModel'
import { agentInputFromCanvasItem } from './agentPanelEvents'
import {
  approveGenerationConsent,
  emptyGenerationConsentDraft,
  generationConsentScope,
  hasCurrentGenerationConsent,
  revokeGenerationConsent,
  type GenerationConsentDraft,
} from './agentGenerationConsentModel'
import { buildAgentLaunchPreflight } from './agentLaunchPreflight'
import {
  agentLlmConsentScope,
  approveAgentLlmConsent,
  hasCurrentAgentLlmConsent,
  launchCompletionIsCurrent,
  revokeAgentLlmConsent,
  type AgentBudgetDraft,
} from './agentLaunchModel'
import {
  agentBudgetDrafts,
  budgetKey,
  captureGenerationInputsAfterBoardSave,
  readBudgetDraft,
  selectedInputKey,
} from './agentLaunchHelpers'
import { makeAgentRequestId } from './useAgentPanel'
import type { AgentPanelController } from './agentPanelController'
import type { AgentPresentationCapability } from './agentCapabilities'
import { useT } from '../../../i18n/context.js'


export function AgentLaunchSection({
  controller,
  projectRef,
  llmCatalog,
  generationCatalog,
  packages,
  readyPackages,
  selectedPackage,
  selectedType,
  taskInput,
  inputErrors,
  canLaunch,
  store,
  onPackageChange,
  onTaskTypeChange,
  onInputChange,
  compact = false,
  capability,
  flushBoardBeforeCapture,
}: {
  controller: AgentPanelController
  projectRef: ProjectRef
  llmCatalog: AgentLlmCatalogView | null
  generationCatalog: AgentGenerationCatalog | null
  packages: readonly AgentPackageSummary[]
  readyPackages: readonly AgentPackageSummary[]
  selectedPackage: AgentPackageSummary | undefined
  selectedType: AgentPackageTaskTypeSummary | undefined
  taskInput: AgentTaskInputValues
  inputErrors: AgentTaskInputErrors
  canLaunch: boolean
  store: CanvasStore
  /** Lower action-dock presentation: hide advanced fields behind a disclosure. */
  compact?: boolean
  capability?: AgentPresentationCapability
  /** Persist the optimistic board before Host freezes selected native bytes. */
  flushBoardBeforeCapture?: () => Promise<{ revision: number }>
  onPackageChange(value: string): void
  onTaskTypeChange(value: string): void
  onInputChange(key: string, value: unknown): void
}) {
  const t = useT()
  const llmInfo = useMemo(() => capability?.billing === 'none'
    ? null
    : llmLaunchInfo(selectedPackage, projectRef, llmCatalog), [capability?.billing, llmCatalog, projectRef, selectedPackage])
  const llmKey = budgetKey(projectRef, selectedPackage?.id, selectedType?.id)
  const [budgetDraft, setBudgetDraft] = useState<AgentBudgetDraft>(() => readBudgetDraft(llmKey))
  const [generationKind, setGenerationKind] = useState<AgentGenerationKind | null>(null)
  const [generationModelId, setGenerationModelId] = useState<string | null>(null)
  const [generationConsent, setGenerationConsent] = useState<GenerationConsentDraft>(emptyGenerationConsentDraft)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [launchBusy, setLaunchBusy] = useState(false)
  const [generationCapture, setGenerationCapture] = useState<{
    key: string
    pending: boolean
    receipts: Awaited<ReturnType<AgentPanelController['captureGenerationInputs']>>
    error: string | null
  }>({ key: '', pending: false, receipts: [], error: null })
  const [startRequest, setStartRequest] = useState<{ fingerprint: string; requestId: string } | null>(null)
  const launchSerial = useRef(0)
  const activeStartSerial = useRef<number | null>(null)
  const launchFingerprintRef = useRef('')

  useEffect(() => {
    launchSerial.current += 1
    setBudgetDraft(readBudgetDraft(llmKey))
    setGenerationKind(null)
    setGenerationModelId(null)
    setGenerationConsent(emptyGenerationConsentDraft())
    setLaunchError(null)
    setLaunchBusy(false)
    setStartRequest(null)
  }, [llmKey])

  const parsedBudget = parseUsdMicros(budgetDraft.input)
  const inputPayload = taskInputPayload(taskInput)
  const selectedItems = store.getSelectedItems()
  const selectedInputCount = selectedItems.length
  // The consent scope must move when the same board card is replaced by a
  // different media asset. An item id alone would incorrectly reuse an old
  // checksum/model selection after an in-place replacement.
  const selectedInputIdentity = selectedInputKey(selectedItems)
  const selectedInputLabels = selectedItems
    .filter((item) => item.kind === 'image' || item.kind === 'video' || item.kind === 'audio')
    .map((item, index) => item.name?.trim() || `File ${index + 1}`)
  const captureInputs = useMemo<AgentGenerationCaptureInput[]>(() => selectedItems
    .filter((item) => item.kind === 'image' || item.kind === 'video' || item.kind === 'audio')
    .map((item) => ({ itemId: item.id, kind: item.kind as AgentGenerationCaptureInput['kind'] })), [selectedInputIdentity])
  const captureKey = `${projectRef.source}:${projectRef.id}:${selectedPackage?.id ?? ''}:${selectedType?.id ?? ''}:${selectedInputIdentity}`
  const captureNativeInputs = controller.captureGenerationInputs
  useEffect(() => {
    const shouldCapture = projectRef.source === 'local'
      && packageRequiresGeneration(selectedPackage)
      && generationKinds(selectedType).length > 0
      && captureInputs.length > 0
    if (!shouldCapture) {
      setGenerationCapture((current) => current.key === captureKey && current.receipts.length === 0 && !current.pending && current.error === null
        ? current
        : { key: captureKey, pending: false, receipts: [], error: null })
      return
    }
    let cancelled = false
    setGenerationCapture({ key: captureKey, pending: true, receipts: [], error: null })
    void captureGenerationInputsAfterBoardSave(
      flushBoardBeforeCapture,
      captureNativeInputs,
      { projectRef, inputs: captureInputs },
    )
      .then((receipts) => {
        if (!cancelled) setGenerationCapture({ key: captureKey, pending: false, receipts, error: null })
      })
      .catch((error: unknown) => {
        if (!cancelled) setGenerationCapture({ key: captureKey, pending: false, receipts: [], error: error instanceof Error ? error.message : 'Host could not capture native media' })
      })
    return () => { cancelled = true }
  }, [captureInputs, captureKey, captureNativeInputs, flushBoardBeforeCapture, projectRef, selectedPackage, selectedType])

  const captureByItemId = useMemo(() => new Map(generationCapture.receipts.map((receipt) => [receipt.itemId, receipt.artifact])), [generationCapture.receipts])
  const selectedInputs = useMemo(() => selectedItems.map((item) => {
    const base = agentInputFromCanvasItem(item)
    const artifact = captureByItemId.get(item.id)
    return artifact ? { ...base, artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum } : base
  }), [captureByItemId, selectedInputIdentity])
  const launchPreflight = useMemo(() => buildAgentLaunchPreflight({
    pkg: selectedPackage,
    type: selectedType,
    projectRef,
    catalog: generationCatalog,
    kind: generationKind,
    modelId: generationModelId,
    selectedInputs,
    instruction: controller.instruction.trim(),
  }), [controller.instruction, generationCatalog, generationKind, generationModelId, projectRef, selectedInputs, selectedPackage, selectedType])
  const generationArtifactRefs = launchPreflight.artifactRefs
  const generationInfo = generationCapture.pending && launchPreflight.generationInfo
    ? { ...launchPreflight.generationInfo, available: false, unavailableReason: 'Host is capturing native media for this attempt…' }
    : generationCapture.error && launchPreflight.generationInfo
      ? { ...launchPreflight.generationInfo, available: false, unavailableReason: generationCapture.error }
      : launchPreflight.generationInfo
  const generationConsentKey = `${generationConsentScope(launchPreflight.generationConsentInput)}:${budgetDraft.input}`
  const generationMediaConsentGranted = hasCurrentGenerationConsent(generationConsent, generationConsentKey)
  const generationAuthorization = buildGenerationAuthorization(generationInfo, parsedBudget.amountMicros, generationMediaConsentGranted, generationArtifactRefs)
  const contextPreview = [
    controller.instruction.trim() ? `Instructions for the agent:\n${controller.instruction.trim()}` : '',
    Object.keys(inputPayload).length > 0 ? `Task parameters:\n${JSON.stringify(inputPayload, null, 2)}` : '',
  ].filter(Boolean).join('\n\n') || 'No instructions have been entered yet.'
  const consentScope = useMemo(() => agentLlmConsentScope({
    projectRef,
    packageId: selectedPackage?.id,
    taskType: selectedType?.id,
    instruction: controller.instruction.trim(),
    context: inputPayload,
    budgetInput: budgetDraft.input,
    llmInfo,
  }), [budgetDraft.input, controller.instruction, inputPayload, llmInfo, projectRef, selectedPackage?.id, selectedType?.id])
  const consentGranted = hasCurrentAgentLlmConsent(budgetDraft, consentScope)
  const authorization = llmAuthorization(llmInfo, parsedBudget.amountMicros, consentGranted)
  const generationRequired = generationInfo !== null
  const validTask = Boolean(canLaunch && selectedType && controller.instruction.trim() && Object.keys(inputErrors).length === 0)
  const validLlm = !llmInfo || Boolean(authorization)
  const validGeneration = !generationRequired || Boolean(generationAuthorization)
  const launchDisabled = !validTask || !validLlm || !validGeneration
  const launchFingerprint = JSON.stringify({
    packageId: selectedPackage?.id ?? '', taskType: selectedType?.id ?? '',
    input: inputPayload, instruction: controller.instruction.trim(), selectedInputKey: selectedInputIdentity,
    llm: authorization ?? null, generation: generationAuthorization ?? null,
  })
  launchFingerprintRef.current = launchFingerprint

  const invalidateLaunchDraft = () => {
    launchSerial.current += 1
    setStartRequest(null)
    setGenerationConsent((current) => revokeGenerationConsent(current))
    const stored = agentBudgetDrafts.get(llmKey)
    if (!stored?.consent) return
    const next = revokeAgentLlmConsent(stored)
    agentBudgetDrafts.set(llmKey, next)
    setBudgetDraft((current) => current.consentScope === stored.consentScope ? next : current)
  }
  const invalidateLaunchAttempt = () => {
    launchSerial.current += 1
    setStartRequest(null)
  }
  useEffect(() => {
    const stored = agentBudgetDrafts.get(llmKey)
    if (!stored?.consent || stored.consentScope === consentScope) return
    const next = revokeAgentLlmConsent(stored)
    agentBudgetDrafts.set(llmKey, next)
    setBudgetDraft(next)
    invalidateLaunchDraft()
  }, [consentScope, llmKey])
  useEffect(() => {
    if (!generationConsent.granted || generationConsent.scope === generationConsentKey) return
    setGenerationConsent((current) => revokeGenerationConsent(current))
    setStartRequest(null)
  }, [generationConsent.granted, generationConsent.scope, generationConsentKey])

  const updateBudgetInput = (input: string) => {
    invalidateLaunchDraft()
    const next = revokeAgentLlmConsent({ ...budgetDraft, input })
    agentBudgetDrafts.set(llmKey, next)
    setBudgetDraft(next)
  }
  const updateConsent = (consent: boolean) => {
    invalidateLaunchAttempt()
    const next = approveAgentLlmConsent(budgetDraft, consentScope, consent)
    agentBudgetDrafts.set(llmKey, next)
    setBudgetDraft(next)
  }
  const updateGenerationConsent = (consent: boolean) => {
    invalidateLaunchAttempt()
    setGenerationConsent((current) => approveGenerationConsent(current, generationConsentKey, consent))
  }
  const clearConsent = (key: string, scope: string, version: number) => {
    const stored = agentBudgetDrafts.get(key)
    if (!stored || !hasCurrentAgentLlmConsent(stored, scope) || stored.consentVersion !== version) return
    const next = revokeAgentLlmConsent(stored)
    agentBudgetDrafts.set(key, next)
    if (key === llmKey) setBudgetDraft((current) => current.consentScope === scope && current.consentVersion === version ? next : current)
  }

  const launch = async () => {
    if (!selectedPackage || !selectedType || launchDisabled || launchBusy) return
    setLaunchError(null)
    const requestId = startRequest?.fingerprint === launchFingerprint
      ? startRequest.requestId
      : makeAgentRequestId('task')
    const serial = launchSerial.current
    const launchBudgetKey = llmKey
    const launchConsentScope = consentScope
    const launchConsentVersion = budgetDraft.consentVersion
    const launchGenerationConsentScope = generationConsentKey
    const launchGenerationConsentVersion = generationConsent.version
    setStartRequest({ fingerprint: launchFingerprint, requestId })
    activeStartSerial.current = serial
    setLaunchBusy(true)
    try {
      await controller.start({
        packageId: selectedPackage.id,
        taskType: selectedType.id,
        input: inputPayload,
        launchInputs: selectedInputs,
        ...(selectedPackage.version ? { packageVersion: selectedPackage.version } : {}),
        ...(selectedPackage.packageSha ? { packageSha: selectedPackage.packageSha } : {}),
        ...(selectedPackage.catalogRevision !== undefined ? { catalogRevision: selectedPackage.catalogRevision } : {}),
        ...(authorization ? { llm: authorization } : {}),
        ...(generationAuthorization ? { generation: generationAuthorization } : {}),
        ...(generationCapture.receipts.length ? { capturedArtifacts: generationCapture.receipts } : {}),
        requestId,
      })
      if (activeStartSerial.current === serial) {
        clearConsent(launchBudgetKey, launchConsentScope, launchConsentVersion)
        setGenerationConsent((current) => current.scope === launchGenerationConsentScope && current.version === launchGenerationConsentVersion
          ? revokeGenerationConsent(current)
          : current)
      }
      if (activeStartSerial.current === serial && launchCompletionIsCurrent(serial, launchFingerprint, launchSerial.current, launchFingerprintRef.current)) {
        setStartRequest(null)
      }
    } catch (error) {
      if (activeStartSerial.current === serial && launchCompletionIsCurrent(serial, launchFingerprint, launchSerial.current, launchFingerprintRef.current)) {
        setLaunchError(error instanceof Error ? error.message : `Task rejected by ${capability?.label ?? 'local host'}`)
      }
    } finally {
      if (activeStartSerial.current === serial) {
        activeStartSerial.current = null
        setLaunchBusy(false)
      }
    }
  }

  const setInstruction = (value: string) => { invalidateLaunchDraft(); controller.setInstruction(value) }
  const setPackage = (value: string) => { invalidateLaunchDraft(); onPackageChange(value) }
  const setTaskType = (value: string) => { invalidateLaunchDraft(); onTaskTypeChange(value) }
  const setTaskInput = (key: string, value: unknown) => { invalidateLaunchDraft(); onInputChange(key, value) }
  return (
    <section className={`agent-panel-section agent-panel-launch${compact ? ' agent-panel-launch--compact' : ''}`} aria-labelledby="agent-launch-title">
      <div className="agent-panel-section-head">
        <span id="agent-launch-title">{t('New task')}</span>
        <span className="agent-panel-kicker">{capability?.label ?? 'On this computer'}</span>
      </div>
      {selectedPackage ? (
        <>
          <AgentLaunchFields
            controller={controller}
            selectedPackage={selectedPackage}
            readyPackages={readyPackages}
            selectedType={selectedType}
            taskInput={taskInput}
            inputErrors={inputErrors}
            compact={compact}
            onPackageChange={setPackage}
            onTaskTypeChange={setTaskType}
            onInputChange={setTaskInput}
            onInstructionChange={setInstruction}
          />
          <AgentSpendBudgetSection
            llmInfo={llmInfo}
            generationInfo={generationInfo}
            generationKindOptions={generationKinds(selectedType)}
            generationArtifactLabels={selectedInputLabels}
            generationCeiling={selectedType?.generation?.maxCalls}
            budgetDraft={budgetDraft}
            parsedBudget={parsedBudget}
            generationMediaConsentGranted={generationMediaConsentGranted}
            consentGranted={consentGranted}
            launchBusy={launchBusy}
            compact={compact}
            contextPreview={contextPreview}
            onBudgetInput={updateBudgetInput}
            onLlmConsent={updateConsent}
            onGenerationConsent={updateGenerationConsent}
            onGenerationKind={(value) => { invalidateLaunchDraft(); setGenerationKind(value); setGenerationModelId(null) }}
            onGenerationModel={(value) => { invalidateLaunchDraft(); setGenerationModelId(value) }}
          />
          <AgentLaunchFeedback
            selectedPackage={selectedPackage}
            packages={packages}
            capability={capability}
            selectedInputCount={selectedInputCount}
            launchBusy={launchBusy}
            launchDisabled={launchDisabled}
            launchError={launchError}
            canLaunch={canLaunch}
            onLaunch={() => void launch()}
          />
        </>
      ) : (
        <AgentLaunchFeedback
          selectedPackage={undefined}
          packages={packages}
          capability={capability}
          selectedInputCount={selectedInputCount}
          launchBusy={false}
          launchDisabled={true}
          launchError={null}
          canLaunch={canLaunch}
          onLaunch={() => undefined}
        />
      )}
    </section>
  )
}

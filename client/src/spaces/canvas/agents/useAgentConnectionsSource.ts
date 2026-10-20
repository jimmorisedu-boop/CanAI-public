import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentPackageCheckRequest,
  AgentPackageCheckView,
  AgentPackageInstallationView,
  AgentPackageSummary,
} from '../../../../../packages/agent-protocol/index'
import { isAgentTaskActive } from './agentPanelModel'
import {
  checkCanBeTrusted,
  failedPackageInstallations,
  packageCanBeRemoved,
  packageSourceMatchesInstallation,
  sourceCheckKey,
} from './agentPackageModel'
import type { AgentPackageController } from './agentPanelController'
import {
  connectionSessions,
  idFor,
  newRequestId,
  samePackageSourceFamily,
  sourceDrafts,
  type ConnectionNotice,
  type ConnectionSession,
  type PendingMutation,
  type SourceDraft,
  type SourceKind,
  type UploadPending,
} from './agentConnectionsModel'
import { runAgentPackageMutation } from './agentConnectionsMutations'
import { uploadAgentArchive } from './agentConnectionsUpload'
import { recheckAgentInstallation } from './agentConnectionsRecovery'
import { startAgentPackageInstall } from './agentConnectionsInstall'

export function useAgentConnectionsSource(
  controller: AgentPackageController,
  projectRef: { source: 'local' | 'cloud'; id: string },
  pythonReady: boolean,
) {
  const projectKey = idFor(projectRef)
  const initial = connectionSessions.get(projectKey) ?? {
    check: null,
    trustConfirmed: false,
    notice: null,
    pending: null,
    reinstallInstallationId: null,
  }
  const [draft, setDraft] = useState<SourceDraft>(() => sourceDrafts.get(projectKey) ?? { kind: 'git', url: '', ref: '', subdir: '' })
  const [check, setCheckState] = useState<AgentPackageCheckView | null>(initial.check)
  const [trustConfirmed, setTrustConfirmedState] = useState(initial.trustConfirmed)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNoticeState] = useState<ConnectionNotice | null>(initial.notice)
  const [pending, setPendingState] = useState<PendingMutation | null>(initial.pending)
  const [reinstallInstallationId, setReinstallInstallationIdState] = useState<string | null>(initial.reinstallInstallationId ?? null)
  const [uploadPending, setUploadPending] = useState<UploadPending | null>(null)
  const [checkRetry, setCheckRetry] = useState<SourceDraft | null>(null)
  const requestSerial = useRef(0)
  const checkRequestId = useRef<string | null>(null)
  const checkSourceKeyRef = useRef<string | null>(null)

  useEffect(() => {
    requestSerial.current += 1
    const next = sourceDrafts.get(projectKey) ?? { kind: 'git' as const, url: '', ref: '', subdir: '' }
    const session = connectionSessions.get(projectKey)
    setDraft(next)
    setCheckState(session?.check ?? null)
    setTrustConfirmedState(session?.trustConfirmed ?? false)
    setNoticeState(session?.notice ?? null)
    setPendingState(session?.pending ?? null)
    setReinstallInstallationIdState(session?.reinstallInstallationId ?? null)
    setUploadPending(null)
    setBusy(null)
    setCheckRetry(null)
    checkRequestId.current = null
    checkSourceKeyRef.current = null
  }, [projectKey])

  const saveSession = (patch: Partial<ConnectionSession>) => {
    const current = connectionSessions.get(projectKey) ?? initial
    connectionSessions.set(projectKey, { ...current, ...patch })
  }
  const setCheck = (value: AgentPackageCheckView | null) => { saveSession({ check: value }); setCheckState(value) }
  const setTrustConfirmed = (value: boolean) => { saveSession({ trustConfirmed: value }); setTrustConfirmedState(value) }
  const setNotice = (value: ConnectionNotice | null) => { saveSession({ notice: value }); setNoticeState(value) }
  const setPending = (value: PendingMutation | null) => { saveSession({ pending: value }); setPendingState(value) }
  const setReinstallInstallationId = (value: string | null) => {
    saveSession({ reinstallInstallationId: value })
    setReinstallInstallationIdState(value)
  }

  const packages = controller.state.packages
  const failedInstallations = useMemo(() => failedPackageInstallations(controller.state.installations), [controller.state.installations])
  const trusted = Boolean(check && trustConfirmed && checkCanBeTrusted(check, check.trust.requiredPermissions))
  const checkedPackage = check ? packages.find((pkg) => pkg.id === check.manifest.id) : undefined
  const reinstallInstallation = reinstallInstallationId
    ? failedInstallations.find((installation) => installation.installationId === reinstallInstallationId)
    : undefined
  const archiveUpdateFromFailed = Boolean(reinstallInstallation && check
    && check.manifest.id === reinstallInstallation.packageId
    && check.source.kind === 'archive' && reinstallInstallation.source.kind === 'archive')
  const packageSourceConflict = Boolean(checkedPackage && check && (
    !checkedPackage.installationId
    || !samePackageSourceFamily(checkedPackage.source, check.source)
  ))
  const reinstallSourceConflict = Boolean(reinstallInstallation && check && !packageSourceMatchesInstallation(check, reinstallInstallation) && !archiveUpdateFromFailed)
  const sourceConflict = packageSourceConflict || reinstallSourceConflict
  const activeTask = (pkg: AgentPackageSummary) => controller.state.tasks.some((task) => (
    task.packageId === pkg.id
    && (!pkg.installationId || !task.installationId || pkg.installationId === task.installationId)
    && isAgentTaskActive(task.state)
  ))

  const showError = (error: unknown) => {
    setNotice({ tone: 'error', title: 'Change was not applied', detail: error instanceof Error ? error.message : 'Host did not respond' })
  }
  const showCurrentError = (error: unknown, serial: number) => {
    if (serial !== requestSerial.current) return
    showError(error)
  }

  const updateDraft = (key: keyof SourceDraft, value: string) => {
    requestSerial.current += 1
    setBusy(null)
    setUploadPending(null)
    setCheckRetry(null)
    checkRequestId.current = null
    checkSourceKeyRef.current = null
    const next = { ...draft, [key]: value }
    sourceDrafts.set(projectKey, next)
    setDraft(next)
    // A checked source is immutable. Editing any source field revokes trust.
    setCheck(null)
    setTrustConfirmed(false)
    setPending(null)
    setNotice(null)
    if (reinstallInstallationId) setReinstallInstallationId(null)
  }

  const resetCheckedSource = () => {
    requestSerial.current += 1
    setBusy(null)
    setUploadPending(null)
    setCheckRetry(null)
    checkRequestId.current = null
    checkSourceKeyRef.current = null
    setCheck(null)
    setTrustConfirmed(false)
    setPending(null)
    setNotice(null)
    setReinstallInstallationId(null)
  }

  const setSourceKind = (kind: SourceKind) => {
    if (draft.kind === kind) return
    requestSerial.current += 1
    setUploadPending(null)
    setCheckRetry(null)
    checkRequestId.current = null
    checkSourceKeyRef.current = null
    const next: SourceDraft = { ...draft, kind }
    sourceDrafts.set(projectKey, next)
    setDraft(next)
    resetCheckedSource()
  }

  const uploadArchive = (archive: Blob, name: string) => uploadAgentArchive({
    archive, name, projectKey, draft, uploadPending, controller,
    serialRef: requestSerial, setDraft, setUploadPending, setBusy, setCheckRetry, setNotice,
    checkRequestId, checkSourceKey: checkSourceKeyRef, showCurrentError,
  })

  const runMutation = (operation: PendingMutation) => runAgentPackageMutation({
    operation, controller, serialRef: requestSerial, setPending, setBusy, setNotice, showError,
  })

  const checkSource = async (
    source: SourceDraft = draft,
    recoveryInstallationId: string | null | undefined = undefined,
  ) => {
    const url = source.url.trim()
    if (source.kind === 'git' && !url) {
      setNotice({ tone: 'warning', title: 'Enter a GitHub repository', detail: 'A public HTTPS URL like https://github.com/owner/repository is required.' })
      return
    }
    if (source.kind === 'archive' && !source.archiveId) {
      setNotice({ tone: 'warning', title: 'Choose a ZIP first', detail: 'Host checks only the uploaded binary archive; the filename is not a source.' })
      return
    }
    const serial = ++requestSerial.current
    const sourceKey = sourceCheckKey(source)
    if (checkSourceKeyRef.current !== sourceKey || !checkRequestId.current) {
      checkSourceKeyRef.current = sourceKey
      checkRequestId.current = newRequestId('check')
    }
    const input: AgentPackageCheckRequest = {
      requestId: checkRequestId.current,
      source: source.kind === 'archive'
        ? { kind: 'archive', archiveId: source.archiveId!, ...(source.subdir.trim() ? { subdir: source.subdir.trim() } : {}) }
        : { kind: 'git', url, ...(source.ref.trim() ? { ref: source.ref.trim() } : {}), ...(source.subdir.trim() ? { subdir: source.subdir.trim() } : {}) },
    }
    setBusy('check')
    setCheck(null)
    setPending(null)
    setCheckRetry(null)
    setReinstallInstallationId(recoveryInstallationId === undefined ? reinstallInstallationId : recoveryInstallationId)
    setTrustConfirmed(false)
    setNotice(null)
    try {
      const result = await controller.checkPackage(input)
      if (serial === requestSerial.current) { setCheck(result); setCheckRetry(null); checkRequestId.current = null }
    } catch (error) {
      if (serial === requestSerial.current) setCheckRetry(source)
      showCurrentError(error, serial)
    } finally {
      if (serial === requestSerial.current) setBusy(null)
    }
  }

  const recheckFailedInstallation = (installation: AgentPackageInstallationView) => recheckAgentInstallation({
    installation, controller, projectKey, setDraft, setNotice, checkSource,
  })

  const startInstall = () => startAgentPackageInstall({
    check, trusted, pythonReady, reinstallInstallation, archiveUpdateFromFailed,
    checkedPackage, controller, runMutation, setNotice,
  })

  const manage = (pkg: AgentPackageSummary, action: 'enable' | 'disable' | 'rollback' | 'remove') => {
    if (!pkg.installationId) return
    if (activeTask(pkg) || !packageCanBeRemoved(pkg, controller.state.tasks)) {
      setNotice({ tone: 'warning', title: 'Package is busy with an active task', detail: 'Wait for it to finish or stop the task first. Older tasks remain in the list.' })
      return
    }
    void runMutation({ kind: 'manage', action, input: {
      requestId: newRequestId(action), expectedRevision: controller.packageRevision,
      installationId: pkg.installationId, packageId: pkg.id,
    } })
  }

  const retryPending = () => {
    if (pending) void runMutation(pending)
  }

  return {
    draft, check, trustConfirmed, busy, notice, pending, uploadPending, checkRetry,
    failedInstallations, trusted, checkedPackage, reinstallInstallation, archiveUpdateFromFailed,
    packageSourceConflict, reinstallSourceConflict, sourceConflict,
    sourceLocked: Boolean(check), setTrustConfirmed,
    updateDraft, resetCheckedSource, setSourceKind, uploadArchive, checkSource,
    recheckFailedInstallation, startInstall, manage, activeTask, retryPending,
  }
}

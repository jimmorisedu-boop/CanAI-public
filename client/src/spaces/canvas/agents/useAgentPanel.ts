import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentDecisionPayload,
  AgentGenerationCaptureReceipt,
  AgentGenerationCaptureRequest,
  AgentGenerationAuthorization,
  AgentLlmAuthorization,
  AgentInputItem,
} from '../../../../../packages/agent-protocol/index'
import type { ProjectRef as CanvasProjectRef } from '../../../types'
import type { CanvasStore } from '../konva/canvasStore'
import {
  makeAgentPanelState,
  addPendingAgentStart,
  reconcileAgentTask,
  reconcileAgentTaskProgress,
  rejectPendingAgentStart,
  rejectAgentAction,
  optimisticallyRequestAgentAction,
  isCurrentAgentReview,
  type AgentAction,
  type AgentPanelState,
} from './agentPanelModel'
import { classifyAgentHostFailure, type AgentDecisionRequest, type AgentTaskClient } from './agentHostClient'
import { makeAgentRequestId, type AgentPanelController } from './agentPanelController'
import { agentInputFromCanvasItem, applyCapturedArtifacts, eventProgress, eventTask, eventTaskId } from './agentPanelEvents'
import { deliverAgentResults } from './agentResultDelivery'
import { collapsedByProject, draftByProject, keyOf, projectRefOf, selectedByProject } from './agentPanelScope'

export type { AgentPanelController } from './agentPanelController'
export { makeAgentRequestId } from './agentPanelController'

export function useAgentPanel(
  canvasProjectRef: CanvasProjectRef,
  store: CanvasStore,
  enabled: boolean,
  client?: AgentTaskClient,
): AgentPanelController {
  const projectRef = useMemo(() => projectRefOf(canvasProjectRef), [canvasProjectRef.id, canvasProjectRef.source])
  const projectKey = keyOf(projectRef)
  // Every board passes an explicit task transport. In particular, a Cloud
  // project never acquires the local Host merely from its project source.
  const hostClient = client
  const [state, setState] = useState(() => makeAgentPanelState(projectRef))
  const [collapsed, setCollapsedState] = useState(() => collapsedByProject.get(projectKey) ?? true)
  const [instruction, setInstructionState] = useState(() => draftByProject.get(projectKey) ?? '')
  const [selectedTaskId, setSelectedTaskState] = useState<string | null>(() => selectedByProject.get(projectKey) ?? null)
  const [packageRevision, setPackageRevision] = useState(0)
  const projectEpoch = useRef(0)
  const projectEventCursor = useRef(0)
  useEffect(() => {
    projectEpoch.current += 1
  }, [projectKey])

  const setCollapsed = useCallback((value: boolean) => {
    collapsedByProject.set(projectKey, value)
    setCollapsedState(value)
  }, [projectKey])
  const setInstruction = useCallback((value: string) => {
    draftByProject.set(projectKey, value)
    setInstructionState(value)
  }, [projectKey])
  const setSelectedTaskId = useCallback((value: string | null) => {
    selectedByProject.set(projectKey, value)
    setSelectedTaskState(value)
  }, [projectKey])

  useEffect(() => {
    setState(makeAgentPanelState(projectRef))
    setPackageRevision(0)
    projectEventCursor.current = 0
    setSelectedTaskState(selectedByProject.get(projectKey) ?? null)
    setInstructionState(draftByProject.get(projectKey) ?? '')
    setCollapsedState(collapsedByProject.get(projectKey) ?? true)
  }, [projectKey, projectRef])

  useEffect(() => {
    if (!enabled || hostClient) return
    setState((current) => ({
      ...current,
      connection: 'offline',
      error: 'This transport did not grant agent control',
    }))
  }, [enabled, hostClient])

  const refresh = useCallback(async () => {
    if (!enabled || !hostClient) return
    const epoch = projectEpoch.current
    setState((current) => ({ ...current, connection: 'connecting', error: null }))
    try {
      const [library, tasks, llmCatalog, generationCatalog] = await Promise.all([
        hostClient.listPackageLibrary(),
        hostClient.listTasks(projectRef),
        hostClient.getLlmCatalog ? hostClient.getLlmCatalog().catch(() => null) : Promise.resolve(null),
        hostClient.getGenerationCatalog ? hostClient.getGenerationCatalog().catch(() => null) : Promise.resolve(null),
      ])
      if (epoch !== projectEpoch.current) return
      projectEventCursor.current = Math.max(
        projectEventCursor.current,
        ...tasks.map((task) => Number.isSafeInteger(task.eventCursor) ? task.eventCursor : 0),
      )
      for (const task of tasks) deliverAgentResults(store, projectRef, task)
      setState((current) => {
        if (current.projectRef.source !== projectRef.source || current.projectRef.id !== projectRef.id) return current
        let next: AgentPanelState = {
          ...current,
          packages: library.packages,
          installations: library.installations ?? [],
          llmCatalog,
          generationCatalog,
          connection: 'live',
          error: null,
        }
        for (const task of tasks) next = reconcileAgentTask(next, task)
        return next
      })
      setPackageRevision(library.revision)
      if (!selectedByProject.has(projectKey)) {
        setSelectedTaskId(tasks[0]?.taskId ?? null)
      }
    } catch (error) {
      if (epoch !== projectEpoch.current) return
      setState((current) => ({
        ...current,
        connection: 'offline',
        error: error instanceof Error ? error.message : 'Agent transport unavailable',
      }))
    }
  }, [enabled, hostClient, projectKey, projectRef, setSelectedTaskId, store])

  useEffect(() => {
    if (!enabled || !hostClient) return
    void refresh()
  }, [enabled, refresh])

  useEffect(() => {
    // Cloud's project journal is the single authoritative stream. Do not also
    // open one SSE connection per task (the Cloud route intentionally exposes
    // only /agents/events?after).
    if (!enabled || !hostClient || hostClient.subscribeProject) return
    const epoch = projectEpoch.current
    const isCurrent = () => epoch === projectEpoch.current
    const cleanups = state.tasks.map((task) => hostClient.subscribe(
      task.taskId,
      task.eventCursor,
      (event) => {
        const incoming = eventTask(event)
        if (incoming) {
          if (!isCurrent()) return
          deliverAgentResults(store, projectRef, incoming)
          setState((current) => reconcileAgentTask(current, incoming))
        }
        const progress = eventProgress(event)
        if (progress) {
          if (!isCurrent()) return
          setState((current) => reconcileAgentTaskProgress(
            current,
            progress.taskId,
            progress.progress,
            progress.revision,
          ))
        }
        // The Host SSE journal is authoritative for liveness, but compact
        // events intentionally omit the whole snapshot. Fetch once after a
        // review/result/terminal event so the panel sees receipts and canvas
        // slots without turning into a polling loop.
        if (!incoming && !progress && eventTaskId(event)) {
          void hostClient.getTask(eventTaskId(event)!).then((fresh) => {
            if (!isCurrent()) return
            deliverAgentResults(store, projectRef, fresh)
            setState((current) => reconcileAgentTask(current, fresh))
          }).catch(() => undefined)
        }
      },
      (connection) => { if (isCurrent()) setState((current) => ({ ...current, connection })) },
    ))
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [enabled, hostClient, projectRef, state.tasks.map((task) => task.taskId).join('|'), store])

  // Cloud exposes one project journal for new tasks and peer updates. Keep it
  // separate from per-task streams so another member's launch appears without
  // polling or a reload, while the task-id reconciliation still deduplicates a
  // delivery that also arrives on the task stream.
  useEffect(() => {
    if (!enabled || !hostClient?.subscribeProject) return
    const epoch = projectEpoch.current
    const isCurrent = () => epoch === projectEpoch.current
    return hostClient.subscribeProject(projectRef, projectEventCursor.current, (event) => {
      if (!isCurrent()) return
      const value = event as unknown as Record<string, unknown>
      if (typeof value.cursor === 'number' && Number.isSafeInteger(value.cursor)) {
        projectEventCursor.current = Math.max(projectEventCursor.current, value.cursor)
      }
      const incoming = eventTask(event)
      if (incoming) {
        deliverAgentResults(store, projectRef, incoming)
        setState((current) => reconcileAgentTask(current, incoming))
        return
      }
      const taskId = eventTaskId(event)
      if (!taskId) return
      void hostClient.getTask(taskId).then((fresh) => {
        if (!isCurrent()) return
        deliverAgentResults(store, projectRef, fresh)
        setState((current) => reconcileAgentTask(current, fresh))
      }).catch(() => undefined)
    }, (connection) => {
      if (isCurrent()) setState((current) => ({ ...current, connection }))
    })
  }, [enabled, hostClient, projectRef, store])

  const captureGenerationInputs = useCallback(async (capture: AgentGenerationCaptureRequest): Promise<AgentGenerationCaptureReceipt[]> => {
    if (!hostClient?.captureGenerationInputs) throw new Error('This transport cannot capture native media for generation')
    return hostClient.captureGenerationInputs(capture)
  }, [hostClient])


  const start = useCallback(async ({ packageId, taskType, input, capturedArtifacts, llm, generation, launchInputs, requestId: suppliedRequestId, packageVersion, packageSha, catalogRevision }: { packageId: string; taskType: string; input: Record<string, unknown>; capturedArtifacts?: AgentGenerationCaptureReceipt[]; llm?: AgentLlmAuthorization; generation?: AgentGenerationAuthorization; launchInputs?: AgentInputItem[]; requestId?: string; packageVersion?: string; packageSha?: string; catalogRevision?: number }) => {
    const selectedItems = store.getSelectedItems()
    // The composer may have captured a tuple a render ago. Reusing the exact
    // mapped inputs from that render prevents a fast selection change from
    // pairing a receipt with a different board item (the old grant-mismatch
    // failure). Cloud receives its native refs separately.
    const inputs = launchInputs ?? applyCapturedArtifacts(selectedItems.map(agentInputFromCanvasItem), capturedArtifacts)
    const epoch = projectEpoch.current
    const requestId = suppliedRequestId ?? makeAgentRequestId('task')
    if (!hostClient) {
      const error = new Error('Agents are not connected to this transport')
      setState((current) => rejectPendingAgentStart(current, requestId, error.message))
      throw error
    }
    // Paint the durable-looking submitting row before awaiting the network.
    // Retries reuse the same requestId from the composer and therefore cannot
    // create a second Cloud/Host task.
    setState((current) => addPendingAgentStart(current, {
      requestId, packageId, taskType, instruction: instruction.trim(), startedAt: Date.now(),
    }))
    try {
      const task = await hostClient.startTask({
        requestId, projectRef, packageId, taskType,
        instruction: instruction.trim(), input, inputs, ...(capturedArtifacts ? { capturedArtifacts } : {}), ...(llm ? { llm } : {}), ...(generation ? { generation } : {}),
        ...(packageVersion ? { packageVersion } : {}),
        ...(packageSha ? { packageSha } : {}),
        ...(catalogRevision !== undefined ? { catalogRevision } : {}),
      })
      if (epoch !== projectEpoch.current) return
      deliverAgentResults(store, projectRef, task)
      setState((current) => reconcileAgentTask({ ...current, connection: 'live' }, task))
      setSelectedTaskId(task.taskId)
      setInstruction('')
    } catch (error) {
      if (epoch !== projectEpoch.current) throw error
      const failure = classifyAgentHostFailure(error)
      setState((current) => ({
        ...rejectPendingAgentStart(current, requestId, failure.message),
        connection: failure.domainRefusal ? 'live' : 'offline',
        error: failure.domainRefusal ? failure.message : failure.message,
      }))
      if (failure.refreshLibrary) void refresh()
      throw error
    }
  }, [hostClient, instruction, projectRef, refresh, setInstruction, setSelectedTaskId, store])

  const command = useCallback(async (taskId: string, action: AgentAction) => {
    if (!hostClient) {
      setState((current) => rejectAgentAction(current, taskId, 'Agents are not connected to this transport'))
      return
    }
    const revision = state.tasks.find((task) => task.taskId === taskId)?.revision ?? 0
    const requestId = state.pendingRequestIds[taskId] ?? state.retryRequestIds[taskId] ?? makeAgentRequestId('command')
    const epoch = projectEpoch.current
    setState((current) => optimisticallyRequestAgentAction(current, taskId, action, requestId))
    try {
      const task = await hostClient.commandTask(taskId, action, {
        requestId, expectedRevision: revision, reason: `ui:${action}`,
      })
      if (epoch !== projectEpoch.current) return
      setState((current) => reconcileAgentTask(current, task))
    } catch (error) {
      if (epoch !== projectEpoch.current) return
      setState((current) => rejectAgentAction(
        current,
        taskId,
        error instanceof Error ? error.message : 'Team request was rejected by the transport',
      ))
    }
  }, [hostClient, state.tasks])

  const decide = useCallback(async (
    taskId: string,
    reviewId: string,
    decision: AgentDecisionPayload['decision'],
    comment: string,
    consent?: boolean,
  ) => {
    if (!hostClient) {
      setState((current) => ({ ...current, error: 'Agents are not connected to this transport' }))
      return
    }
    const current = state.tasks.find((task) => task.taskId === taskId)
    const review = current?.reviews.find((candidate) => candidate.reviewId === reviewId)
    if (!current || !review || !isCurrentAgentReview(current, reviewId)
      || (decision !== 'approved' && !comment.trim())) return
    const payload: AgentDecisionRequest = {
      requestId: makeAgentRequestId('review'), expectedRevision: current.revision,
      reviewId, revision: review.revision, decision, comment: comment.trim(), answers: {},
      ...(consent === true ? { consent: true } : {}),
    }
    const epoch = projectEpoch.current
    try {
      const task = await hostClient.decideReview(taskId, reviewId, payload)
      if (epoch !== projectEpoch.current) return
      setState((next) => reconcileAgentTask(next, task))
    } catch (error) {
      if (epoch !== projectEpoch.current) return
      setState((next) => ({
        ...next,
        error: error instanceof Error ? error.message : 'Decision was rejected by the transport',
      }))
    }
  }, [hostClient, state.tasks])

  const selectedTask = state.tasks.find((task) => task.taskId === selectedTaskId)
  const demoPackage = state.packages.find((pkg) => /demo|test|example/i.test(`${pkg.id} ${pkg.name}`))
    ?? state.packages[0]
  return {
    state, collapsed, setCollapsed, instruction, setInstruction,
    selectedTaskId, setSelectedTaskId, selectedTask, demoPackage,
    llmCatalog: state.llmCatalog,
    generationCatalog: state.generationCatalog,
    packageRevision, captureGenerationInputs, start, command, decide, refresh,
  }
}

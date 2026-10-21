import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { AgentDecisionPayload, ProjectRef } from '../../../../../packages/agent-protocol/index'
import type { CanvasStore } from '../konva/canvasStore'
import { InlineNotice } from '../../../ui/InlineNotice'
import {
  IconCaretDown,
  IconClose,
  IconLLM,
} from '../../../ui/icons'
import { Tooltip } from '../../../ui/Tooltip'
import { agentActionGrants, isAgentTaskActive, taskProgressForDisplay, taskReview } from './agentPanelModel'
import type { AgentPanelController } from './agentPanelController'
import type { AgentPresentationCapability } from './agentCapabilities'
import { agentTaskLabel } from './agentPanelPresentation'
import { agentPanelHasHeaderRoom, useAgentPanelLayout } from './agentPanelLayout'
import { AgentTaskDetail } from './AgentTaskDetail'
import { taskBudgetSnapshot } from './agentBudgetModel'
import { useT } from '../../../i18n/context.js'


const stateLabel: Record<string, string> = {
  queued: 'Queued', running: 'Running', awaiting_review: 'Waiting for a decision',
  awaiting_input: 'Waiting for input', awaiting_connection: 'Waiting for connection',
  pausing: 'Pausing…', paused: 'Paused', cancelling: 'Stopping…',
  cancelled: 'Stopped', succeeded: 'Done', failed: 'Error', uncertain: 'Needs review',
}

function taskTone(state: string): 'active' | 'ok' | 'error' | 'muted' {
  if (state === 'succeeded') return 'ok'
  if (state === 'failed' || state === 'cancelled' || state === 'uncertain') return 'error'
  if (state === 'paused') return 'muted'
  return 'active'
}

export function AgentPanel({
  projectRef,
  store,
  enabled,
  controller,
  capability,
}: {
  projectRef: ProjectRef
  store: CanvasStore
  enabled: boolean
  /** Board-level controller owned by CanvasSpace; keeps one task stream/SSE. */
  controller: AgentPanelController
  /** Transport-owned policy; do not infer this from the project source. */
  capability?: AgentPresentationCapability
}) {
  const t = useT()
  const projectKey = `${projectRef.source}:${projectRef.id}`
  const [reviewComments, setReviewComments] = useState<Record<string, string>>({})
  const [reviewPendingKey, setReviewPendingKey] = useState<string | null>(null)
  const panelLayout = useAgentPanelLayout(enabled)
  const panelBottomReserve = panelLayout?.bottomReserve ?? null
  const compactLayout = panelLayout !== null && !agentPanelHasHeaderRoom(panelLayout.availableHeight)
  const compactPositionUnavailable = compactLayout && panelLayout?.compactPosition === null
  const packages = controller.state.packages
  const { canControl, canReview } = agentActionGrants(capability, controller.selectedTask)
  const activeTasks = useMemo(
    () => controller.state.tasks.filter((task) => isAgentTaskActive(task.state)),
    [controller.state.tasks],
  )
  const selectedReview = controller.selectedTask ? taskReview(controller.selectedTask) : undefined
  const reviewKey = controller.selectedTask && selectedReview
    ? `${controller.selectedTask.taskId}:${selectedReview.reviewId}`
    : null
  const reviewComment = reviewKey ? reviewComments[reviewKey] ?? '' : ''
  const reviewBusy = reviewKey !== null && reviewPendingKey === reviewKey
  const displayProgress = controller.selectedTask ? taskProgressForDisplay(controller.selectedTask) : undefined
  const selectedBudget = controller.selectedTask ? taskBudgetSnapshot(controller.selectedTask) : null

  useEffect(() => {
    setReviewComments({})
    setReviewPendingKey(null)
  }, [projectKey])

  useEffect(() => {
    // There is no honest 48px slot while the dock and asset rail fill the
    // measured viewport. Collapse the panel instead of painting its toggle
    // over a real dock control or an asset slot; it will reappear when a
    // ResizeObserver update finds a safe position again.
    if (compactPositionUnavailable && !controller.collapsed) controller.setCollapsed(true)
  }, [compactPositionUnavailable, controller])

  const submitReview = (decision: AgentDecisionPayload['decision'], comment: string, consent?: boolean) => {
    if (!controller.selectedTask || !selectedReview || !reviewKey) return
    setReviewPendingKey(reviewKey)
    void controller.decide(controller.selectedTask.taskId, selectedReview.reviewId, decision, comment, consent)
      .finally(() => setReviewPendingKey((current) => current === reviewKey ? null : current))
  }

  if (!enabled) return null
  if (compactPositionUnavailable) return null
  if (controller.collapsed) {
    const task = controller.selectedTask ?? activeTasks[0]
    const collapsedCompact = compactLayout && panelLayout?.compactPosition
    const collapsedStyle = collapsedCompact
      ? {
          '--agent-panel-compact-left': `${collapsedCompact.left}px`,
          '--agent-panel-compact-top': `${collapsedCompact.top}px`,
        } as CSSProperties
      : undefined
    return (
      <div className={`agent-panel-collapsed${collapsedCompact ? ' agent-panel-collapsed--compact' : ''}`} style={collapsedStyle}>
        <Tooltip title={t('Agents')} hint={t('Tasks continue even when the panel is closed.')}>
          <button
            type="button"
            className="agent-panel-trigger"
            aria-label={task ? t('Agents: {0}', { 0: stateLabel[task.state] ?? task.state }) : t('Open agents')}
            onClick={() => controller.setCollapsed(false)}
          >
            <IconLLM size={17} />
            {task && <span className={`agent-panel-dot ${taskTone(task.state)}`} aria-hidden="true" />}
          </button>
        </Tooltip>
      </div>
    )
  }

  const selectedTaskLabel = controller.selectedTask
    ? agentTaskLabel(controller.selectedTask.taskType, packages)
    : null
  const panelStyle = panelLayout === null
    ? undefined
    : {
        '--agent-panel-bottom': `${panelBottomReserve}px`,
        '--agent-panel-compact-right': 'auto',
        ...(panelLayout.compactPosition
          ? {
              '--agent-panel-compact-left': `${panelLayout.compactPosition.left}px`,
              '--agent-panel-compact-top': `${panelLayout.compactPosition.top}px`,
            }
          : {}),
      } as CSSProperties

  return (
    <aside className={`agent-panel${compactLayout ? ' agent-panel--compact' : ''}`} aria-label={t('Agents')} style={panelStyle}>
      <header className="agent-panel-header">
        <div className="agent-panel-title">
          <IconLLM size={17} aria-hidden="true" />
          <strong>{t('Agents')}</strong>
          <span className={`agent-panel-connection ${controller.state.connection}`}>
            {controller.state.connection === 'live'
              ? capability?.label ?? 'On this computer'
              : controller.state.connection === 'connecting'
                ? 'Connecting…'
                : controller.state.connection === 'reconnecting' ? 'Connection…' : 'Offline'}
          </span>
        </div>
        <button type="button" className="agent-panel-close" aria-label={t('Collapse agents')} onClick={() => controller.setCollapsed(true)}>
          <IconClose size={15} />
        </button>
      </header>

      {controller.state.error && (
        <InlineNotice tone="warning" system title={t('{0} unavailable', { 0: capability?.label ?? 'Agents' })} detail={controller.state.error} action={{ label: 'Retry', onClick: () => void controller.refresh() }} />
      )}

      {capability?.canObserve && !canControl && capability.reason && (
        <InlineNotice
          className="agent-panel-access-notice"
          tone="info"
          system
          title={t('Agents are view-only')}
          detail={capability?.reason ?? 'This Host session is view-only.'}
        />
      )}

      <div className="agent-panel-scroll agent-panel--tasks">

        <section className="agent-panel-section" aria-labelledby="agent-tasks-title">
          <div className="agent-panel-section-head">
            <span id="agent-tasks-title">{t('Tasks')}</span>
            <span className="agent-panel-count">{controller.state.tasks.length}</span>
          </div>
          {controller.state.tasks.length === 0 && Object.keys(controller.state.pendingStarts ?? {}).length === 0 ? (
            <p className="agent-panel-empty">{t('Started tasks appear here. Closing the board does not stop them.')}</p>
          ) : (
            <div className="agent-task-list">
              {Object.values(controller.state.pendingStarts ?? {}).map((pending) => (
                <div className="agent-task-row agent-task-row--pending" key={`pending:${pending.requestId}`} role="status">
                  <span className="agent-panel-dot active" aria-hidden="true" />
                  <span className="agent-task-copy"><strong>{pending.taskType}</strong><small>{t('Sending…')}</small></span>
                  <span className="agent-task-pending">{t('waiting for approval')}</span>
                </div>
              ))}
              {controller.state.tasks.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((task) => (
                <button
                  type="button"
                  key={task.taskId}
                  className={`agent-task-row ${task.taskId === controller.selectedTaskId ? 'selected' : ''}`}
                  onClick={() => controller.setSelectedTaskId(task.taskId)}
                >
                  <span className={`agent-panel-dot ${taskTone(task.state)}`} aria-hidden="true" />
                  <span className="agent-task-copy"><strong>{agentTaskLabel(task.taskType, packages)}</strong><small>{stateLabel[task.state] ?? 'Updating status'}</small></span>
                  {task.optimisticAction && <span className="agent-task-pending">{t('waiting for approval')}</span>}
                  <IconCaretDown size={14} className="agent-task-chevron" />
                </button>
              ))}
            </div>
          )}
        </section>

        {controller.selectedTask && <AgentTaskDetail
          selectedTask={controller.selectedTask}
          selectedTaskLabel={selectedTaskLabel}
          selectedReview={selectedReview}
          reviewComment={reviewComment}
          reviewKey={reviewKey}
          reviewBusy={reviewBusy}
          displayProgress={displayProgress}
          selectedBudget={selectedBudget}
          generationCatalog={controller.state.generationCatalog}
          canControl={canControl}
          canReview={canReview}
          store={store}
          onReviewCommentChange={(value) => reviewKey && setReviewComments((current) => ({ ...current, [reviewKey]: value }))}
          onSubmitReview={submitReview}
          onCommand={(action) => void controller.command(controller.selectedTask!.taskId, action)}
        />}
      </div>
    </aside>
  )
}

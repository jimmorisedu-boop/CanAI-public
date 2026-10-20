import { useEffect, useState } from 'react'
import type { AgentDecisionPayload, AgentGenerationReviewSpec, AgentReviewView } from '../../../../../packages/agent-protocol/index'
import type { CanvasStore } from '../konva/canvasStore'
import { InlineNotice } from '../../../ui/InlineNotice'
import { IconDone, IconPause, IconRun, IconStop } from '../../../ui/icons'
import { agentStageLabel, agentStatusLabel } from './agentPanelPresentation'
import { AgentReviewMaterials } from './AgentReviewMaterials'
import { agentOutputSummary, isAgentTaskActive, isAgentTaskTerminal, type AgentAction, type AgentTaskProgress, type AgentTaskSnapshot } from './agentPanelModel'
import type { AgentBudgetSnapshot } from './agentBudgetModel'
import { formatUsdMicros } from './agentBudgetModel'
import { generationReviewReadiness } from './agentReviewModel'
import type { AgentGenerationCatalog } from './agentGenerationModel'
import { systemErrorMessage, systemStatusMessage } from '../../../ui/systemMessage'

const stateLabel: Record<string, string> = {
  queued: 'Queued', running: 'Running', awaiting_review: 'Waiting for a decision',
  awaiting_input: 'Waiting for input', awaiting_connection: 'Waiting for connection',
  pausing: 'Pausing…', paused: 'Paused', cancelling: 'Stopping…',
  cancelled: 'Stopped', succeeded: 'Done', failed: 'Error', uncertain: 'Needs review',
}

const budgetStateLabel: Record<string, string> = {
  estimate: 'Estimate', awaiting_consent: 'Waiting for approval', reserved: 'Reserved', running: 'Running',
  charged: 'Actually charged', blocked: 'Limit exhausted', uncertain: 'Needs review', overspent: 'Limit exceeded',
  exhausted: 'Limit exhausted', failed: 'Spending error',
}

function taskTone(state: string): 'active' | 'ok' | 'error' | 'muted' {
  if (state === 'succeeded') return 'ok'
  if (state === 'failed' || state === 'cancelled' || state === 'uncertain') return 'error'
  if (state === 'paused') return 'muted'
  return 'active'
}

const generationKindLabel: Record<AgentGenerationReviewSpec['kind'], string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
}

function reviewParamLabel(key: string): string {
  if (key === 'aspect_ratio') return 'Aspect ratio'
  if (key === 'image_size') return 'Size'
  if (key === 'duration') return 'Duration'
  if (key === 'num_frames') return 'Frames'
  return key
}

function reviewParams(spec: AgentGenerationReviewSpec): string {
  const params = Object.entries(spec.params ?? {})
  if (params.length === 0) return 'Automatic model settings'
  return params.map(([key, value]) => `${reviewParamLabel(key)}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ')
}

function GenerationReviewSpec({
  spec,
  artifacts,
  generationCatalog,
}: {
  spec: AgentGenerationReviewSpec
  artifacts: AgentTaskSnapshot['artifacts']
  generationCatalog?: AgentGenerationCatalog | null
}) {
  const modelLabel = generationCatalog?.models.find((model) => model.id === spec.modelId)?.name
    ?? 'Result model'
  return (
    <div className="agent-generation-review" aria-label="Result parameters">
      <div className="agent-generation-review-head"><strong>Result</strong><span>one call</span></div>
      <dl className="agent-generation-review-facts">
        <div><dt>Type</dt><dd>{generationKindLabel[spec.kind]}</dd></div>
        <div><dt>Model</dt><dd>{modelLabel}</dd></div>
        <div><dt>Estimate</dt><dd>{spec.estimateMicros === undefined ? 'Calculating…' : formatUsdMicros(spec.estimateMicros)}</dd></div>
      </dl>
      <div className="agent-generation-review-field"><strong>Text</strong><p>{spec.prompt?.trim() || 'Text is still being prepared'}</p></div>
      <div className="agent-generation-review-field"><strong>Selected files</strong>
        {spec.refs.length > 0 ? (
          <ol>
            {spec.refs.map((ref, index) => {
              const artifact = artifacts.find((candidate) => candidate.artifactId === ref.artifactId && candidate.revision === ref.revision && candidate.checksum === ref.checksum)
              return <li key={`${ref.artifactId}:${index}`}>{artifact?.caption ?? `File ${index + 1}`}</li>
            })}
          </ol>
        ) : <p>No</p>}
      </div>
      <div className="agent-generation-review-field"><strong>Parameters</strong><p>{reviewParams(spec)}</p></div>
    </div>
  )
}

export function AgentTaskDetail({
  selectedTask,
  selectedTaskLabel,
  selectedReview,
  reviewComment,
  reviewKey,
  reviewBusy,
  displayProgress,
  selectedBudget,
  generationCatalog,
  canControl,
  canReview,
  store,
  onReviewCommentChange,
  onSubmitReview,
  onCommand,
}: {
  selectedTask: AgentTaskSnapshot
  selectedTaskLabel: string | null
  selectedReview: AgentReviewView | undefined
  reviewComment: string
  reviewKey: string | null
  reviewBusy: boolean
  displayProgress: AgentTaskProgress | undefined
  selectedBudget: AgentBudgetSnapshot | null
  generationCatalog?: AgentGenerationCatalog | null
  canControl: boolean
  canReview: boolean
  store: CanvasStore
  onReviewCommentChange(value: string): void
  onSubmitReview(decision: AgentDecisionPayload['decision'], comment: string, consent?: boolean): void
  onCommand(action: AgentAction): void
}) {
  const [approveArmed, setApproveArmed] = useState(false)
  // Второй клик снимает прицел сам, как в архиве, — долго «взведённой» кнопка не остаётся.
  useEffect(() => {
    if (!approveArmed) return
    const timer = window.setTimeout(() => setApproveArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [approveArmed])
  // Смена ревью/задачи сбрасывает взведённое согласие, чтобы оно не переехало в чужие ревью.
  useEffect(() => { setApproveArmed(false) }, [reviewKey])
  const output = agentOutputSummary(selectedTask)
  const reviewReadiness = generationReviewReadiness(selectedReview)
  const hasResultMaterial = selectedReview?.materials.some((material) => material.role === 'result') ?? false
  // Платная генерация — это одобрение «Create» (есть спецификация запуска и none readyго результата).
  // На десктопе согласие not required: сервер сам игнорирует его.
  const isPaidApprove = Boolean(selectedReview?.generationSpec) && !hasResultMaterial
  const reviewApproveLabel = hasResultMaterial
    ? 'Add to canvas'
    : selectedReview?.generationSpec
      ? 'Create'
      : 'Approve'
  const reviewQuestion = selectedReview?.generationSpec && !hasResultMaterial
    ? 'Create a result from this description?'
    : hasResultMaterial
      ? 'Add the selected result to the canvas?'
      : selectedReview?.question
  const progressLabel = selectedTask.progress
    ? systemStatusMessage(selectedTask.progress.label, 'Working…')
    : undefined
  return (
    <section className="agent-panel-section agent-task-detail" aria-labelledby="agent-detail-title">
      <div className="agent-panel-section-head">
        <span id="agent-detail-title">{selectedTaskLabel}</span>
        <span className={`agent-task-state ${taskTone(selectedTask.state)}`}>{stateLabel[selectedTask.state] ?? 'Updating status'}</span>
      </div>
      <p className="agent-task-instruction">{selectedTask.instruction}</p>
      {selectedTask.redacted && (
        <InlineNotice
          tone="info"
          title="Task summary"
          detail="Personal inputs, profile, and checkpoints are hidden from non-owner participants by the server."
        />
      )}
      <dl className="agent-task-facts">
        <div><dt>Stage</dt><dd>{isAgentTaskTerminal(selectedTask.state)
          ? (stateLabel[selectedTask.state] ?? 'Completed')
          : progressLabel ?? (selectedReview ? agentStageLabel(selectedReview.stageId) : 'Stage not reported yet')}</dd></div>
        <div><dt>Inputs</dt><dd>{selectedTask.inputs.length}</dd></div>
        <div><dt>Materials</dt><dd>{output.materialCount}</dd></div>
        <div><dt>On canvas</dt><dd>{output.placedCount}</dd></div>
        {output.pendingPlacementCount > 0 && <div><dt>Waiting for canvas</dt><dd>{output.pendingPlacementCount}</dd></div>}
      </dl>
      {selectedBudget && (
        <div className={`agent-task-budget ${selectedBudget.status === 'blocked' || selectedBudget.status === 'uncertain' || selectedBudget.status === 'overspent' || selectedBudget.status === 'exhausted' ? 'warning' : ''}`} aria-label="Agent spending">
          <div className="agent-task-budget-head"><strong>Agent spending</strong><span>{budgetStateLabel[selectedBudget.status] ?? 'Status is updating'}</span></div>
          <dl className="agent-task-budget-facts">
            {(selectedBudget.estimateMicros !== undefined || selectedBudget.limitMicros !== undefined) && <div><dt>{selectedBudget.estimateMicros !== undefined ? 'Estimated total budget' : 'Total budget limit'}</dt><dd>{formatUsdMicros(selectedBudget.estimateMicros ?? selectedBudget.limitMicros)}</dd></div>}
            {selectedBudget.calls !== undefined && selectedBudget.maxCalls !== undefined && (
              <div><dt>Calls</dt><dd>{selectedBudget.calls} / {selectedBudget.maxCalls}</dd></div>
            )}
            {selectedBudget.pins && selectedBudget.pins.length > 0 && (
              <div>
                <dt>Pinned models</dt>
                <dd>
                  {selectedBudget.pins.map((pin) => `${pin.kind === 'image' ? 'Image' : pin.kind === 'video' ? 'Video' : 'Audio'}: ${pin.modelId}`).join(' · ')}
                </dd>
              </div>
            )}
            {selectedBudget.reservedMicros !== undefined && <div><dt>Reserved</dt><dd>{formatUsdMicros(selectedBudget.reservedMicros)}</dd></div>}
            {selectedBudget.chargedMicros !== undefined && <div><dt>Actual</dt><dd>{formatUsdMicros(selectedBudget.chargedMicros)}</dd></div>}
            {selectedBudget.remainingMicros !== undefined && <div><dt>Remaining</dt><dd>{formatUsdMicros(selectedBudget.remainingMicros)}</dd></div>}
          </dl>
          {selectedBudget.overshootMicros !== undefined && selectedBudget.overshootMicros > 0 && <p className="agent-task-budget-note">The last call exceeded the estimated limit by {formatUsdMicros(selectedBudget.overshootMicros)}; new paid calls are blocked until a new explicit task is submitted.</p>}
          {selectedBudget.message && <p className="agent-task-budget-note">{systemErrorMessage(selectedBudget.message, 'Budget status is unavailable')}</p>}
        </div>
      )}
      {displayProgress && selectedTask.progress && (
        <div className="agent-task-progress" aria-label={`Progress: ${progressLabel ?? 'Working…'}`}>
          <div className="agent-task-progress-head">
            <span>{progressLabel ?? 'Working…'}</span>
            <span>{typeof selectedTask.progress.completed === 'number' && typeof selectedTask.progress.total === 'number' && selectedTask.progress.total > 0
              ? `${Math.round((selectedTask.progress.completed / selectedTask.progress.total) * 100)}%`
              : agentStatusLabel(selectedTask.progress.status, stateLabel)}</span>
          </div>
          {typeof selectedTask.progress.completed === 'number' && typeof selectedTask.progress.total === 'number' && selectedTask.progress.total > 0 && (
            <div className="agent-task-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={selectedTask.progress.total} aria-valuenow={Math.min(selectedTask.progress.completed, selectedTask.progress.total)}>
              <span style={{ width: `${Math.min(100, Math.max(0, (selectedTask.progress.completed / selectedTask.progress.total) * 100))}%` }} />
            </div>
          )}
        </div>
      )}
      <div className="agent-task-actions">
        {selectedTask.state === 'paused' ? (
          <button type="button" className="ui-btn" disabled={!canControl || Boolean(selectedTask.optimisticAction)} onClick={() => onCommand('resume')}><IconRun size={13} /> Resume</button>
        ) : isAgentTaskActive(selectedTask.state) && (
          <button type="button" className="ui-btn" disabled={!canControl || Boolean(selectedTask.optimisticAction)} onClick={() => onCommand('pause')}><IconPause size={13} /> Pause</button>
        )}
        {isAgentTaskActive(selectedTask.state) && (
          <button type="button" className="ui-btn danger" disabled={!canControl || Boolean(selectedTask.optimisticAction)} onClick={() => onCommand('cancel')}><IconStop size={13} /> Stop</button>
        )}
        {selectedTask.canvasItems.length > 0 && (
          <button type="button" className="ui-btn quiet" onClick={() => store.revealItems(selectedTask.canvasItems.map((item) => item.itemId))}>Go to result</button>
        )}
      </div>
      {selectedReview && (
        <div className="agent-review-card">
          <strong>{selectedReview.title}{reviewBusy && <span className="agent-task-pending"> · waiting for approval</span>}</strong>
          <p>{reviewQuestion}</p>
          <AgentReviewMaterials materials={selectedReview.materials} artifacts={selectedTask.artifacts} />
          {selectedReview.generationSpec && <GenerationReviewSpec spec={selectedReview.generationSpec} artifacts={selectedTask.artifacts} generationCatalog={generationCatalog} />}
          {!reviewReadiness.ready && selectedReview.decisions.includes('approved') && <InlineNotice tone="warning" system title="Exact run details are required" detail={reviewReadiness.reason ?? 'The parameters for this attempt have not been approved yet.'} />}
          {selectedReview.extraQuestions && selectedReview.extraQuestions.length > 0 && <InlineNotice tone="info" title="Additional questions" detail="Only a decision comment is available for these questions." />}
          <textarea
            aria-label="Decision comment"
            value={reviewComment}
            onChange={(event) => { if (reviewKey) onReviewCommentChange(event.target.value) }}
            placeholder="A comment is required to request changes or reject"
            rows={2}
          />
          <div className="agent-review-actions">
            {selectedReview.decisions.includes('approved') && (
              approveArmed && isPaidApprove ? (
                <>
                  <button type="button" className="ui-btn quiet" onClick={() => setApproveArmed(false)}>Change my mind</button>
                  <button type="button" className="ui-btn primary armed" disabled={!canReview || reviewBusy} onClick={() => onSubmitReview('approved', reviewComment, true)}><IconDone size={13} /> Approve run</button>
                  <span className="agent-consent-note">This will start a paid generation. Click again to continue.</span>
                </>
              ) : (
                <button type="button" className="ui-btn primary" disabled={!canReview || reviewBusy || !reviewReadiness.ready} onClick={() => isPaidApprove ? setApproveArmed(true) : onSubmitReview('approved', reviewComment)}><IconDone size={13} /> {reviewApproveLabel}</button>
              )
            )}
            {selectedReview.decisions.includes('changes-requested') && <button type="button" className="ui-btn" disabled={!canReview || reviewBusy || !reviewComment.trim()} onClick={() => onSubmitReview('changes-requested', reviewComment)}>Request changes</button>}
            {selectedReview.decisions.includes('rejected') && <button type="button" className="ui-btn danger" disabled={!canReview || reviewBusy || !reviewComment.trim()} onClick={() => onSubmitReview('rejected', reviewComment)}>Reject</button>}
          </div>
        </div>
      )}
    </section>
  )
}

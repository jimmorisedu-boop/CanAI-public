/* Hallmark · component: task group · genre: restrained workspace · theme: CanAI existing
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: inherits verified application tokens
 */
import { useEffect, useState } from 'react'
import { IconClose, IconFit, IconNext, IconRefresh, IconStop } from '../../ui/icons'
import type { GenerationLaunchGroup } from './generationLaunches'
import { generationConnectionLabel, type GenerationTask, type GenerationTaskState } from './generationRegistry'
import { launchGroupView } from './launchGroupPresentation'
import { systemErrorMessage } from '../../ui/systemMessage'

const CONFIRM_MS = 4_000
const ACTIVE_STATES: GenerationTaskState[] = ['queued', 'running']
const TERMINAL_STATES: GenerationTaskState[] = ['done', 'error', 'cancelled']

const STATE_LABELS: Record<GenerationTaskState, string> = {
  queued: "Queued",
  running: "Generating",
  cancelling: "Stopping…",
  cancelled: "Cancelled",
  done: "Done",
  error: "Error",
}

export interface GenerationLaunchGroupRowProps {
  group: GenerationLaunchGroup
  expanded: boolean
  currentProjectId?: string
  onToggle(): void
  onShow(jobIds: string[]): void
  onCancel(jobId: string): void
  onRetry(jobId: string): void
  onDismiss(jobId: string): void
}

export function generationLaunchGroupActionIds(group: GenerationLaunchGroup): {
  show: string[]
  showLabel: string
  cancel: string[]
  retry: string[]
  dismiss: string[]
} {
  const done = group.variants.filter((variant) => variant.state === 'done').length
  return {
    // У одиночного запуска «результаты» во множественном числе — лишнее слово:
    // показывать там нечего, кроме одной картинки.
    showLabel: group.variantCount === 1
      ? "Show"
      : done > 0 ? "Show results" : "Show on canvas",
    // Показать можно не только готовое: заглушки встают правее предыдущих и
    // быстро уезжают за край экрана — тогда идущую генерацию не видно вовсе
    // (найдено прогоном 20.08.2026). Камеру сами НЕ двигаем: подъезжаем
    // только по нажатию, чтобы не мешать работе.
    show: group.variants
      .filter((variant) => variant.state === 'done' || ACTIVE_STATES.includes(variant.state))
      .map((variant) => variant.jobId),
    cancel: group.variants
      .filter((variant) => ACTIVE_STATES.includes(variant.state))
      .map((variant) => variant.jobId),
    retry: group.variants
      .filter((variant) => variant.state === 'error' && variant.retry)
      .map((variant) => variant.jobId),
    dismiss: group.variants
      .filter((variant) => TERMINAL_STATES.includes(variant.state))
      .map((variant) => variant.jobId),
  }
}

function terminalCount(group: GenerationLaunchGroup): number {
  return group.variants.filter((variant) => TERMINAL_STATES.includes(variant.state)).length
}

function variantNumber(task: GenerationTask): number {
  return task.launch?.variantIndex ?? 1
}

function elapsedLabel(task: GenerationTask): string | null {
  if (!ACTIVE_STATES.includes(task.state)) return null
  const seconds = Math.max(0, Math.floor((Date.now() - task.createdAt) / 1_000))
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function GenerationLaunchGroupRow({
  group,
  expanded,
  currentProjectId,
  onToggle,
  onShow,
  onCancel,
  onRetry,
  onDismiss,
}: GenerationLaunchGroupRowProps) {
  const [confirmStop, setConfirmStop] = useState(false)
  const actions = generationLaunchGroupActionIds(group)
  const detailsId = `launch-details-${group.launchId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const view = launchGroupView(group, { currentProjectId })
  const allSettled = group.variants.every((variant) => TERMINAL_STATES.includes(variant.state))
  const hasPrimaryActions = actions.show.length > 0 || actions.cancel.length > 0 || actions.retry.length > 0

  useEffect(() => {
    if (!confirmStop) return
    const timer = window.setTimeout(() => setConfirmStop(false), CONFIRM_MS)
    return () => window.clearTimeout(timer)
  }, [confirmStop])

  useEffect(() => {
    if (actions.cancel.length === 0) setConfirmStop(false)
  }, [actions.cancel.length])

  function stopRemaining(): void {
    if (!confirmStop) {
      setConfirmStop(true)
      return
    }
    setConfirmStop(false)
    for (const jobId of actions.cancel) onCancel(jobId)
  }

  return (
    <article
      className={`task-launch-group ${group.status}`}
      aria-label={`${view.title}, ${view.summary}`}
    >
      <div className="task-launch-main">
        <div className="task-launch-heading">
          {/* Разворачивать по вариантам есть смысл, только когда их больше
              одного: у одиночного запуска внутри ровно то же, что и снаружи. */}
          <button
            type="button"
            className={view.expandable ? 'task-launch-disclosure' : 'task-launch-disclosure single'}
            aria-expanded={view.expandable ? expanded : undefined}
            aria-controls={view.expandable ? detailsId : undefined}
            disabled={!view.expandable}
            onClick={onToggle}
          >
            {view.expandable && <IconNext size={13} className={expanded ? 'expanded' : undefined} />}
            <span className="task-launch-copy">
              <strong title={view.title}>{view.title}</strong>
              {view.meta && <span className="task-launch-meta">{view.meta}</span>}
              <span className={`task-launch-summary ${group.status}`}>{view.summary}</span>
            </span>
          </button>

          {allSettled && actions.dismiss.length > 0 && (
            <button
              type="button"
              className="icon-btn task-launch-dismiss"
              aria-label="Remove run from list"
              onClick={() => actions.dismiss.forEach(onDismiss)}
            >
              <IconClose size={13} />
            </button>
          )}
        </div>

        {/* Полоса нужна, пока есть чего ждать. У законченного запуска она
            всегда полная и сообщает ровно ничего — только шумит в списке. */}
        {view.showProgress && (
          <div
            className="task-launch-progress"
            role="progressbar"
            aria-label={`Completed variants: ${terminalCount(group)} of ${group.variantCount}`}
            aria-valuemin={0}
            aria-valuemax={group.variantCount}
            aria-valuenow={terminalCount(group)}
          >
            <span style={{ width: `${group.variantCount > 0 ? (terminalCount(group) / group.variantCount) * 100 : 0}%` }} />
          </div>
        )}

        {hasPrimaryActions && (
          <div className="task-launch-group-actions">
            {actions.show.length > 0 && (
              <button type="button" onClick={() => onShow(actions.show)}>
                <IconFit size={13} /> {actions.showLabel}
              </button>
            )}
            {actions.cancel.length > 0 && (
              <button
                type="button"
                className={confirmStop ? 'armed' : undefined}
                onClick={stopRemaining}
              >
                <IconStop size={13} /> {confirmStop ? "Stop this run?" : view.expandable ? "Stop remaining" : "Stop"}
              </button>
            )}
            {actions.retry.length > 0 && (
              <button type="button" onClick={() => actions.retry.forEach(onRetry)}>
                <IconRefresh size={13} /> {view.expandable ? "Retry failed" : "Retry"}
              </button>
            )}
          </div>
        )}
      </div>

      {expanded && view.expandable && (
        <div className="task-launch-variants" id={detailsId}>
          {group.variants.map((variant) => {
            const index = variantNumber(variant)
            const elapsed = elapsedLabel(variant)
            const connection = generationConnectionLabel(variant.connection)
            return (
              <div className={`task-launch-variant ${variant.state}`} key={variant.jobId}>
                <span className="task-launch-variant-number">{index}</span>
                <span className="task-launch-variant-state">
                  {connection ?? STATE_LABELS[variant.state]}{elapsed ? ` · ${elapsed}` : ''}
                  {variant.error && <small title={systemErrorMessage(variant.error)}>{systemErrorMessage(variant.error)}</small>}
                </span>
                <span className="task-launch-variant-actions">
                  {variant.state === 'done' && (
                    <button type="button" aria-label={`Show variant ${index}`} onClick={() => onShow([variant.jobId])}>
                      <IconFit size={12} /> Show
                    </button>
                  )}
                  {ACTIVE_STATES.includes(variant.state) && (
                    <button type="button" aria-label={`Stop variant ${index}`} onClick={() => onCancel(variant.jobId)}>
                      <IconStop size={12} /> Stop
                    </button>
                  )}
                  {variant.state === 'error' && variant.retry && (
                    <button type="button" aria-label={`Retry variant ${index}`} onClick={() => onRetry(variant.jobId)}>
                      <IconRefresh size={12} /> Retry
                    </button>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </article>
  )
}

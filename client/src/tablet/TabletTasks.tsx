import { useSyncExternalStore } from 'react'
import { minutesSince } from './taskTime'
import {
  cancelGeneration,
  canRetryGeneration,
  dismissGenerationTask,
  generationConnectionLabel,
  getGenerationTasks,
  retryGeneration,
  subscribeGenerationTasks,
  type GenerationTask,
} from '../spaces/canvas/generationRegistry'
import { tabletSystemMessage, tabletSystemStatus } from './tabletSystemMessage'
import { useT } from '../i18n/context.js'
import { t as translate } from '../i18n/translate.js'

// Что сейчас считается. Тот же реестр, что на компьютере, — а значит здесь
// видно и то, что запустили ТАМ: задачи живут на сервере, а доска их
// возобновляет при открытии.

const STATE_LABEL: Record<GenerationTask['state'], string> = {
  queued: 'queued',
  running: 'running',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
  done: 'done',
  error: 'failed',
}

function taskStateLabel(task: GenerationTask): string {
  const label = generationConnectionLabel(task.connection) ?? STATE_LABEL[task.state]
  return translate(tabletSystemStatus(label, translate('Working…')))
}

export function TabletTasks({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const t = useT()
  const tasks = useSyncExternalStore(subscribeGenerationTasks, getGenerationTasks, getGenerationTasks)
  const mine = tasks.filter((task) => task.target.kind === 'canvas' && task.target.projectId === projectId)
  const active = mine.filter((task) => task.state === 'queued' || task.state === 'running' || task.state === 'cancelling')
  const rest = mine.filter((task) => !active.includes(task))
    .sort((a, b) => (Number.isFinite(b.createdAt) ? b.createdAt : 0) - (Number.isFinite(a.createdAt) ? a.createdAt : 0)).slice(0, 12)
  return (
    <>
      <div className="tablet-sheet-backdrop" onPointerDown={onClose} />
      <div className="tablet-sheet tablet-tasks" role="dialog" aria-label={t('Tasks')}>
        <p className="tablet-sheet-title">{t('Tasks')}</p>
        <div className="tablet-task-list">
          <div className="tablet-task-section-head">
            <strong>{t('Generations · Active')}</strong>
            <span>{active.length > 0 ? active.length : t('No active tasks')}</span>
          </div>
          {active.map((task) => (
            <div className="tablet-task" key={task.jobId}>
              <div>
                <strong>{task.launch?.modelName ?? 'Generation'}</strong>
                <span>{taskStateLabel(task)} · {minutesSince(task.createdAt)}</span>
                {task.error && <span className="tablet-task-error">{tabletSystemMessage(task.error, t('Generation failed.'))}</span>}
              </div>
              <button type="button" className="ui-btn" onClick={() => void cancelGeneration(task.jobId)}>{t('Stop')}</button>
            </div>
          ))}
          {rest.length > 0 && <div className="tablet-task-section-head"><strong>{t('Recent')}</strong></div>}
          {rest.map((task) => (
            <div className="tablet-task" key={task.jobId}>
              <div>
                <strong>{task.launch?.modelName ?? 'Generation'}</strong>
                <span>{taskStateLabel(task)} · {minutesSince(task.createdAt)}</span>
                {task.error && <span className="tablet-task-error">{tabletSystemMessage(task.error, t('Generation failed.'))}</span>}
              </div>
              {canRetryGeneration(task.jobId) ? (
                <button type="button" className="ui-btn" onClick={() => void retryGeneration(task.jobId)}>{t('Run again')}</button>
              ) : (
                <button type="button" className="ui-btn" onClick={() => dismissGenerationTask(task.jobId)}>{t('Remove')}</button>
              )}
            </div>
          ))}
          {mine.length === 0 && <p className="tablet-task-empty">{t('Started generations appear here.')}</p>}
        </div>
        <button type="button" className="ui-btn quiet tablet-sheet-cancel" onClick={onClose}>{t('Close')}</button>
      </div>
    </>
  )
}

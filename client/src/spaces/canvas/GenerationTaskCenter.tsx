import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { announce } from '../../ui/announce'
import { IconStop, IconTasks } from '../../ui/icons'
import { GenerationLaunchGroupRow } from './GenerationLaunchGroupRow'
import { Tooltip } from '../../ui/Tooltip'
import { groupGenerationTasks, type GenerationLaunchGroup } from './generationLaunches'
import {
  cancelGeneration,
  dismissGenerationTask,
  getGenerationTasks,
  retryGeneration,
  subscribeGenerationTasks,
  type GenerationTask,
} from './generationRegistry'
import {
  requestGenerationResultNavigation,
  type GenerationResultNavigationRequest,
} from './generationResultNavigation'
import {
  getMacroRuns,
  stopAllMacroRuns,
  stopMacroRun,
  subscribeMacroRuns,
} from './macroRuns'
import { taskAnnouncement } from './taskAnnouncements'
import { systemErrorMessage, systemStatusMessage } from '../../ui/systemMessage'
import { useT } from '../../i18n/context.js'


const ACTIVE_JOB_STATES: GenerationTask['state'][] = ['queued', 'running', 'cancelling']
const TERMINAL_JOB_STATES: GenerationTask['state'][] = ['done', 'error', 'cancelled']
const FINISHED_LIMIT = 6
const CONFIRM_MS = 4_000

function groupIsActive(group: GenerationLaunchGroup): boolean {
  return group.variants.some((variant) => ACTIVE_JOB_STATES.includes(variant.state))
}

export function showGenerationTaskResults(
  request: GenerationResultNavigationRequest,
  close: () => void,
  triggerRef: { readonly current: HTMLButtonElement | null },
  requestFrame: (callback: FrameRequestCallback) => number = (callback) =>
    window.requestAnimationFrame(callback),
): void {
  requestGenerationResultNavigation(request)
  close()
  requestFrame(() => triggerRef.current?.focus({ preventScroll: true }))
}

export function GenerationTaskCenter({ currentProjectId }: { currentProjectId?: string }) {
  const t = useT()
  const tasks = useSyncExternalStore(
    subscribeGenerationTasks,
    getGenerationTasks,
    getGenerationTasks,
  )
  const runs = useSyncExternalStore(subscribeMacroRuns, getMacroRuns, getMacroRuns)
  /**
   * ⚠️ Слежения за внешним редактором здесь БОЛЬШЕ НЕТ (просьба 08.09.2026:
   * «не будем в задачах указывать висящие задачи с внешним редактором»).
   * Задача — это то, что считается и стоит денег; открытый в Фотошопе файл
   * не считается и не стоит ничего, а список копил такие строки днями:
   * сессии живут семь суток и переживают перезапуск, и человек видел четыре
   * «жду сохранения» от файлов, о которых давно забыл. Ответ на сохранение —
   * сама правка на холсте; сломанную сессию по-прежнему показывает угол
   * сообщений (externalEditNotices → needsAttention).
   */
  const announcedRef = useRef<GenerationTask[]>(tasks)
  const launchAnnouncementFingerprintsRef = useRef(new Map<string, string>())
  useEffect(() => {
    const said = taskAnnouncement(
      announcedRef.current,
      tasks,
      launchAnnouncementFingerprintsRef.current,
    )
    announcedRef.current = tasks
    if (said) {
      const isErrorAnnouncement = said.includes('ошиб') || /\b(?:error|failed|failure|unable)\b/i.test(said)
      announce(said, isErrorAnnouncement ? 'assertive' : 'polite')
    }
  }, [tasks])

  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [confirmStopAll, setConfirmStopAll] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const groups = useMemo(() => groupGenerationTasks(tasks), [tasks])
  const visibleGroups = useMemo(() => {
    const active = groups.filter(groupIsActive)
    const finished = groups.filter((group) => !groupIsActive(group))
    return [...active, ...finished.slice(0, FINISHED_LIMIT)]
  }, [groups])

  // Число на триггере — операции, которые реально можно остановить, а не число
  // карточек: запуск 4× остаётся одной группой, но содержит четыре операции.
  const activeCount = runs.length + tasks.filter((task) => ACTIVE_JOB_STATES.includes(task.state)).length
  const finishedTasks = tasks.filter((task) => TERMINAL_JOB_STATES.includes(task.state))
  const hasFailed = finishedTasks.some((task) => task.state === 'error')

  useEffect(() => {
    if (!confirmStopAll) return
    const timer = window.setTimeout(() => setConfirmStopAll(false), CONFIRM_MS)
    return () => window.clearTimeout(timer)
  }, [confirmStopAll])

  useEffect(() => {
    if (!activeCount) setConfirmStopAll(false)
  }, [activeCount])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      window.requestAnimationFrame(() => triggerRef.current?.focus())
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  function stopAll(): void {
    if (!confirmStopAll) {
      setConfirmStopAll(true)
      return
    }
    setConfirmStopAll(false)
    setActionError(null)
    stopAllMacroRuns()
    for (const task of tasks) {
      if (!ACTIVE_JOB_STATES.includes(task.state)) continue
      void cancelGeneration(task.jobId).catch((error) => {
        setOpen(true)
        setActionError(systemErrorMessage(error, "Failed to stop task"))
      })
    }
  }

  function stopJob(jobId: string): void {
    setActionError(null)
    void cancelGeneration(jobId).catch((error) =>
      setActionError(systemErrorMessage(error, "Failed to stop task")),
    )
  }

  function retryJob(jobId: string): void {
    setActionError(null)
    void retryGeneration(jobId).catch((error) =>
      setActionError(systemErrorMessage(error, "Failed to repeat task")),
    )
  }

  function dismissLaunchFrom(jobId: string): void {
    const selected = tasks.find((task) => task.jobId === jobId)
    const launchId = selected?.launch?.launchId
    for (const task of tasks) {
      const sameLaunch = launchId
        ? task.launch?.launchId === launchId
        : task.jobId === jobId
      if (sameLaunch && TERMINAL_JOB_STATES.includes(task.state)) {
        dismissGenerationTask(task.jobId)
      }
    }
  }

  function showResults(group: GenerationLaunchGroup, jobIds: string[]): void {
    const projectId = group.launch?.projectId ?? group.variants[0]?.target.projectId
    if (!projectId || jobIds.length === 0) return
    // ⚠️ Вид доски знает только описатель повтора: в адресе задачи лежит голый
    // идентификатор, а по нему сетевую доску от локальной не отличить —
    // и её искали в локальном индексе, где её нет (см. projectRef запроса).
    const source = group.variants.find((variant) => variant.retry?.projectRef)?.retry?.projectRef?.source
    showGenerationTaskResults(
      { projectRef: { source: source ?? 'local', id: projectId }, jobIds },
      () => setOpen(false),
      triggerRef,
    )
  }

  function toggleGroup(launchId: string): void {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(launchId)) next.delete(launchId)
      else next.add(launchId)
      return next
    })
  }

  return (
    <div className="task-center" ref={rootRef}>
      <div className="task-center-trigger">
        <Tooltip
          title={t('Tasks')}
          hint={
            activeCount
              ? t('Operations in progress: {0}. You can review or stop them here.', { 0: activeCount })
              : hasFailed
                ? t('Some generations failed; review and retry them.')
                : t('See active tasks and external edits in the editor here.')
          }
        >
        <button
          ref={triggerRef}
          type="button"
          className={`tab task-center-button ${activeCount ? 'icon-tab busy' : 'icon-btn idle'} ${open ? 'active' : ''}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={activeCount ? t('Tasks — {0} running', { 0: activeCount }) : t('Tasks')}
          onClick={() => setOpen((value) => !value)}
        >
          <IconTasks size={16} className={activeCount ? 'task-center-spin' : undefined} />
          {activeCount > 0 && t('Tasks · {0}', { 0: activeCount })}
          {activeCount === 0 && hasFailed && (
            <span className="task-center-dot" aria-hidden="true" />
          )}
        </button>
        </Tooltip>
        {activeCount > 0 && (
          <button
            type="button"
            className={`task-center-stopall ${confirmStopAll ? 'armed' : ''}`}
            aria-label={t('Stop all operations ({0})', { 0: activeCount })}
            title={
              confirmStopAll
                ? t('Click again to stop everything')
                : t('Stop everything ({0})', { 0: activeCount })
            }
            onClick={stopAll}
          >
            {confirmStopAll ? t('Are you sure?') : <IconStop size={13} />}
          </button>
        )}
      </div>

      {open && (
        <section className="task-center-panel" role="dialog" aria-label={t('Tasks')}>
          <header>
            <span className="task-center-title">{t('Tasks')}</span>
            {finishedTasks.length > 0 && (
              <button
                type="button"
                className="task-center-clear"
                onClick={() => finishedTasks.forEach((task) => dismissGenerationTask(task.jobId))}
              >

                {t('Clear')}
              </button>
            )}
          </header>

          {actionError && <p className="task-center-error" role="alert">{actionError}</p>}

          {runs.length === 0 && visibleGroups.length === 0 && (
            <p className="task-center-empty">
              Nothing is running. Active tasks appear here, and you can stop them here.
            </p>
          )}

          <div className="task-center-list">
            {runs
              .slice()
              .sort((a, b) => b.startedAt - a.startedAt)
              .map((run) => (
                <article className="task-center-row task-center-macro" key={`macro:${run.token}`}>
                  <div>
                    <strong>{run.macroName}</strong>
                    <span className="task-state">
                      {run.stopping ? t('Stopping…') : systemStatusMessage(run.progress, "In progress")}
                    </span>
                  </div>
                  <div className="task-center-actions">
                    <button
                      type="button"
                      disabled={run.stopping}
                      onClick={() => stopMacroRun(run.token)}
                    >
                      <IconStop size={13} />  {t('Stop')}
                    </button>
                  </div>
                </article>
              ))}

            {visibleGroups.map((group) => (
              <GenerationLaunchGroupRow
                key={group.launchId}
                group={group}
                expanded={expanded.has(group.launchId)}
                currentProjectId={currentProjectId}
                onToggle={() => toggleGroup(group.launchId)}
                onShow={(jobIds) => showResults(group, jobIds)}
                onCancel={stopJob}
                onRetry={retryJob}
                onDismiss={dismissLaunchFrom}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

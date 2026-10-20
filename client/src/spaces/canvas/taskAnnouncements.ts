import { pluralWithCount } from '../../ui/plural'
import { groupGenerationTasks, type GenerationLaunchGroup } from './generationLaunches'
import type { GenerationTask, GenerationTaskState } from './generationRegistry'
import { JOB_FAILED } from './jobPolling'
import { systemErrorMessage } from '../../ui/systemMessage'

const SETTLED: GenerationTaskState[] = ['done', 'error', 'cancelled']
const RESULTS: [string, string, string] = ["result", "results", "results"]
const TASKS: [string, string, string] = ["task", "tasks", "tasks"]
const VARIANTS: [string, string, string] = ["variant", "variants", "variants"]

function isSettled(state: GenerationTaskState): boolean {
  return SETTLED.includes(state)
}

function launchCounts(group: GenerationLaunchGroup): {
  done: number
  errors: number
  cancelled: number
  active: number
} {
  return {
    done: group.variants.filter((task) => task.state === 'done').length,
    errors: group.variants.filter((task) => task.state === 'error').length,
    cancelled: group.variants.filter((task) => task.state === 'cancelled').length,
    active: group.variants.filter((task) => !isSettled(task.state)).length,
  }
}

function launchFingerprint(group: GenerationLaunchGroup): string {
  const counts = launchCounts(group)
  // queued→running не меняет fingerprint и поэтому не создаёт пустого объявления.
  return `${group.variantCount}:${counts.done}:${counts.errors}:${counts.cancelled}:${counts.active}`
}

function launchAnnouncement(group: GenerationLaunchGroup): string {
  const { done, errors, cancelled, active } = launchCounts(group)
  const parts: string[] = []
  if (done === 1) parts.push(`1 of ${group.variantCount} ready`)
  else if (done > 1) parts.push(`${done} of ${group.variantCount} ready`)

  if (errors === 1) parts.push("one option with an error")
  else if (errors > 1) parts.push(`${pluralWithCount(errors, VARIANTS)} with errors`)

  if (cancelled === 1) parts.push("one option canceled")
  else if (cancelled > 1) parts.push(`${pluralWithCount(cancelled, VARIANTS)} cancelled`)

  if (active > 0) parts.push(`${pluralWithCount(active, VARIANTS)} in progress`)
  return parts.join(', ')
}

function legacyAnnouncement(before: GenerationTask[], after: GenerationTask[]): string | null {
  const was = new Map(before.map((task) => [task.jobId, task.state]))
  const settled = after.filter((task) => {
    const previous = was.get(task.jobId)
    return previous !== undefined && !isSettled(previous) && isSettled(task.state)
  })
  if (settled.length === 0) return null

  const done = settled.filter((task) => task.state === 'done').length
  const failed = settled.filter((task) => task.state === 'error')
  const cancelled = settled.filter((task) => task.state === 'cancelled').length
  const parts: string[] = []
  if (done > 0) parts.push(`Done: ${pluralWithCount(done, RESULTS)}`)
  if (failed.length === 1) {
    const error = failed[0].error?.trim()
    parts.push(`Error: ${error ? systemErrorMessage(error) : JOB_FAILED}`)
  }
  else if (failed.length > 1) parts.push(`Failed: ${pluralWithCount(failed.length, TASKS)}`)
  if (cancelled > 0) parts.push(`Cancelled: ${pluralWithCount(cancelled, TASKS)}`)

  const remaining = after.filter((task) => !isSettled(task.state)).length
  if (remaining > 0) parts.push(`${pluralWithCount(remaining, TASKS)} still in progress`)
  return parts.join(', ')
}

// launchFingerprints живёт у смонтированного Центра задач. Первый увиденный
// снимок запуска только запоминается: после reload нельзя читать вчерашний итог.
// Дальше произносится один aggregate на запуск, даже если четыре job завершились
// в одном polling-тике. Legacy-задачи без launch сохраняют прежнее поведение.
export function taskAnnouncement(
  before: GenerationTask[],
  after: GenerationTask[],
  launchFingerprints: Map<string, string> = new Map(),
): string | null {
  const groups = groupGenerationTasks(after.filter((task) => task.launch))
  const liveLaunchIds = new Set(groups.map((group) => group.launchId))
  for (const launchId of launchFingerprints.keys()) {
    if (!liveLaunchIds.has(launchId)) launchFingerprints.delete(launchId)
  }

  const launchMessages: string[] = []
  for (const group of groups) {
    const next = launchFingerprint(group)
    const previous = launchFingerprints.get(group.launchId)
    launchFingerprints.set(group.launchId, next)
    if (previous === undefined || previous === next) continue

    const previousTerminal = previous
      .split(':')
      .slice(1, 4)
      .reduce((total, value) => total + Number(value), 0)
    const counts = launchCounts(group)
    const nextTerminal = counts.done + counts.errors + counts.cancelled
    if (nextTerminal <= previousTerminal) continue
    const message = launchAnnouncement(group)
    if (message) launchMessages.push(message)
  }

  const legacy = legacyAnnouncement(
    before.filter((task) => !task.launch),
    after.filter((task) => !task.launch),
  )
  if (legacy) launchMessages.push(legacy)
  return launchMessages.length > 0 ? launchMessages.join('. ') : null
}

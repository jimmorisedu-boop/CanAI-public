import type { GenerationTask } from './generationRegistry'
import { newId } from '../../ui/ids'
import type { ProjectRef } from '../../types'

export interface GenerationCanvasTarget {
  kind: 'canvas'
  projectRef: ProjectRef
  placeholderId: string
}

export function createGenerationTarget(
  projectRef: ProjectRef,
  placeholderId: string,
): GenerationCanvasTarget {
  return { kind: 'canvas', projectRef: { ...projectRef }, placeholderId }
}

export interface GenerationLaunchMeta {
  launchId: string
  variantIndex: number
  variantCount: number
  projectId: string
  projectName?: string
  promptPreview: string
  modelId?: string
  modelName: string
  estimatedTotalCostUsd?: number
  createdAt: number
}

export type GenerationLaunchBase = Omit<GenerationLaunchMeta, 'variantIndex'>

export function createGenerationLaunch(
  input: Omit<GenerationLaunchMeta, 'launchId' | 'variantIndex'>,
): GenerationLaunchBase {
  return { ...input, launchId: newId() }
}

export function buildLaunchVariants(base: GenerationLaunchBase): GenerationLaunchMeta[] {
  return Array.from({ length: base.variantCount }, (_, index) => ({
    ...base,
    variantIndex: index + 1,
  }))
}

interface LaunchGenerationVariantsInput {
  slots: string[]
  launch: GenerationLaunchBase
  /** Optional quote preflight. All variants settle before approval is shown. */
  prepare?(variant: GenerationLaunchMeta, slotId: string): Promise<unknown>
  approve?(prepared: Array<{ variant: GenerationLaunchMeta; slotId: string; value: unknown }>): Promise<boolean>
  /** slotId — заглушка, к которой привяжется задача (адрес для сервера). */
  start(variant: GenerationLaunchMeta, slotId: string, prepared?: unknown): Promise<string>
  recordFailure(variant: GenerationLaunchMeta, message: string): string
  bindJob(slotId: string, jobId: string): void
  failSlot(slotId: string, message: string): void
  failLaunch?(slotId: string, jobId: string, message: string): void
  fallbackError: string
}

export async function launchGenerationVariants(
  input: LaunchGenerationVariantsInput,
): Promise<{ startedJobIds: string[]; failedCount: number }> {
  const variants = buildLaunchVariants(input.launch)
  const fail = (variant: GenerationLaunchMeta, slotId: string, message: string) => {
    const localId = input.recordFailure(variant, message)
    if (input.failLaunch) input.failLaunch(slotId, localId, message)
    else {
      input.bindJob(slotId, localId)
      input.failSlot(slotId, message)
    }
  }
  let prepared = new Map<string, unknown>()
  if (input.prepare) {
    const preflight = await Promise.allSettled(input.slots.map((slotId, index) => (
      input.prepare!(variants[index]!, slotId)
    )))
    const failed = preflight.filter((result) => result.status === 'rejected')
    if (failed.length > 0) {
      for (const [index, result] of preflight.entries()) {
        const message = result.status === 'rejected'
          && result.reason instanceof Error && result.reason.message.trim()
          ? result.reason.message
          : input.fallbackError
        fail(variants[index]!, input.slots[index]!, message)
      }
      return { startedJobIds: [], failedCount: input.slots.length }
    }
    prepared = new Map(preflight.map((result, index) => [
      input.slots[index]!,
      (result as PromiseFulfilledResult<unknown>).value,
    ]))
    if (input.approve && !await input.approve(input.slots.map((slotId, index) => ({
      variant: variants[index]!, slotId, value: prepared.get(slotId),
    }))) ) {
      const message = "Run cancelled."
      for (const [index, slotId] of input.slots.entries()) {
        fail(variants[index]!, slotId, message)
      }
      return { startedJobIds: [], failedCount: input.slots.length }
    }
  }
  const settled = await Promise.allSettled(
    input.slots.map(async (slotId, index) => {
      const variant = variants[index]
      try {
        const jobId = await input.start(variant, slotId, prepared.get(slotId))
        input.bindJob(slotId, jobId)
        return jobId
      } catch (error) {
        const message = error instanceof Error && error.message.trim()
          ? error.message
          : input.fallbackError
        fail(variant, slotId, message)
        throw error
      }
    }),
  )
  return {
    startedJobIds: settled.flatMap((result) => (
      result.status === 'fulfilled' ? [result.value] : []
    )),
    failedCount: settled.filter((result) => result.status === 'rejected').length,
  }
}

export type GenerationLaunchStatus = 'active' | 'partial' | 'done' | 'error' | 'cancelled'

export interface GenerationLaunchGroup {
  launchId: string
  launch?: GenerationLaunchMeta
  variants: GenerationTask[]
  status: GenerationLaunchStatus
  createdAt: number
  variantCount: number
  doneJobIds: string[]
  activeJobIds: string[]
  retryableJobIds: string[]
}

function groupStatus(variants: GenerationTask[]): GenerationLaunchStatus {
  const doneCount = variants.filter((variant) => variant.state === 'done').length
  if (doneCount === variants.length) return 'done'
  if (doneCount > 0) return 'partial'
  if (variants.some((variant) => variant.state === 'error')) return 'error'
  if (variants.some((variant) =>
    variant.state === 'queued'
      || variant.state === 'running'
      || variant.state === 'cancelling')) {
    return 'active'
  }
  return 'cancelled'
}

export function groupGenerationTasks(tasks: GenerationTask[]): GenerationLaunchGroup[] {
  const grouped = new Map<string, GenerationTask[]>()
  for (const task of tasks) {
    const key = task.launch?.launchId ?? `legacy:${task.jobId}`
    const group = grouped.get(key)
    if (group) group.push(task)
    else grouped.set(key, [task])
  }

  return [...grouped.entries()]
    .map(([launchId, attempts]) => {
      const latestByVariant = new Map<number, GenerationTask>()
      for (const attempt of attempts) {
        const variantIndex = attempt.launch?.variantIndex ?? 1
        const current = latestByVariant.get(variantIndex)
        if (!current || attempt.createdAt >= current.createdAt) {
          latestByVariant.set(variantIndex, attempt)
        }
      }
      const variants = [...latestByVariant.values()].sort(
        (a, b) => (a.launch?.variantIndex ?? 1) - (b.launch?.variantIndex ?? 1),
      )
      const launch = variants.find((variant) => variant.launch)?.launch
      return {
        launchId,
        launch,
        variants,
        status: groupStatus(variants),
        createdAt: launch?.createdAt ?? variants[0].createdAt,
        variantCount: launch?.variantCount ?? 1,
        doneJobIds: variants
          .filter((variant) => variant.state === 'done')
          .map((variant) => variant.jobId),
        activeJobIds: variants
          .filter((variant) => variant.state === 'queued' || variant.state === 'running')
          .map((variant) => variant.jobId),
        retryableJobIds: variants
          .filter((variant) => variant.state === 'error' && variant.retry)
          .map((variant) => variant.jobId),
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt)
}

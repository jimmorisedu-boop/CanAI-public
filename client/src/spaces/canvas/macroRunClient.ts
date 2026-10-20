import { api } from '../../api'
import type { GenRef, ProjectSource } from '../../types'
import { trackGeneration } from './generationRegistry'
import type { CanvasStore } from './konva/canvasStore'
import type { GenerationLaunchBase } from './generationLaunches'
import { formatExactUsd } from '../../ui/money'
import { systemErrorMessage, systemStatusMessage } from '../../ui/systemMessage'

export interface MacroRunNodeState {
  status: 'idle' | 'queued' | 'running' | 'done' | 'error'
  progress?: string
  error?: string
  jobId?: string
}

export interface MacroRunState {
  id: string
  macroId: string
  macroName: string
  projectId: string
  status: 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'
  startedAt: number
  finishedAt?: number
  error?: string
  delivered: number
  placeholderIds: string[]
  placeholderByNode: Record<string, string>
  nodes: Record<string, MacroRunNodeState>
}

export const MACRO_POLL_MS = 1200

export function formatMacroQuoteUsd(amountMicro: number): string {
  return formatExactUsd(amountMicro / 1_000_000)
}

export function macroRunSummary(run: MacroRunState): string {
  if (run.status === 'running') {
    const active = Object.values(run.nodes).find((node) => node.status === 'running')
    return active?.progress
      ? `${run.macroName}: ${systemStatusMessage(active.progress, 'Working…')}`
      : `${run.macroName}: running`
  }
  if (run.status === 'done') return `${run.macroName}: ready`
  if (run.status === 'cancelled') return `${run.macroName}: stopped`
  if (run.status === 'interrupted') return `${run.macroName}: interrupted by restart`
  return `${run.macroName}: ${run.error ? systemErrorMessage(run.error, 'Failed') : 'failed'}`
}

export function isMacroRunFinished(run: MacroRunState): boolean {
  return run.status !== 'running'
}

export function bindMacroRunToBoard(
  run: MacroRunState,
  store: CanvasStore,
  alreadyBound: Set<string>,
  _source: ProjectSource = 'local',
): string[] {
  const fresh: string[] = []
  for (const [nodeId, node] of Object.entries(run.nodes)) {
    const slot = run.placeholderByNode[nodeId]
    if (!slot) continue
    if (node.jobId && !alreadyBound.has(node.jobId)) {
      alreadyBound.add(node.jobId)
      store.setPendingJob(slot, node.jobId)
      fresh.push(node.jobId)
    }
    if (node.status === 'error' && node.error) store.failPendingById(slot, node.error)
  }
  return fresh
}

export function dismissUnusedSlots(
  run: MacroRunState,
  store: CanvasStore,
  _source: ProjectSource = 'local',
): void {
  const taken = new Set(
    Object.entries(run.nodes)
      .map(([nodeId]) => run.placeholderByNode[nodeId])
      .filter((slot): slot is string => Boolean(slot)),
  )
  const busy = new Set(
    Object.entries(run.nodes)
      .filter(([, node]) => Boolean(node.jobId))
      .map(([nodeId]) => run.placeholderByNode[nodeId]),
  )
  for (const slot of run.placeholderIds) {
    if (!taken.has(slot) || !busy.has(slot)) {
      const pending = store.getPending().find((entry) => entry.id === slot)
      if (pending && !pending.jobId) store.dismissPendingById(slot)
    }
  }
}

export interface MacroLaunchInput {
  requestId: string
  macroId: string
  projectId: string
  refs: GenRef[]
  snapshot?: unknown
  placeholderIds: string[]
  quoteHash?: string
  quoteAmountMicro?: number
  quoteConfirmed?: boolean
}

/** Local runs have no remote quote. Kept as a shape for callers that share UI code. */
export interface MacroQuote {
  amountMicro: number
  amountUsd: number
  needsConfirmation: boolean
  id?: string
  requestHash?: string
}

export async function planMacroRun(macroId: string, _source: ProjectSource = 'local'): Promise<string[]> {
  const plan = await api.macroPlan(macroId)
  return plan.deliveringNodeIds
}

export async function quoteMacroRun(_input: MacroLaunchInput, _source: ProjectSource = 'local'): Promise<MacroQuote> {
  return { amountMicro: 0, amountUsd: 0, needsConfirmation: false }
}

export async function startMacroRun(
  input: MacroLaunchInput,
  _source: ProjectSource = 'local',
): Promise<MacroRunState> {
  const { run } = await api.startMacroRun(input.macroId, {
    requestId: input.requestId,
    project: input.projectId,
    refs: input.refs,
    snapshot: input.snapshot,
    placeholderIds: input.placeholderIds,
  })
  return run
}

export async function watchMacroRun(
  runId: string,
  projectId: string,
  handlers: {
    onState(run: MacroRunState): void
    isStopped?(): boolean
    sleep?(ms: number): Promise<void>
  },
  _source: ProjectSource = 'local',
): Promise<MacroRunState | null> {
  const sleep = handlers.sleep ?? ((ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)))
  for (;;) {
    if (handlers.isStopped?.()) return null
    await sleep(MACRO_POLL_MS)
    let run: MacroRunState | undefined
    try {
      const runs = (await api.listMacroRuns(projectId)).runs
      run = runs.find((entry) => entry.id === runId)
    } catch {
      continue
    }
    if (!run) continue
    handlers.onState(run)
    if (isMacroRunFinished(run)) return run
  }
}

export function trackMacroJobs(jobIds: string[], projectId: string, launch?: GenerationLaunchBase): void {
  for (const jobId of jobIds) {
    trackGeneration({ kind: 'canvas', projectId }, jobId, 'image', undefined, launch
      ? { ...launch, variantIndex: 1 }
      : undefined)
  }
}

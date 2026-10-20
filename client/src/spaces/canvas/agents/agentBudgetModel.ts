import type {
  AgentGenerationModelPin,
  AgentLlmAuthorization,
  AgentLlmCatalogView,
  AgentPackageSummary,
  AgentTaskView,
  ProjectRef,
} from '../../../../../packages/agent-protocol/index'

export type AgentBudgetStatus =
  | 'estimate'
  | 'awaiting_consent'
  | 'reserved'
  | 'running'
  | 'charged'
  | 'blocked'
  | 'uncertain'
  | 'overspent'
  | 'exhausted'
  | 'failed'

export interface AgentBudgetDraft {
  input: string
  amountMicros: number | null
  error: string | null
}

export interface AgentLlmLaunchInfo {
  required: boolean
  available: boolean
  localOnly: boolean
  connectionId: string | null
  connectionLabel: string
  modelId: string | null
  modelLabel: string
  modelOptions: Array<{ id: string; name: string; active: boolean }>
  catalogRevision?: number
  maxTokens?: number
  unavailableReason?: string
}

export interface AgentBudgetSnapshot {
  status: AgentBudgetStatus
  currency: 'USD'
  estimateMicros?: number
  limitMicros?: number
  reservedMicros?: number
  chargedMicros?: number
  remainingMicros?: number
  overshootMicros?: number
  calls?: number
  maxCalls?: number
  modelId?: string
  pins?: AgentGenerationModelPin[]
  message?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finiteMicros(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function nestedMicros(value: unknown, key: string): number | undefined {
  const row = record(value)
  const nested = record(row?.[key])
  return finiteMicros(row?.[key])
    ?? finiteMicros(nested?.amountMicros)
    ?? finiteMicros(nested?.micros)
    ?? finiteMicros(nested?.value)
}

function fieldMicros(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = nestedMicros(row, key)
    if (value !== undefined) return value
  }
  return undefined
}

function status(value: unknown): AgentBudgetStatus | undefined {
  if (value === 'estimate' || value === 'awaiting_consent' || value === 'reserved'
    || value === 'running' || value === 'charged' || value === 'blocked'
    || value === 'uncertain' || value === 'overspent' || value === 'exhausted' || value === 'failed') return value
  if (value === 'active') return 'reserved'
  if (value === 'settling' || value === 'succeeded' || value === 'complete') return 'charged'
  if (value === 'budget_exceeded') return 'blocked'
  return undefined
}

/** Parse a positive USD amount without float rounding or silently truncating precision. */
export function parseUsdMicros(input: string): AgentBudgetDraft {
  const normalized = input.trim()
  if (!normalized) return { input, amountMicros: null, error: 'Enter a positive USD limit' }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(normalized)) {
    return { input, amountMicros: null, error: 'Use USD with no more than 6 decimal places' }
  }
  const [wholePart, fractionPart = ''] = normalized.split('.')
  const whole = Number(wholePart)
  const fraction = Number(fractionPart.padEnd(6, '0') || '0')
  const amountMicros = whole * 1_000_000 + fraction
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
    return { input, amountMicros: null, error: 'Limit is too large or zero' }
  }
  return { input, amountMicros, error: null }
}

export function formatUsdMicros(amountMicros: number | undefined): string {
  if (amountMicros === undefined || !Number.isSafeInteger(amountMicros) || amountMicros < 0) return '—'
  return `$${(amountMicros / 1_000_000).toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')}`
}

export function packageRequiresLlm(pkg: Pick<AgentPackageSummary, 'permissions'> | undefined): boolean {
  return Boolean(pkg?.permissions.includes('llm.request'))
}

/**
 * Read Host-advertised connection metadata without inventing a model. A
 * missing catalog is deliberately unavailable rather than an implicit paid
 * capability.
 */
export function llmLaunchInfo(
  pkg: AgentPackageSummary | undefined,
  projectRef: ProjectRef,
  catalog?: AgentLlmCatalogView | null,
): AgentLlmLaunchInfo | null {
  if (!packageRequiresLlm(pkg)) return null
  if (projectRef.source !== 'local') {
    return {
      required: true,
      available: false,
      localOnly: true,
      connectionId: null,
      connectionLabel: 'On this computer · fal.ai',
      modelId: null,
      modelLabel: 'Model is available only on this computer',
      modelOptions: [],
      unavailableReason: 'Cloud tasks cannot run a paid LLM without shared billing authority.',
    }
  }
  const connectionId = catalog?.connection.id ?? null
  const modelId = catalog?.defaultModelId ?? null
  const model = modelId ? catalog?.models.find((candidate) => candidate.id === modelId) : undefined
  const available = catalog?.connection.id === 'local-fal'
    && catalog.connection.status === 'ready'
    && Boolean(modelId && model?.active !== false)
  return {
    required: true,
    available,
    localOnly: true,
    connectionId,
    connectionLabel: 'On this computer · fal.ai',
    modelId,
    modelLabel: model?.name ?? (modelId ?? 'fal.ai model is not pinned yet'),
    modelOptions: (catalog?.models ?? []).map((candidate) => ({ id: candidate.id, name: candidate.name, active: candidate.active })),
    ...(catalog ? { catalogRevision: catalog.revision } : {}),
    ...(!available ? { unavailableReason: catalog?.connection.status === 'unavailable'
      ? 'fal.ai is unavailable on this computer. Check Settings.'
      : 'No fal.ai connection or model has been selected on this computer yet.' } : {}),
  }
}

/** Build the exact shared authorization payload; model selection stays Host-owned. */
export function llmAuthorization(
  info: AgentLlmLaunchInfo | null,
  amountMicros: number | null,
  textTransferConsent: boolean,
): AgentLlmAuthorization | null {
  if (!info?.required || !info.available || info.connectionId !== 'local-fal' || !textTransferConsent) return null
  if (amountMicros === null || !Number.isSafeInteger(amountMicros) || amountMicros <= 0) return null
  if (!info.modelId || info.catalogRevision === undefined) return null
  return {
    connectionId: 'local-fal', textTransferConsent: true, maxCostMicros: amountMicros,
    expectedModelId: info.modelId, expectedCatalogRevision: info.catalogRevision,
  }
}

/** Read server-authoritative expense state; never treats a local estimate as charged. */
export function taskBudgetSnapshot(task: AgentTaskView): AgentBudgetSnapshot | null {
  const taskRow = record(task)
  // `spendBudget` is the single ledger for paid LLM + generation calls. Keep
  // legacy fields as read-only fallbacks for older Host receipts, but never
  // let an independent LLM ceiling hide the aggregate authority.
  const source = record(taskRow?.spendBudget) ?? record(taskRow?.llmBudget) ?? record(taskRow?.generationBudget)
    ?? record(taskRow?.budget) ?? record(taskRow?.expense) ?? record(taskRow?.billing)
  if (!source) return null
  const rawStatus = status(source.status ?? source.state)
  const limitMicros = fieldMicros(source, 'maxCostMicros', 'limitMicros', 'limit')
  const estimateMicros = fieldMicros(source, 'estimateMicros', 'estimatedMicros', 'estimate')
  const reservedMicros = fieldMicros(source, 'reservedMicros', 'reserved')
  const chargedMicros = fieldMicros(source, 'chargedMicros', 'charged', 'actualMicros')
  const overshootMicros = fieldMicros(source, 'overshootMicros', 'overshoot')
  const reportedRemainingMicros = fieldMicros(source, 'remainingMicros', 'remaining')
  const derivedRemainingMicros = limitMicros !== undefined
    ? Math.max(0, limitMicros - (chargedMicros ?? 0) - (reservedMicros ?? 0))
    : undefined
  // Some older Host receipts omitted `remaining`, while a few reported the
  // original limit after settlement. Keep the display truthful and never let
  // a stale larger value hide already charged/reserved micros.
  const remainingMicros = derivedRemainingMicros !== undefined
    ? Math.min(reportedRemainingMicros ?? derivedRemainingMicros, derivedRemainingMicros)
    : reportedRemainingMicros
  const calls = finiteMicros(source.calls)
  const maxCalls = finiteMicros(source.maxCalls)
  const modelId = typeof source.modelId === 'string' ? source.modelId : undefined
  const rawPins = Array.isArray(source.pins)
    ? source.pins
    : Array.isArray(record(taskRow?.generationBudget)?.pins)
      ? (record(taskRow?.generationBudget)?.pins as unknown[])
      : undefined
  const pins: AgentGenerationModelPin[] | undefined = Array.isArray(rawPins)
    ? rawPins.map((item) => record(item)).filter((row): row is Record<string, unknown> => row !== null && (row.kind === 'image' || row.kind === 'video' || row.kind === 'audio') && typeof row.modelId === 'string').map((row) => ({ kind: row.kind as 'image' | 'video' | 'audio', modelId: row.modelId as string }))
    : undefined
  if (!rawStatus && limitMicros === undefined && estimateMicros === undefined && reservedMicros === undefined && chargedMicros === undefined && remainingMicros === undefined) return null
  return {
    status: rawStatus === 'reserved' && (reservedMicros ?? 0) === 0
      ? (chargedMicros !== undefined && chargedMicros > 0 ? 'charged' : 'running')
      : rawStatus ?? (chargedMicros !== undefined ? 'charged' : 'estimate'),
    currency: 'USD',
    ...(limitMicros !== undefined ? { limitMicros } : {}),
    ...(estimateMicros !== undefined ? { estimateMicros } : {}),
    ...(reservedMicros !== undefined ? { reservedMicros } : {}),
    ...(chargedMicros !== undefined ? { chargedMicros } : {}),
    ...(remainingMicros !== undefined ? { remainingMicros } : {}),
    ...(overshootMicros !== undefined ? { overshootMicros } : {}),
    ...(calls !== undefined ? { calls } : {}),
    ...(maxCalls !== undefined ? { maxCalls } : {}),
    ...(modelId ? { modelId } : {}),
    ...(pins && pins.length > 0 ? { pins } : {}),
    ...(typeof source.message === 'string' ? { message: source.message } : {}),
  }
}

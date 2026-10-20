import type {
  AgentArtifactRef,
  AgentGenerationAuthorization,
  AgentGenerationModelPin,
  AgentInputItem,
  AgentPackageSummary,
  AgentPackageTaskTypeSummary,
  ProjectRef,
} from '../../../../../packages/agent-protocol/index'
import type { CatalogModel, JobKind } from '../../../types'
import { estimateGenerationCost } from '../generationEstimate'

export type AgentGenerationKind = Extract<JobKind, 'image' | 'video' | 'audio'>

export interface AgentGenerationCatalog {
  revision: number
  connection: { id: 'local-fal'; kind: 'generation'; status: 'ready' | 'unavailable' }
  models: CatalogModel[]
}

export interface AgentGenerationLaunchInfo {
  required: boolean
  available: boolean
  localOnly: boolean
  connectionId: string | null
  connectionLabel: string
  kind: AgentGenerationKind | null
  modelId: string | null
  modelLabel: string
  modelOptions: Array<{ id: string; name: string; active: boolean; kind: AgentGenerationKind }>
  catalogRevision?: number
  model?: CatalogModel
  estimatedCostMicros?: number
  unavailableReason?: string
}

const MEDIA_KINDS: AgentGenerationKind[] = ['image', 'video', 'audio']
const CHECKSUM = /^[a-f0-9]{64}$/u

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function mediaKind(value: unknown): AgentGenerationKind | null {
  return value === 'image' || value === 'video' || value === 'audio' ? value : null
}

/** Fail closed when a Host advertises an incomplete or stale media catalog. */
function catalogModel(value: unknown): CatalogModel | null {
  const row = object(value)
  const kind = mediaKind(row.kind)
  if (typeof row.id !== 'string' || !row.id.trim() || typeof row.name !== 'string' || !kind) return null
  if (!Array.isArray(row.params)) return null
  return row as unknown as CatalogModel
}

export function generationCatalog(value: unknown): AgentGenerationCatalog {
  const row = object(value)
  const connection = object(row.connection)
  const connectionIsGeneration = connection.id === 'local-fal' && connection.kind === 'generation'
  const models = Array.isArray(row.models)
    ? row.models.map(catalogModel).filter((model): model is CatalogModel => model !== null)
    : []
  return {
    revision: integer(row.revision),
    connection: {
      id: 'local-fal',
      kind: 'generation',
      status: connectionIsGeneration && connection.status === 'ready' ? 'ready' : 'unavailable',
    },
    models,
  }
}

export function packageRequiresGeneration(pkg: Pick<AgentPackageSummary, 'permissions'> | undefined): boolean {
  return Boolean(pkg?.permissions.includes('generation.request'))
}

export function generationKinds(type: (Pick<AgentPackageTaskTypeSummary, 'outputKinds'> & { generation?: { kinds: Array<'image' | 'video' | 'audio'> } }) | undefined): AgentGenerationKind[] {
  if (!type) return []
  if (type.generation?.kinds && type.generation.kinds.length > 0) {
    return MEDIA_KINDS.filter((kind) => type.generation!.kinds.includes(kind))
  }
  return MEDIA_KINDS.filter((kind) => type.outputKinds.includes(kind))
}

function refsSupported(model: CatalogModel, refCount: number): boolean {
  if (refCount === 0) return true
  if (!model.refs) return false
  return model.maxTotalRefs === undefined || refCount <= model.maxTotalRefs
}

export function generationLaunchInfo({
  pkg,
  type,
  projectRef,
  catalog,
  kind,
  modelId,
  refCount,
  invalidRefCount,
}: {
  pkg: AgentPackageSummary | undefined
  type: AgentPackageTaskTypeSummary | undefined
  projectRef: ProjectRef
  catalog: AgentGenerationCatalog | null
  kind: AgentGenerationKind | null
  modelId: string | null
  refCount: number
  invalidRefCount: number
}): AgentGenerationLaunchInfo | null {
  if (!packageRequiresGeneration(pkg)) return null
  const kinds = generationKinds(type)
  const selectedKind = kind && kinds.includes(kind) ? kind : kinds[0] ?? null
  const unavailable = (reason: string): AgentGenerationLaunchInfo => ({
    required: true,
    available: false,
    localOnly: true,
    connectionId: catalog?.connection.id ?? null,
    connectionLabel: 'On this computer · fal.ai',
    kind: selectedKind,
    modelId: null,
    modelLabel: 'Model fal.ai not pinned',
    modelOptions: [],
    ...(catalog ? { catalogRevision: catalog.revision } : {}),
    unavailableReason: reason,
  })
  if (projectRef.source !== 'local') return unavailable('This package requests generation on this computer; Cloud does not replace it.')
  if (!selectedKind) return unavailable('The task type does not declare a result for generation.request.')
  if (!catalog) return unavailable('This computer has no fal.ai model catalog yet.')
  if (catalog.connection.id !== 'local-fal' || catalog.connection.status !== 'ready') return unavailable('fal.ai is unavailable on this computer.')
  if (catalog.revision < 1) return unavailable('No fal.ai model catalog is pinned on this computer.')
  if (invalidRefCount > 0) return unavailable('The selected file is not saved for model transfer yet; clear its selection.')
  const modelOptions = catalog.models
    .filter((model) => model.kind === selectedKind)
    .map((model) => ({ id: model.id, name: model.name, active: model.lifecycle !== 'disabled' && model.lifecycle !== 'archived', kind: selectedKind }))
  const model = catalog.models.find((candidate) => candidate.id === modelId && candidate.kind === selectedKind)
    ?? catalog.models.find((candidate) => candidate.kind === selectedKind && candidate.lifecycle !== 'disabled' && candidate.lifecycle !== 'archived')
  if (!model) return unavailable('The fal.ai catalog has no active model for this result.')
  if (model.lifecycle === 'disabled' || model.lifecycle === 'archived') return unavailable('The selected fal.ai model is no longer active; refresh the catalog and approve again.')
  if (!refsSupported(model, refCount)) return unavailable('The selected fal.ai model does not accept this many files.')
  const defaults = Object.fromEntries((model.params ?? []).filter((param) => param.default !== undefined).map((param) => [param.name, param.default]))
  const estimateUsd = estimateGenerationCost(model, defaults, 1, refCount)
  return {
    required: true,
    available: true,
    localOnly: true,
    connectionId: catalog.connection.id,
    connectionLabel: 'On this computer · fal.ai',
    kind: selectedKind,
    modelId: model.id,
    modelLabel: model.name,
    modelOptions,
    catalogRevision: catalog.revision,
    model,
    ...(estimateUsd === null ? {} : { estimatedCostMicros: Math.max(1, Math.round(estimateUsd * 1_000_000)) }),
  }
}

export function artifactRefsFromInputs(inputs: readonly AgentInputItem[]): AgentArtifactRef[] {
  return inputs
    .filter((input) => input.kind === 'image' || input.kind === 'video' || input.kind === 'audio')
    .filter((input) => CHECKSUM.test(input.checksum))
    .map((input) => ({ artifactId: input.artifactId, revision: input.revision, checksum: input.checksum }))
}

export function invalidMediaInputCount(inputs: readonly AgentInputItem[]): number {
  return inputs.filter((input) => input.kind === 'image' || input.kind === 'video' || input.kind === 'audio')
    .filter((input) => !CHECKSUM.test(input.checksum)).length
}

export function generationAuthorization(
  info: AgentGenerationLaunchInfo | null,
  amountMicros: number | null,
  mediaTransferConsent: boolean,
  artifactRefs: AgentArtifactRef[],
): AgentGenerationAuthorization | null {
  if (!info?.required || !info.available || info.connectionId !== 'local-fal' || !mediaTransferConsent) return null
  if (amountMicros === null || !Number.isSafeInteger(amountMicros) || amountMicros <= 0) return null
  if (!info.modelId || info.catalogRevision === undefined || info.kind === null) return null
  return {
    connectionId: 'local-fal',
    mediaTransferConsent: true,
    maxCostMicros: amountMicros,
    maxCalls: 1,
    expectedModelId: info.modelId,
    expectedCatalogRevision: info.catalogRevision,
    artifactRefs: structuredClone(artifactRefs),
  }
}

export function multiGenerationAuthorization({
  catalogRevision,
  models,
  maxCalls,
  amountMicros,
  mediaTransferConsent,
  artifactRefs,
}: {
  catalogRevision: number
  models: AgentGenerationModelPin[]
  maxCalls: number
  amountMicros: number | null
  mediaTransferConsent: boolean
  artifactRefs: AgentArtifactRef[]
}): AgentGenerationAuthorization | null {
  if (!mediaTransferConsent || models.length === 0) return null
  if (amountMicros === null || !Number.isSafeInteger(amountMicros) || amountMicros <= 0) return null
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 24) return null
  return {
    connectionId: 'local-fal',
    mediaTransferConsent: true,
    maxCostMicros: amountMicros,
    maxCalls,
    models: models.map((m) => ({ ...m })),
    expectedModelId: models[0].modelId,
    expectedCatalogRevision: catalogRevision,
    artifactRefs: structuredClone(artifactRefs),
  }
}

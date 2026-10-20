import type {
  AgentArtifactRef,
  AgentInputItem,
  AgentPackageSummary,
  AgentPackageTaskTypeSummary,
  ProjectRef,
} from '../../../../../packages/agent-protocol/index'
import {
  artifactRefsFromInputs,
  generationLaunchInfo,
  invalidMediaInputCount,
  type AgentGenerationCatalog,
  type AgentGenerationKind,
  type AgentGenerationLaunchInfo,
} from './agentGenerationModel'
import type { GenerationConsentInput } from './agentGenerationConsentModel'

export interface AgentLaunchPreflight {
  artifactRefs: AgentArtifactRef[]
  invalidRefCount: number
  generationInfo: AgentGenerationLaunchInfo | null
  generationDefaults: Record<string, unknown>
  generationConsentInput: GenerationConsentInput
}

export function buildAgentLaunchPreflight({
  pkg,
  type,
  projectRef,
  catalog,
  kind,
  modelId,
  selectedInputs,
  instruction,
}: {
  pkg: AgentPackageSummary | undefined
  type: AgentPackageTaskTypeSummary | undefined
  projectRef: ProjectRef
  catalog: AgentGenerationCatalog | null
  kind: AgentGenerationKind | null
  modelId: string | null
  selectedInputs: readonly AgentInputItem[]
  instruction: string
}): AgentLaunchPreflight {
  const artifactRefs = artifactRefsFromInputs(selectedInputs)
  const invalidRefCount = invalidMediaInputCount(selectedInputs)
  const generationInfo = generationLaunchInfo({
    pkg, type, projectRef, catalog, kind, modelId,
    refCount: artifactRefs.length + invalidRefCount,
    invalidRefCount,
  })
  const generationDefaults = Object.fromEntries(
    (generationInfo?.model?.params ?? []).filter((param) => param.default !== undefined).map((param) => [param.name, param.default]),
  )
  const orderedRefs = selectedInputs
    .filter((input): input is AgentInputItem & { kind: AgentGenerationKind } => input.kind === 'image' || input.kind === 'video' || input.kind === 'audio')
    .map((input) => ({
      kind: input.kind,
      identity: `${input.artifactId}:${input.revision}:${input.checksum}`,
      revision: input.revision,
      checksum: input.checksum,
      label: input.caption,
    }))
  const generationConsentInput: GenerationConsentInput = {
    projectRef,
    kind: generationInfo?.kind ?? 'image',
    modelId: generationInfo?.modelId ?? null,
    catalogRevision: generationInfo?.catalogRevision ?? null,
    prompt: instruction,
    orderedRefs,
    params: generationDefaults,
    mode: 'each',
    attempts: 1,
    maxCalls: 1,
    mediaTransferRequired: true,
    mediaTransferConsent: false,
    estimatedCostMicros: generationInfo?.estimatedCostMicros ?? null,
  }
  return { artifactRefs, invalidRefCount, generationInfo, generationDefaults, generationConsentInput }
}

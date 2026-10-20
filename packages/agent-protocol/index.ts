/**
 * Canonical wire and API types for CanAI agent packages.
 *
 * Runtime validation intentionally lives in the desktop Host.  This module is
 * dependency-free so a package adapter and the Host can share the same names
 * without importing React, Konva, or server implementation details.
 */

export const AGENT_PROTOCOL_VERSION = '1.0' as const
export const AGENT_MAX_MESSAGE_BYTES = 256 * 1024

export type AgentSource = 'local' | 'cloud'
export type ProjectRef = { source: AgentSource; id: string }
export type AgentTaskState =
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'awaiting_input'
  | 'awaiting_connection'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed'
  | 'uncertain'

export type AgentCapability =
  | 'checkpoint'
  | 'resume'
  | 'cancel'
  | 'pause.checkpoint'
  | 'pause.immediate'
  | 'structuredReviews'
  | 'toolBroker'

export type AgentTool =
  | 'canvas.read_selected'
  | 'media.read'
  | 'media.render'
  | 'artifact.publish'
  | 'canvas.create_results'
  | 'canvas.update_own_results'
  | 'llm.request'
  | 'generation.request'
  | 'generation.quote'
  | 'knowledge.propose_update'

export type AgentMessageType =
  | 'hello'
  | 'ack'
  | 'task.start'
  | 'task.resume'
  | 'task.progress'
  | 'task.checkpoint'
  | 'tool.request'
  | 'tool.result'
  | 'review.request'
  | 'review.decision'
  | 'task.pause'
  | 'task.cancel'
  | 'task.paused'
  | 'task.finished'
  | 'heartbeat'
  | 'protocol.error'

export interface AgentEnvelope<TType extends AgentMessageType = AgentMessageType, TPayload = Record<string, unknown>> {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION
  messageId: string
  taskId: string
  executionId: string
  type: TType
  replyTo?: string
  payload: TPayload
}

export interface AgentError {
  code: string
  message: string
  retryable: boolean
}

export interface AgentConnection {
  id: string
  kind: 'llm' | 'generation' | 'external' | 'browser'
  status: 'ready' | 'unavailable'
}

export interface AgentGrant {
  id: string
  tools: Array<'llm.request' | 'generation.request'>
  connectionId: string
  artifactRefs: AgentArtifactRef[]
  maxCalls: number
  maxCost: { currency: 'USD'; amountMicros: number }
  status: 'active' | 'exhausted' | 'revoked'
  /** Host-authoritative media review pin for a bundled/local Creator. */
  generationSpec?: AgentGenerationGrantSpec
  reviewId?: string
  reviewRevision?: number
}

export interface AgentGenerationModelPin {
  kind: 'image' | 'video' | 'audio'
  modelId: string
  /** Catalog defaults the user saw at launch; informational for the agent. */
  params?: Record<string, unknown>
}

export interface AgentGenerationGrantSpec {
  kind: 'image' | 'video' | 'audio'
  modelId: string
  catalogRevision: number
  params: Record<string, unknown>
  estimateMicros: number
}

/** Trusted desktop authorization captured when a local LLM task is created. */
export interface AgentLlmAuthorization {
  connectionId: 'local-fal'
  textTransferConsent: true
  maxCostMicros: number
  /** Bounded number of LLM calls admitted for this task (1..40; default 8). */
  maxCalls?: number
  /** Optional UI snapshot guards; the Host rejects a stale create request. */
  expectedModelId?: string
  expectedCatalogRevision?: number
}

/** Trusted desktop authorization captured when a local media task is created. */
export interface AgentGenerationAuthorization {
  connectionId: 'local-fal'
  /** Explicit consent to transfer local media references to the generation provider. */
  mediaTransferConsent: true
  maxCostMicros: number
  /** Multi-operation mode pins (1..3 unique kinds). */
  models?: AgentGenerationModelPin[]
  /** The first bounded slice admits one paid generation attempt per task; multi-op admits 1..24. */
  maxCalls?: number
  /** Optional UI snapshot guards; the Host rejects a stale create request. */
  expectedModelId?: string
  expectedCatalogRevision?: number
  /** Exact artifact refs the user allowed for this task, in transfer order. */
  artifactRefs?: AgentArtifactRef[]
  /** Exact defaults selected from the pinned local media catalog. */
  params?: Record<string, unknown>
}

export interface AgentLlmPricingView {
  inputPerMillion: number
  outputPerMillion: number
  checkedAt: string
}

export interface AgentLlmBudgetView {
  grantId: string
  connectionId: 'local-fal'
  currency: 'USD'
  maxCostMicros: number
  reservedMicros: number
  chargedMicros: number
  overshootMicros: number
  calls: number
  maxCalls: number
  status: 'active' | 'blocked' | 'overspent' | 'exhausted'
  modelId: string
  catalogRevision: number
  pricing: AgentLlmPricingView
}

export interface AgentGenerationBudgetView {
  grantId: string
  connectionId: 'local-fal'
  currency: 'USD'
  maxCostMicros: number
  reservedMicros: number
  chargedMicros: number
  overshootMicros: number
  calls: number
  maxCalls: number
  status: 'active' | 'blocked' | 'overspent' | 'exhausted'
  modelId: string
  catalogRevision: number
  artifactRefs?: AgentArtifactRef[]
  /** Present only for multi-operation tasks; modelId mirrors pins[0].modelId */
  pins?: AgentGenerationModelPin[]
}

/**
 * Canonical per-task spend ledger shared by every local-fal paid tool.
 *
 * Tool-specific budget views keep their model/payload pins for compatibility,
 * but admission and settlement use this single aggregate ledger.  This is the
 * contract sent to an agent package, so a package cannot infer two independent
 * ceilings by looking at the start payload.
 */
export interface AgentSpendBudgetView {
  grantId: string
  connectionId: 'local-fal'
  currency: 'USD'
  maxCostMicros: number
  reservedMicros: number
  chargedMicros: number
  overshootMicros: number
  calls: number
  maxCalls: number
  status: 'active' | 'blocked' | 'overspent' | 'exhausted'
}

export interface AgentLlmCatalogModelView {
  id: string
  name: string
  active: boolean
  textPricing?: AgentLlmPricingView
  contextWindowTokens?: number
}

export interface AgentLlmCatalogView {
  revision: number
  connection: { id: 'local-fal'; kind: 'llm'; status: 'ready' | 'unavailable' }
  defaultModelId: string | null
  models: AgentLlmCatalogModelView[]
}

export interface AgentArtifactRef {
  artifactId: string
  revision: number
  checksum: string
}

/**
 * Host-owned rough-cut manifest.  It names exact task artifacts and bounded
 * timeline slices; it never carries filesystem paths, URLs, filters, or argv.
 */
export interface AgentMediaRenderClip {
  artifact: AgentArtifactRef
  order: number
  startMs: number
  durationMs: number
}

/** Output frame presets of the v1 rough-cut; sources are fitted with bars. */
export type AgentMediaRenderFrame = '1280x720' | '720x1280' | '1080x1080'

export interface AgentMediaRenderManifest {
  version: 1
  mode: 'rough-cut'
  /** The bounded v1 primitive is an explicitly silent preview profile. */
  audio: 'mute'
  clips: AgentMediaRenderClip[]
  fps: 24 | 25 | 30
  /** Output frame; omitted means the landscape default '1280x720'. */
  frame?: AgentMediaRenderFrame
  maxDurationMs: number
  maxOutputBytes: number
}

export interface AgentInputItem {
  itemId: string
  artifactId: string
  revision: number
  checksum: string
  kind: 'image' | 'video' | 'audio' | 'text' | 'document' | 'plan'
  caption: string
  text?: string
  width?: number
  height?: number
  durationMs?: number
}

export interface AgentStartPayload {
  taskType: string
  instruction: string
  input: Record<string, unknown>
  projectRef: ProjectRef
  inputs: AgentInputItem[]
  workspaceId: string
  connections: AgentConnection[]
  grants: AgentGrant[]
  /** Aggregate local-fal spend ledger for both paid tools. */
  spendBudget?: AgentSpendBudgetView
  generationPins?: Array<{ kind: 'image' | 'video' | 'audio'; modelId: string; catalogRevision: number; params: Record<string, unknown> }>
}

export interface AgentCheckpointFile {
  path: string
  checksum: string
}

export interface AgentCheckpointPayload {
  checkpointId: string
  stateVersion: number
  state: Record<string, unknown>
  files: AgentCheckpointFile[]
}

export interface AgentToolResultPayload {
  operationId: string
  tool: AgentTool
  receiptId: string
  status: 'pending' | 'succeeded' | 'failed' | 'uncertain'
  result?: Record<string, unknown>
  error?: AgentError
}

export interface AgentReviewMaterial {
  artifactId: string
  revision: number
  checksum: string
  caption: string
  role: 'reference' | 'proposal' | 'result'
}

export interface AgentReviewPayload {
  reviewId: string
  revision: number
  stageId: string
  title: string
  question: string
  materials: AgentReviewMaterial[]
  decisions: Array<'approved' | 'changes-requested' | 'rejected'>
  extraQuestions?: Array<Record<string, unknown>>
  /** Exact pre-payment binding for a generation.request review. */
  requestedGrant?: AgentRequestedGrant
  generationSpec?: AgentGenerationReviewSpec
}

export interface AgentRequestedGrant {
  connectionId: string
  tool: 'llm.request' | 'generation.request'
  artifactRefs: AgentArtifactRef[]
  maxCalls: number
  maxCost: { currency: 'USD'; amountMicros: number }
}

export interface AgentGenerationReviewSpec {
  kind: 'image' | 'video' | 'audio'
  modelId: string
  /** Catalog revision used to approve the exact generation scope. */
  catalogRevision: number
  promptHash: string
  refs: AgentArtifactRef[]
  paramsHash: string
  /** Optional review-safe echo so a user can inspect the exact request before approval. */
  prompt?: string
  params?: Record<string, unknown>
  estimateMicros?: number
}

export interface AgentDecisionPayload {
  reviewId: string
  revision: number
  decision: 'approved' | 'changes-requested' | 'rejected'
  comment: string
  answers: Record<string, string>
  actorId: string
  decidedAt: string
  grants: AgentGrant[]
  /** Подписанное согласие на платную генерацию, полученное с планшета
   *  (локальная сеть). Обязательно для подтверждённых платных решений с
   *  планшета; остаётся в решении как доказательство согласия. */
  consent?: boolean
}

export interface AgentArtifact {
  artifactId: string
  revision: number
  checksum: string
  kind: 'image' | 'video' | 'audio' | 'text' | 'document' | 'plan'
  caption: string
  mimeType: string
  sizeBytes: number
  mediaSrc: `/media/${string}`
  previewSrc?: `/media/${string}`
  provenance: 'generated' | 'reference' | 'derived'
  text?: string
  width?: number
  height?: number
  durationMs?: number
}

/**
 * A local Host capture request names a board item, never a client-provided
 * filesystem path or checksum.  The Host resolves the current local board
 * snapshot and freezes the native media before returning a receipt.
 */
export interface AgentGenerationCaptureInput {
  itemId: string
  kind: Extract<AgentArtifact['kind'], 'image' | 'video' | 'audio'>
}

export interface AgentGenerationCaptureRequest {
  projectRef: ProjectRef
  /** Revision returned by the board save immediately before capture. */
  projectRevision: number
  inputs: AgentGenerationCaptureInput[]
}

export interface AgentGenerationCaptureReceipt {
  itemId: string
  artifact: AgentArtifact
}

export interface AgentReviewView extends AgentReviewPayload {
  status: 'pending' | 'approved' | 'changes-requested' | 'rejected' | 'superseded'
  decision?: AgentDecisionPayload
}

export interface AgentTaskEvent {
  cursor: number
  taskId: string
  type: string
  at: number
  payload: Record<string, unknown>
}

export interface AgentTaskView {
  taskId: string
  requestId: string
  packageId: string
  packageVersion: string
  packageSha: string
  installationId?: string
  protocolVersion: typeof AGENT_PROTOCOL_VERSION
  projectRef: ProjectRef
  ownerId: string
  controllerId: string
  /** Server-authoritative controls; absent on legacy Host receipts. */
  canControl?: boolean
  canReview?: boolean
  visibility?: 'owner' | 'peer'
  taskType: string
  instruction: string
  input: Record<string, unknown>
  inputs: AgentInputItem[]
  workspaceId: string
  state: AgentTaskState
  llmBudget?: AgentLlmBudgetView
  generationBudget?: AgentGenerationBudgetView
  spendBudget?: AgentSpendBudgetView
  progress?: { stageId: string; label: string; status: string; completed?: number; total?: number }
  revision: number
  eventCursor: number
  checkpoint?: AgentCheckpointPayload
  reviews: AgentReviewView[]
  receipts: AgentToolResultPayload[]
  artifacts: AgentArtifact[]
  canvasItems: Array<{ slotId: string; itemId: string; revision: number; artifactId: string }>
  /** Results waiting for an attached local canvas to persist its own snapshot. */
  pendingCanvasItems?: Array<{
    operationId: string
    waitId: string
    workspaceId: string
    slotId: string
    itemId: string
    revision: number
    artifactId: string
  }>
  error?: AgentError
  createdAt: number
  updatedAt: number
}

export interface AgentPackageSummary {
  id: string
  name: string
  description: string
  version: string
  packageSha: string
  protocolVersion: typeof AGENT_PROTOCOL_VERSION
  taskTypes: AgentPackageTaskTypeSummary[]
  permissions: string[]
  lifecycle: { pause: 'checkpoint' | 'immediate'; resume: true; cancel: true }
  handshake: 'ready' | 'failed'
  handshakeError?: string
  installationId?: string
  status?: 'ready' | 'disabled' | 'failed' | 'unsupported'
  active?: boolean
  /** Cloud operator catalog pin; absent on legacy Host libraries. */
  catalogRevision?: number
  source?: AgentPackageSourceView
  runtime?: { kind: 'node'; version: string; integrity: string; environmentId: string }
}

/** Deliberately narrow, data-only fields that the generic task form can render. */
export interface AgentInputField {
  key: string
  label?: string
  description?: string
  kind: 'string' | 'number' | 'boolean' | 'enum'
  required?: boolean
  enum?: string[]
  default?: string | number | boolean
  integer?: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

export interface AgentInputSchemaView {
  type: 'object'
  fields: AgentInputField[]
}

export interface AgentPackageTaskTypeSummary {
  id: string
  label: string
  description: string
  outputKinds: string[]
  generation?: {
    kinds: Array<'image' | 'video' | 'audio'>
    maxCalls: number
  }
  llmCalls?: number
  inputSchema?: AgentInputSchemaView
}

export interface AgentGitPackageSource {
  kind: 'git'
  url: string
  ref?: string
  subdir?: string
}

/** A previously uploaded immutable ZIP.  It is never represented as Git. */
export interface AgentArchivePackageSource {
  kind: 'archive'
  archiveId: string
  subdir?: string
}

export interface AgentPackageSourceView {
  kind: 'bundled' | 'git' | 'archive'
  canonicalUrl?: string
  requestedRef?: string
  resolvedSha?: string
  archiveId?: string
  archiveSha?: string
  treeSha?: string
  provenance?: Record<string, string>
  subdir?: string
}

export interface AgentPackageIssue {
  code: string
  message: string
  path?: string
  severity: 'error' | 'warning'
}

export interface AgentPackageManifestView {
  id: string
  name: string
  description: string
  version: string
  protocolVersion: typeof AGENT_PROTOCOL_VERSION
  taskTypes: AgentPackageTaskTypeSummary[]
  permissions: string[]
  lifecycle: { pause: 'checkpoint' | 'immediate'; resume: true; cancel: true }
  runtime: { kind: 'node' | 'python'; version: string; entrypoint: string; dependencies: 'stdlib' | 'lockfile' }
}

export interface AgentPackageTrustView {
  explicitTrustRequired: true
  requiredPermissions: string[]
  approvedPermissions?: string[]
  /** Host broker permissions do not sandbox arbitrary package code. */
  disclaimer: string
}

export interface AgentPythonRuntimePin {
  kind: 'python'
  version: string
  integrity: string
  environmentId: string
  executableRelative: string
  stdlibIntegrity: string
  treeSha: string
  archiveSha: string
}

export type AgentPackageRuntimeView =
  | { kind: 'node'; version: string; integrity: string; environmentId: string }
  | AgentPythonRuntimePin

export interface AgentPackageCheckView {
  checkId: string
  source: AgentPackageSourceView
  manifest: AgentPackageManifestView
  packageSha: string
  supported: boolean
  issues: AgentPackageIssue[]
  trust: AgentPackageTrustView
  revision: number
}

export interface AgentPackageInstallationView {
  installationId: string
  packageId: string
  version: string
  packageSha: string
  source: AgentPackageSourceView
  runtime: AgentPackageRuntimeView
  status: 'ready' | 'disabled' | 'failed' | 'unsupported' | 'removed'
  active: boolean
  createdAt: number
  updatedAt: number
}

export interface AgentPackageLibraryView {
  revision: number
  packages: AgentPackageSummary[]
  installations?: AgentPackageInstallationView[]
}

export interface AgentPackageCheckRequest {
  requestId: string
  source: AgentGitPackageSource | AgentArchivePackageSource
}

export interface AgentPackageInstallRequest {
  requestId: string
  checkId: string
  expectedRevision: number
  trustConfirmed: true
  approvedPermissions: string[]
  priorInstallationId?: string
}

export interface AgentPackageManageRequest {
  requestId: string
  expectedRevision: number
  installationId?: string
  packageId?: string
}

export interface AgentPackageUpdateRequest extends AgentPackageInstallRequest {
  priorInstallationId: string
}

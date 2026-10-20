import type {
  AgentDecisionPayload,
  AgentGenerationCaptureReceipt,
  AgentGenerationCaptureRequest,
  AgentGenerationAuthorization,
  AgentLlmAuthorization,
  AgentPackageCheckRequest,
  AgentPackageCheckView,
  AgentPackageInstallRequest,
  AgentPackageManageRequest,
  AgentPackageUpdateRequest,
} from '../../../../../packages/agent-protocol/index'
import type { AgentArchiveUpload, AgentDecisionRequest, AgentHostClient, AgentPythonRuntimeStatus } from './agentHostClient'
import type { AgentAction, AgentPanelState, AgentTaskSnapshot } from './agentPanelModel'

/** Board-facing controller. It deliberately contains task/review actions only;
 * package installation remains a separate Host settings surface. */
export interface AgentTaskPanelController {
  state: AgentPanelState
  collapsed: boolean
  setCollapsed(value: boolean): void
  instruction: string
  setInstruction(value: string): void
  selectedTaskId: string | null
  setSelectedTaskId(value: string | null): void
  selectedTask: AgentTaskSnapshot | undefined
  llmCatalog: AgentPanelState['llmCatalog']
  generationCatalog: AgentPanelState['generationCatalog']
  demoPackage: AgentPanelState['packages'][number] | undefined
  packageRevision: number
  captureGenerationInputs(input: AgentGenerationCaptureRequest): Promise<AgentGenerationCaptureReceipt[]>
  start(input: { packageId: string; taskType: string; input: Record<string, unknown>; capturedArtifacts?: AgentGenerationCaptureReceipt[]; llm?: AgentLlmAuthorization; generation?: AgentGenerationAuthorization; launchInputs?: import('../../../../../packages/agent-protocol/index').AgentInputItem[]; requestId?: string; packageVersion?: string; packageSha?: string; catalogRevision?: number }): Promise<void>
  command(taskId: string, action: AgentAction): Promise<void>
  decide(taskId: string, reviewId: string, decision: AgentDecisionPayload['decision'], comment: string, consent?: boolean): Promise<void>
  refresh(): Promise<void>
}

/** Host settings controller. Keeping this type distinct makes it impossible
 * for a Cloud task client to accidentally satisfy an installer dependency. */
export interface AgentPackageController {
  state: AgentPanelState
  packageRevision: number
  uploadPackageArchive(input: { requestId: string; archive: Blob; provenance?: Record<string, string> }): Promise<AgentArchiveUpload>
  getPythonRuntime(): Promise<AgentPythonRuntimeStatus>
  installPythonRuntime(): Promise<AgentPythonRuntimeStatus>
  checkPackage(input: AgentPackageCheckRequest): Promise<AgentPackageCheckView>
  installPackage(input: AgentPackageInstallRequest): Promise<void>
  updatePackage(input: AgentPackageUpdateRequest): Promise<void>
  managePackage(action: 'enable' | 'disable' | 'rollback' | 'remove', input: AgentPackageManageRequest): Promise<void>
}

/** Board-facing legacy name retained for existing panel/composer imports. */
export type AgentPanelController = AgentTaskPanelController
/** Optional full surface for old callers that intentionally combine board and
 * Host settings (the Cloud adapter never implements this type). */
export type AgentHostPanelController = AgentTaskPanelController & AgentPackageController

/**
 * The package/settings surface deliberately does not need a board task stream.
 * Keep its dependency narrow so Settings → Agents can inspect and install
 * packages without opening a second listTasks/SSE controller for a board.
 */
export function makeAgentRequestId(prefix = 'ui'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

// Keep the request shape available to the hook without making the controller
// contract depend on its runtime implementation.
export type { AgentDecisionRequest, AgentHostClient }

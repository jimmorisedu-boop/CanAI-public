import { config } from '../config.js'
import { AgentTaskJournal } from './journal.js'
import { AgentHost } from './host.js'
import { AgentPackageRegistry } from './packages.js'
import { AgentToolBroker } from './tools.js'
import { AgentPackageLibrary } from './library.js'
import { AgentPackageManager, defaultPackageManager } from './package-manager.js'
import { GitHubSourceTransport } from './package-source.js'
import { logError } from '../log.js'
import { catalogLibrary } from '../catalogLibrary.js'
import { AgentLlmBroker } from './llm-broker.js'
import { AgentGenerationBroker } from './generation-broker.js'
import { AgentPackageUploadStore } from './package-upload.js'
import { AgentHostAdmission } from './host-admission.js'
import { cleanMediaRenderScratch } from './tool-media-render.js'

export const agentPackageRegistry = new AgentPackageRegistry()
export const agentPackageLibrary = new AgentPackageLibrary(config.agentLibraryFile)
export const agentTaskJournal = new AgentTaskJournal(config.agentTasksFile, {
  workspaceRoot: config.agentWorkspaceDir,
  checkpointRoot: config.agentCheckpointDir,
})
export const agentHostAdmission = new AgentHostAdmission()
export const agentLlmBroker = new AgentLlmBroker({
  journal: agentTaskJournal,
  catalog: catalogLibrary,
  // Mock mode deliberately fails closed for Agent LLM: the deterministic
  // demo agent remains available, while no real fal key/provider can be used
  // accidentally when CANAI_MOCK=1 is set.
  mockMode: config.mockMode,
  connectionReady: () => !config.mockMode && Boolean(config.falKey),
})
export const agentGenerationBroker = new AgentGenerationBroker({
  journal: agentTaskJournal,
  catalog: catalogLibrary,
  mediaDir: config.mediaDir,
  // Mock mode deliberately fails closed for Agent generation; tests inject
  // an explicit runner instead of allowing a paid provider call.
  mockMode: config.mockMode,
  connectionReady: () => !config.mockMode && Boolean(config.falKey),
})
let hostRef: AgentHost | null = null
export const agentPackageManager: AgentPackageManager = defaultPackageManager({
  library: agentPackageLibrary,
  registry: agentPackageRegistry,
  source: new GitHubSourceTransport(),
  packageRoot: config.agentPackageDir,
  stateRoot: config.agentPackageStateDir,
  stagingRoot: config.agentPackageStagingDir,
  runtimeDir: config.runtimeDir,
  uploads: new AgentPackageUploadStore(config.agentPackageUploadRoot),
  activeTaskPins: async () => new Set((await hostRef?.list() ?? []).filter((task) => !['cancelled', 'succeeded', 'failed'].includes(task.state)).flatMap((task) => task.installationId ? [task.installationId] : [])),
  packageLifecycleLock: (operation) => agentHostAdmission.withPackageLifecycleLock(operation),
})
export const agentToolBroker = new AgentToolBroker({
  mediaDir: config.mediaDir,
  workspaceRoot: config.agentWorkspaceDir,
  llm: agentLlmBroker,
  generation: agentGenerationBroker
})
export const agentHost = new AgentHost({
  journal: agentTaskJournal,
  packages: agentPackageRegistry,
  broker: agentToolBroker,
  workspaceRoot: config.agentWorkspaceDir,
  stateRoot: config.agentPackageStateDir,
  mediaDir: config.mediaDir,
  runtimeDir: config.runtimeDir,
  admission: agentHostAdmission,
})
hostRef = agentHost

export async function startAgentRuntime(): Promise<void> {
  // Оборванный рендер оставляет в медиа приватную папку с копиями исходников.
  // На томе без жёстких ссылок это настоящие гигабайты, поэтому убираем сразу.
  await cleanMediaRenderScratch(config.mediaDir)
  await agentPackageRegistry.loadBundled()
  try { await agentPackageManager.initialize() }
  catch (error) { logError('agent-package-library', error) }
  await agentHost.restore()
}

import { api } from '../api'
import { initProjectSync } from '../spaces/canvas/projectSync'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type {
  TabletBoardSession,
  TabletBoardState,
  TabletProject,
  TabletRuntime,
} from './runtime'
import type { ProjectConflictSnapshot } from '../spaces/canvas/projectConflict'
import { createAgentHostClient } from '../spaces/canvas/agents/agentHostClient'

// main.tsx installs the LAN CSRF/session fetch bridge after module imports
// have evaluated. Resolve the global fetch at request time so the agent
// client cannot accidentally capture the pre-bridge browser fetch.
const tabletFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)

function localProject(value: unknown): TabletProject | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || typeof row.name !== 'string') return null
  const project: TabletProject = {
    id: row.id, name: row.name,
    thumb: typeof row.thumb === 'string' ? row.thumb : null,
    permissions: { canRead: true, canEdit: true, canManage: true },
  }
  if (typeof row.updatedAt === 'number') project.updatedAt = row.updatedAt
  return project
}

export class LanTabletRuntime implements TabletRuntime {
  readonly kind = 'lan' as const
  /**
   * LAN is the tablet view of the local Host.  The descriptor is the source
   * of truth for the dock: it is not inferred from the project source in a
   * component, so a future paired transport can expose a different policy.
   */
  readonly capabilities = {
    preparation: { available: true, transport: 'local-api' as const },
    agents: {
      mode: 'control' as const,
      transport: 'host' as const,
      catalog: 'host-installed' as const,
      billing: 'local-fal' as const,
      canObserve: true,
      canReview: true,
      client: createAgentHostClient(tabletFetch),
      canControl: true,
      canLaunch: true,
      label: 'On this computer',
    },
  }

  async agentCapability(_projectId: string) {
    return this.capabilities.agents
  }

  async listProjects(): Promise<TabletProject[]> {
    const list = await api.listProjects()
    return (list.projects as unknown[]).map(localProject).filter((item): item is TabletProject => item != null)
  }

  async openBoard(
    projectId: string,
    store: CanvasStore,
    onState: (state: TabletBoardState) => void,
    _canEdit: boolean,
    onError?: (error: unknown) => void,
    onConflict?: (conflict: ProjectConflictSnapshot | null) => void,
  ): Promise<TabletBoardSession> {
    return initProjectSync(store, projectId, (state) => {
      onState(
        state === 'ready' || state === 'loading' || state === 'conflict' || state === 'conflict-saving'
          ? state
          : 'error',
      )
    }, onConflict, undefined, onError)
  }

  assetUrl(assetId: string): string {
    return `/media/${encodeURIComponent(assetId)}`
  }

  uploadProjectRef(projectId: string): { source: 'local'; id: string } {
    return { source: 'local', id: projectId }
  }

  async uploadAsset(_projectId: string, file: File, signal?: AbortSignal) {
    const uploaded = await api.uploadFile(file, signal)
    return { assetId: '', src: uploaded.url, mime: uploaded.mime }
  }

  async createProject(title: string): Promise<TabletProject> {
    const { project } = await api.createProject(title)
    return localProject(project)!
  }

  async renameProject(projectId: string, title: string): Promise<TabletProject> {
    await api.renameProject(projectId, title)
    const project = (await this.listProjects()).find((item) => item.id === projectId)
    if (!project) throw new Error('Board not found')
    return project
  }

  async archiveProject(projectId: string): Promise<void> {
    await api.deleteProject(projectId)
  }

  async listArchivedProjects(): Promise<TabletProject[]> {
    const { projects } = await api.listProjectTrash()
    return projects.map(localProject).filter((project): project is TabletProject => project !== null)
  }

  async restoreProject(projectId: string): Promise<TabletProject> {
    const { project } = await api.restoreTrashedProject(projectId)
    const restored = localProject(project)
    if (!restored) throw new Error('Server returned an invalid board')
    return restored
  }

  async boardPresence() {
    const response = await api.boardPresence()
    return response.boards ?? []
  }
}

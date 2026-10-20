import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { BoardHolder } from '../types'
import type { ProjectConflictSnapshot } from '../spaces/canvas/projectConflict'
import type { BoardFileTransport } from '../spaces/canvas/konva/boardUploader'
import type { AgentTaskClient } from '../spaces/canvas/agents/agentHostClient'
import type { AgentPresentationCapability } from '../spaces/canvas/agents/agentCapabilities'

export type TabletRuntimeKind = 'lan'

export interface TabletAgentCapability extends AgentPresentationCapability {
  mode: 'none' | 'observe' | 'control'
  client?: AgentTaskClient
}

export interface TabletRuntimeCapabilities {
  preparation: { available: boolean; transport: 'local-api'; reason?: string }
  agents: TabletAgentCapability
}

export interface TabletProject {
  id: string
  name: string
  updatedAt?: number
  thumb?: string | null
  permissions: { canRead: boolean; canEdit: boolean; canManage: boolean }
}

export interface TabletBoardSession {
  dispose(): void | Promise<void>
  flushAndWait?(): Promise<{ revision: number }>
  retryConflictRecovery?(): Promise<ProjectConflictSnapshot>
  resumeInvalidSnapshot?(): void
  isWritable?(): boolean
  undo?(): boolean
  canUndo?(): boolean
  redo?(): boolean
  canRedo?(): boolean
  subscribeHistory?(listener: () => void): () => void
  getHistoryVersion?(): number
}

export type TabletBoardState =
  | 'loading'
  | 'opening'
  | 'ready'
  | 'readonly'
  | 'offline'
  | 'error'
  | 'conflict-saving'
  | 'conflict'

export interface TabletRuntime {
  readonly kind: TabletRuntimeKind
  readonly capabilities?: TabletRuntimeCapabilities
  agentCapability?(projectId: string): Promise<TabletAgentCapability>
  listProjects(): Promise<TabletProject[]>
  openBoard(
    projectId: string,
    store: CanvasStore,
    onState: (state: TabletBoardState) => void,
    canEdit: boolean,
    onError?: (error: unknown) => void,
    onConflict?: (conflict: ProjectConflictSnapshot | null) => void,
  ): Promise<TabletBoardSession> | TabletBoardSession
  assetUrl(assetId: string, preview?: number): string
  uploadProjectRef(projectId: string): { source: 'local'; id: string }
  uploadAsset?(projectId: string, file: File, signal?: AbortSignal): Promise<{
    assetId: string
    assetRevision?: number
    assetChecksum?: string
    src: string
    mime: string
  }>
  boardFileTransport?(): BoardFileTransport
  createProject?(title: string): Promise<TabletProject>
  renameProject?(projectId: string, title: string): Promise<TabletProject>
  archiveProject?(projectId: string): Promise<void>
  listArchivedProjects?(): Promise<TabletProject[]>
  restoreProject?(projectId: string): Promise<TabletProject>
  boardPresence?(): Promise<Array<{ projectId: string; holder: BoardHolder }>>
}

export interface TabletMediaUpload {
  assetId?: string
  assetRevision?: number
  assetChecksum?: string
  url: string
  mime: string
}

export type TabletMediaUploader = (file: File, signal?: AbortSignal) => Promise<TabletMediaUpload>

export function tabletMediaUploader(runtime: TabletRuntime, projectId: string): TabletMediaUploader {
  return async (file, signal) => {
    if (!runtime.uploadAsset) throw new Error('File uploads are unavailable on this device')
    const uploaded = await runtime.uploadAsset(projectId, file, signal)
    return {
      ...(uploaded.assetId ? { assetId: uploaded.assetId } : {}),
      ...(uploaded.assetRevision !== undefined ? { assetRevision: uploaded.assetRevision } : {}),
      ...(uploaded.assetChecksum ? { assetChecksum: uploaded.assetChecksum } : {}),
      url: uploaded.src,
      mime: uploaded.mime,
    }
  }
}

export function buildTabletRuntimeKind(): TabletRuntimeKind {
  return 'lan'
}

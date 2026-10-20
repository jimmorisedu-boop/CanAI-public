import type {
  AgentDecisionPayload,
  AgentPackageCheckRequest,
  AgentPackageCheckView,
  AgentPackageInstallRequest,
  AgentPackageLibraryView,
  AgentPackageManageRequest,
  AgentPackageSummary,
  AgentPackageRuntimeView,
  AgentPackageUpdateRequest,
  AgentTaskEvent,
  AgentTaskView,
  AgentLlmCatalogView,
  AgentGenerationCaptureReceipt,
  AgentGenerationCaptureRequest,
  ProjectRef,
} from '../../../../../packages/agent-protocol/index'
import type { AgentTaskLaunch } from './agentPanelModel'
import {
  archiveUpload,
  collection,
  generationCapture,
  hasPackageLibrary,
  llmCatalog,
  packageCheck,
  packageLibrary,
  parseEvent,
  pythonRuntime,
  unwrapTask,
} from './agentHostParsing'
import { generationCatalog, type AgentGenerationCatalog } from './agentGenerationModel'

export const AGENT_HOST_BASE = '/api'

/** Receipt returned by the binary ZIP upload endpoint. */
export interface AgentArchiveUpload {
  archiveId: string
  archiveSha: string
  sizeBytes: number
  provenance?: Record<string, string>
  createdAt: number
}

/** Read-only status of the verified Windows x64 portable Python runtime. */
export interface AgentPythonRuntimeStatus {
  supported: boolean
  ready: boolean
  version: string
  rootRelative: string
  reason?: string
  runtime?: Extract<AgentPackageRuntimeView, { kind: 'python' }>
}

/**
 * Board task transport.  This is intentionally free of installer/runtime
 * methods so a remote Cloud catalog can power the dock without accidentally
 * exposing ZIP, Git, Python or trust operations.
 */
export interface AgentTaskClient {
  listPackages(signal?: AbortSignal): Promise<AgentPackageSummary[]>
  listPackageLibrary(signal?: AbortSignal): Promise<AgentPackageLibraryView>
  listTasks(projectRef: ProjectRef, signal?: AbortSignal): Promise<AgentTaskView[]>
  /** Optional until a Host build exposes the local-fal catalog route. */
  getLlmCatalog?(signal?: AbortSignal): Promise<AgentLlmCatalogView>
  /** Local Host media catalog. Cloud clients deliberately do not implement this. */
  getGenerationCatalog?(signal?: AbortSignal): Promise<AgentGenerationCatalog>
  /** Freeze selected local board media into a Host-owned native receipt. */
  captureGenerationInputs?(input: AgentGenerationCaptureRequest, signal?: AbortSignal): Promise<AgentGenerationCaptureReceipt[]>
  startTask(input: AgentTaskLaunch & { requestId: string }): Promise<AgentTaskView>
  getTask(taskId: string, signal?: AbortSignal): Promise<AgentTaskView>
  commandTask(
    taskId: string,
    action: 'pause' | 'resume' | 'cancel',
    input: { requestId: string; expectedRevision: number; reason: string },
  ): Promise<AgentTaskView>
  decideReview(
    taskId: string,
    reviewId: string,
    input: AgentDecisionRequest,
  ): Promise<AgentTaskView>
  subscribe(
    taskId: string,
    after: number,
    listener: (event: AgentTaskEvent | AgentTaskView) => void,
    status?: (state: 'live' | 'reconnecting' | 'offline') => void,
  ): () => void
  /** Project journal for new tasks/peer updates; optional on legacy Host. */
  subscribeProject?(
    projectRef: ProjectRef,
    after: number,
    listener: (event: AgentTaskEvent | AgentTaskView) => void,
    status?: (state: 'live' | 'reconnecting' | 'offline') => void,
  ): () => void
}

/** Host-only package/runtime management. Never implement this on Cloud. */
export interface AgentInstallerClient {
  uploadPackageArchive(input: { requestId: string; archive: Blob; provenance?: Record<string, string> }): Promise<AgentArchiveUpload>
  getPythonRuntime?(signal?: AbortSignal): Promise<AgentPythonRuntimeStatus>
  installPythonRuntime?(): Promise<AgentPythonRuntimeStatus>
  checkPackage(input: AgentPackageCheckRequest): Promise<AgentPackageCheckView>
  installPackage(input: AgentPackageInstallRequest): Promise<AgentPackageLibraryView>
  updatePackage(input: AgentPackageUpdateRequest): Promise<AgentPackageLibraryView>
  managePackage(
    action: 'enable' | 'disable' | 'rollback' | 'remove',
    input: AgentPackageManageRequest,
  ): Promise<AgentPackageLibraryView>
}

/** Backwards-compatible LAN Host surface, combining both explicit halves. */
export interface AgentHostClient extends AgentTaskClient, AgentInstallerClient {}

/** Actor identity, timestamp and grants are Host-owned; the browser sends only intent. */
export type AgentDecisionRequest = Pick<AgentDecisionPayload, 'reviewId' | 'revision' | 'decision' | 'comment' | 'answers'> & {
  requestId: string
  expectedRevision: number
  /** Явное согласие на оплачиваемую генерацию (второй клик). С сервера
   *  обязательно только для платных одобрений с планшета; на десктопе
   *  сервер его игнорирует. */
  consent?: boolean
}

interface EventSourceLike {
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: ((event: Event) => void) | null
  addEventListener?: (type: string, listener: (event: MessageEvent<string>) => void) => void
  removeEventListener?: (type: string, listener: (event: MessageEvent<string>) => void) => void
  close(): void
}

type EventSourceFactory = (url: string) => EventSourceLike

export class AgentHostRequestError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'AgentHostRequestError'
    this.status = status
    this.code = code
  }
}

export function classifyAgentHostFailure(error: unknown): {
  domainRefusal: boolean
  refreshLibrary: boolean
  message: string
} {
  if (error instanceof AgentHostRequestError) {
    const domainRefusal = error.status >= 400 && error.status < 500
    return {
      domainRefusal,
      refreshLibrary: domainRefusal && error.status === 409,
      message: error.message,
    }
  }
  return {
    domainRefusal: false,
    refreshLibrary: false,
    message: error instanceof Error ? error.message : 'Host rejected the library change',
  }
}

function eventSourceFactory(url: string): EventSourceLike {
  return new EventSource(url)
}

async function json<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | T | null
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : fallback
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
      ? body.code
      : undefined
    throw new AgentHostRequestError(error, response.status, code)
  }
  if (body == null) throw new Error(fallback)
  return body as T
}

function endpoint(path: string): string {
  return `${AGENT_HOST_BASE}${path}`
}

/**
 * Desktop agent transport. Agent routes are deliberately separate from
 * `/api/generate`; the tablet cloud bridge can translate the latter without
 * changing this local Host channel.
 */
export function createAgentHostClient(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  makeEventSource: EventSourceFactory = eventSourceFactory,
): AgentHostClient {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchImpl(endpoint(path), {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    })
    return json<T>(response, 'Could not reach CanAI Host')
  }
  const readPackageLibrary = async (signal?: AbortSignal): Promise<AgentPackageLibraryView> => {
    const body = await request<unknown>('/agents/packages', { signal })
    return packageLibrary(body)
  }

  return {
    async listPackages(signal) {
      return (await readPackageLibrary(signal)).packages
    },
    async listPackageLibrary(signal) {
      return readPackageLibrary(signal)
    },
    uploadPackageArchive(input) {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/zip',
        'idempotency-key': input.requestId,
      }
      if (input.provenance) headers['x-canai-package-provenance'] = JSON.stringify(input.provenance)
      return request<unknown>('/agents/packages/upload', {
        method: 'POST',
        headers,
        body: input.archive,
      }).then(archiveUpload)
    },
    getPythonRuntime(signal) {
      return request<unknown>('/agents/runtime/python', { signal }).then(pythonRuntime)
    },
    installPythonRuntime() {
      return request<unknown>('/agents/runtime/python/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }).then(pythonRuntime)
    },
    async listTasks(projectRef, signal) {
      const query = new URLSearchParams({ projectSource: projectRef.source, projectId: projectRef.id })
      const body = await request<unknown>(`/agent-tasks?${query.toString()}`, { signal })
      return collection<AgentTaskView>(body, 'tasks')
    },
    checkPackage(input) {
      return request<unknown>('/agents/packages/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(packageCheck)
    },
    async installPackage(input) {
      const body = await request<unknown>('/agents/packages/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (hasPackageLibrary(body)) return packageLibrary(body)
      return readPackageLibrary()
    },
    async updatePackage(input) {
      const body = await request<unknown>('/agents/packages/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (hasPackageLibrary(body)) return packageLibrary(body)
      return readPackageLibrary()
    },
    async managePackage(action, input) {
      const body = await request<unknown>(`/agents/packages/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (hasPackageLibrary(body)) return packageLibrary(body)
      return readPackageLibrary()
    },
    getLlmCatalog(signal) {
      return request<unknown>('/agents/llm/catalog', { signal }).then(llmCatalog)
    },
    getGenerationCatalog(signal) {
      return request<unknown>('/agents/generation/catalog', { signal }).then(generationCatalog)
    },
    captureGenerationInputs(input, signal) {
      return request<unknown>('/agents/generation/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal,
      }).then(generationCapture)
    },
    startTask(input) {
      return request<unknown>('/agent-tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(unwrapTask)
    },
    getTask(taskId, signal) {
      return request<unknown>(`/agent-tasks/${encodeURIComponent(taskId)}`, { signal }).then(unwrapTask)
    },
    commandTask(taskId, action, input) {
      return request<unknown>(`/agent-tasks/${encodeURIComponent(taskId)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(unwrapTask)
    },
    decideReview(taskId, reviewId, input) {
      return request<unknown>(
        `/agent-tasks/${encodeURIComponent(taskId)}/reviews/${encodeURIComponent(reviewId)}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      ).then(unwrapTask)
    },
    subscribe(taskId, after, listener, status) {
      const query = new URLSearchParams({ after: String(Math.max(0, after)) })
      const source = makeEventSource(endpoint(`/agent-tasks/${encodeURIComponent(taskId)}/events?${query}`))
      source.onopen = () => status?.('live')
      const onEvent = (event: MessageEvent<string>) => {
        const parsed = parseEvent(event.data)
        if (parsed) listener(parsed)
      }
      // Host labels its stream `event: agent`; named SSE events do not reach
      // EventSource.onmessage in browsers. Test/fallback sources may only
      // expose onmessage, so retain that path for compatibility.
      if (source.addEventListener) source.addEventListener('agent', onEvent)
      else source.onmessage = onEvent
      source.onerror = () => status?.('reconnecting')
      return () => {
        source.removeEventListener?.('agent', onEvent)
        source.close()
        status?.('offline')
      }
    },
  }
}

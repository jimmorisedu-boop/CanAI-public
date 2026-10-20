import type {
  AgentPackageCheckView,
  AgentPackageLibraryView,
  AgentPackageRuntimeView,
  AgentPackageSummary,
  AgentTaskEvent,
  AgentTaskView,
  AgentLlmCatalogView,
  AgentGenerationCaptureReceipt,
} from '../../../../../packages/agent-protocol/index'
import type { AgentArchiveUpload, AgentPythonRuntimeStatus } from './agentHostClient'

export function collection<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[]
  if (!body || typeof body !== 'object') return []
  const value = (body as Record<string, unknown>)[key]
  return Array.isArray(value) ? value as T[] : []
}

export function packageLibrary(value: unknown): AgentPackageLibraryView {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const nested = record.library && typeof record.library === 'object' && !Array.isArray(record.library)
    ? record.library as Record<string, unknown>
    : record
  const packages = Array.isArray(nested.packages) ? nested.packages as AgentPackageSummary[] : []
  const installations = Array.isArray(nested.installations)
    ? nested.installations as AgentPackageLibraryView['installations']
    : undefined
  const revision = typeof nested.revision === 'number' && Number.isSafeInteger(nested.revision)
    ? nested.revision
    : 0
  return { revision, packages, ...(installations ? { installations } : {}) }
}

export function hasPackageLibrary(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const nested = record.library && typeof record.library === 'object' && !Array.isArray(record.library)
    ? record.library as Record<string, unknown>
    : record
  return Array.isArray(nested.packages)
}

export function packageCheck(value: unknown): AgentPackageCheckView {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const nested = record.check
    if (nested && typeof nested === 'object') return nested as AgentPackageCheckView
    if (typeof record.checkId === 'string') return value as AgentPackageCheckView
  }
  throw new Error('Host returned an incomplete package check')
}

export function archiveUpload(value: unknown): AgentArchiveUpload {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const upload = record.upload && typeof record.upload === 'object' && !Array.isArray(record.upload)
    ? record.upload as Record<string, unknown>
    : record
  if (typeof upload.archiveId !== 'string' || !upload.archiveId
    || typeof upload.archiveSha !== 'string' || !/^[a-f0-9]{64}$/u.test(upload.archiveSha)
    || typeof upload.sizeBytes !== 'number' || !Number.isSafeInteger(upload.sizeBytes) || upload.sizeBytes <= 0
    || typeof upload.createdAt !== 'number' || !Number.isSafeInteger(upload.createdAt)) {
    throw new Error('Host returned an incomplete ZIP upload receipt')
  }
  const provenance = upload.provenance && typeof upload.provenance === 'object' && !Array.isArray(upload.provenance)
    ? Object.fromEntries(Object.entries(upload.provenance).filter(([, item]) => typeof item === 'string')) as Record<string, string>
    : undefined
  return {
    archiveId: upload.archiveId,
    archiveSha: upload.archiveSha,
    sizeBytes: upload.sizeBytes,
    createdAt: upload.createdAt,
    ...(provenance && Object.keys(provenance).length ? { provenance } : {}),
  }
}

export function pythonRuntime(value: unknown): AgentPythonRuntimeStatus {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const wrapped = record.runtime && typeof record.runtime === 'object' && !Array.isArray(record.runtime)
    ? record.runtime as Record<string, unknown>
    : undefined
  const status = wrapped && ('supported' in wrapped || 'ready' in wrapped || 'rootRelative' in wrapped) ? wrapped : record
  const metadata = status.runtime && typeof status.runtime === 'object' && !Array.isArray(status.runtime)
    ? status.runtime as Record<string, unknown>
    : status.kind === 'python' ? status : undefined
  const runtimeValue = metadata && metadata.kind === 'python' && typeof metadata.version === 'string'
    ? metadata as unknown as Extract<AgentPackageRuntimeView, { kind: 'python' }>
    : undefined
  return {
    supported: status.supported === true || Boolean(runtimeValue),
    ready: (status.ready === true || Boolean(runtimeValue)) && Boolean(runtimeValue),
    version: typeof status.version === 'string' ? status.version : typeof metadata?.version === 'string' ? metadata.version : '3.13.16',
    rootRelative: typeof status.rootRelative === 'string' ? status.rootRelative : '',
    ...(typeof status.reason === 'string' ? { reason: status.reason } : {}),
    ...(runtimeValue ? { runtime: runtimeValue } : {}),
  }
}

export function llmCatalog(value: unknown): AgentLlmCatalogView {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const nested = record.catalog
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as AgentLlmCatalogView
    return value as AgentLlmCatalogView
  }
  throw new Error('Host returned an incomplete LLM catalog')
}

export function generationCapture(value: unknown): AgentGenerationCaptureReceipt[] {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  if (!Array.isArray(record.receipts)) throw new Error('Host returned an incomplete native media capture receipt')
  return record.receipts.map((entry): AgentGenerationCaptureReceipt => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Host returned an invalid native media receipt')
    const row = entry as Record<string, unknown>
    const artifact = row.artifact
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error('Host returned an incomplete native artifact')
    const valueArtifact = artifact as Record<string, unknown>
    if (
      typeof row.itemId !== 'string' || !row.itemId
      || typeof valueArtifact.artifactId !== 'string' || !valueArtifact.artifactId
      || !Number.isSafeInteger(valueArtifact.revision) || (valueArtifact.revision as number) < 1
      || typeof valueArtifact.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(valueArtifact.checksum)
      || (valueArtifact.kind !== 'image' && valueArtifact.kind !== 'video' && valueArtifact.kind !== 'audio')
      || typeof valueArtifact.caption !== 'string' || !valueArtifact.caption.trim()
      || typeof valueArtifact.mimeType !== 'string' || !valueArtifact.mimeType.trim()
      || !Number.isSafeInteger(valueArtifact.sizeBytes) || (valueArtifact.sizeBytes as number) < 1
      || typeof valueArtifact.mediaSrc !== 'string' || !/^\/media\/[^/\\?#]+$/u.test(valueArtifact.mediaSrc)
      || valueArtifact.provenance !== 'reference'
    ) throw new Error('Host returned an invalid native artifact receipt')
    return { itemId: row.itemId, artifact: valueArtifact as unknown as AgentGenerationCaptureReceipt['artifact'] }
  })
}

function taskFromEvent(value: unknown): AgentTaskView | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const nested = record.task ?? record.snapshot ?? (record.payload && typeof record.payload === 'object'
    ? (record.payload as Record<string, unknown>).task
    : undefined)
  if (!nested || typeof nested !== 'object') return null
  const task = nested as AgentTaskView
  return typeof task.taskId === 'string' && typeof task.revision === 'number' ? task : null
}

export function unwrapTask(value: unknown): AgentTaskView {
  const task = taskFromEvent(value)
  if (task) return task
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const nested = record.task ?? record.snapshot ?? record.data
    const nestedTask = taskFromEvent(nested)
    if (nestedTask) return nestedTask
  }
  return value as AgentTaskView
}

export function parseEvent(value: string): AgentTaskEvent | AgentTaskView | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (taskFromEvent(parsed)) return parsed as AgentTaskEvent | AgentTaskView
    return parsed as AgentTaskEvent
  } catch {
    return null
  }
}

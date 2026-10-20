import type {
  ApplyLifecycleInput,
  CatalogDefaults,
  CatalogDraftSetupResponse,
  CatalogLibraryView,
  CatalogModel,
  DiscoverCatalogModelResult,
  DraftTariffInput,
  DraftTestInput,
  DraftTestQuote,
  DraftTestStatus,
  LifecyclePlan,
  ModelLifecycle,
} from '../types.js'

export type CatalogRequest = <T>(url: string, init?: RequestInit) => Promise<T>

export class CatalogConflictError<T = unknown> extends Error {
  readonly status = 409
  constructor(message: string, readonly submitted: T, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CatalogConflictError'
  }
}

function json(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function conflictSafe<T, S>(
  request: CatalogRequest,
  url: string,
  init: RequestInit | undefined,
  submitted: S,
): Promise<T> {
  try {
    return await request<T>(url, init)
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
      throw new CatalogConflictError(error instanceof Error ? error.message : 'Catalog changed', submitted, { cause: error })
    }
    throw error
  }
}

const base = '/api/catalog'
const draftPath = (id: string) => `${base}/drafts/${encodeURIComponent(id)}`
const modelPath = (id: string) => `${base}/models/${encodeURIComponent(id)}`

export const catalogLibraryClient = {
  load: (request: CatalogRequest): Promise<CatalogLibraryView> => request(`${base}/library`),

  setDefaults: (
    request: CatalogRequest,
    defaults: Partial<CatalogDefaults>,
    revision: number,
  ): Promise<CatalogLibraryView> => conflictSafe(
    request,
    `${base}/defaults`,
    json('PATCH', { defaults, revision }),
    defaults,
  ),

  discover: (
    request: CatalogRequest,
    url: string,
    revision: number,
  ): Promise<DiscoverCatalogModelResult> => conflictSafe(
    request,
    `${base}/discover`,
    json('POST', { url, revision }),
    url,
  ),

  saveDraft: (
    request: CatalogRequest,
    model: CatalogModel,
    revision: number,
  ): Promise<CatalogLibraryView> => conflictSafe(
    request,
    `${base}/drafts`,
    json('POST', { model, revision }),
    model,
  ),

  updateDraftTariff: (
    request: CatalogRequest,
    id: string,
    input: DraftTariffInput,
    revision: number,
  ): Promise<CatalogLibraryView> => conflictSafe(
    request,
    `${draftPath(id)}/tariff`,
    json('PATCH', { ...input, revision }),
    input,
  ),

  setup: (
    request: CatalogRequest,
    id: string,
    revision: number,
  ): Promise<CatalogDraftSetupResponse> => conflictSafe(
    request,
    `${draftPath(id)}/setup`,
    json('POST', { revision }),
    { id, revision },
  ),

  quoteTest: (
    request: CatalogRequest,
    id: string,
    input: DraftTestInput,
  ): Promise<DraftTestQuote> => request(
    `${draftPath(id)}/tests/quote`,
    json('POST', { refs: input.refs, params: input.params }),
  ),

  startTest: (
    request: CatalogRequest,
    id: string,
    input: DraftTestInput,
    idempotencyKey: string,
  ): Promise<{ jobId: string; status: 'queued' | 'running' | 'done' | 'error' }> => request(
    `${draftPath(id)}/tests`,
    json('POST', { ...input, idempotencyKey }),
  ),

  testStatus: (
    request: CatalogRequest,
    id: string,
    jobId: string,
  ): Promise<DraftTestStatus> => request(`${draftPath(id)}/tests/${encodeURIComponent(jobId)}`),

  publish: (
    request: CatalogRequest,
    id: string,
    revision: number,
  ): Promise<CatalogLibraryView> => conflictSafe(
    request,
    `${draftPath(id)}/publish`,
    json('POST', { revision }),
    { id, revision },
  ),

  planLifecycle: (
    request: CatalogRequest,
    id: string,
    lifecycle: ModelLifecycle,
  ): Promise<LifecyclePlan> => conflictSafe(
    request,
    `${modelPath(id)}/lifecycle/plan`,
    json('POST', { lifecycle }),
    { id, lifecycle },
  ),

  applyLifecycle: (
    request: CatalogRequest,
    id: string,
    input: ApplyLifecycleInput,
  ): Promise<CatalogLibraryView> => conflictSafe(
    request,
    `${modelPath(id)}/lifecycle`,
    json('POST', input),
    input,
  ),
}

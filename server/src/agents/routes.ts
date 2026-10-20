import { raw, Router, type NextFunction, type Request, type Response } from 'express'
import type { AgentDecisionPayload, AgentGenerationAuthorization, AgentGenerationCaptureInput, AgentGenerationCaptureReceipt, AgentGenerationCaptureRequest, AgentLlmAuthorization } from '../../../packages/agent-protocol/index.js'
import { AgentHostError, type AgentHost } from './host.js'
import type { AgentPackageRegistry } from './packages.js'
import { AgentPackageError } from './package-errors.js'
import type { AgentPackageManager } from './package-manager.js'
import { loadSettings } from '../settings.js'

function bodyOf(request: Request): Record<string, unknown> {
  return request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {}
}

function httpError(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof AgentHostError) return { status: error.status, body: { error: error.message, code: error.code } }
  if (error instanceof AgentPackageError) return { status: error.status, body: { error: error.message, code: error.code } }
  return { status: 400, body: { error: error instanceof Error ? error.message : String(error), code: 'AGENT_REQUEST_INVALID' } }
}

function sendTask(host: AgentHost, response: Response, task: Awaited<ReturnType<AgentHost['get']>>): void {
  if (!task) {
    response.status(404).json({ error: 'Agent task not found', code: 'TASK_NOT_FOUND' })
    return
  }
  response.json({ task: host.view(task) })
}

function remoteTablet(response: Response): boolean {
  return response.locals.remoteTablet === true
}

function rejectRemoteCloudCreate(response: Response, body: Record<string, unknown>): void {
  if (!remoteTablet(response)) return
  const project = body.projectRef
  if (project && typeof project === 'object' && !Array.isArray(project)
    && (project as Record<string, unknown>).source !== 'local') {
    throw new AgentHostError(
      'REMOTE_CLOUD_TASK_DENIED',
      'The tablet controls only local Desktop Host tasks',
      403,
    )
  }
}

function hiddenRemoteCloudTask(response: Response, task: Awaited<ReturnType<AgentHost['get']>>): boolean {
  const source = task && typeof task === 'object' && task.projectRef && typeof task.projectRef === 'object'
    ? (task.projectRef as { source?: unknown }).source
    : undefined
  if (!remoteTablet(response) || !task || source === 'local') return false
  response.status(404).json({ error: 'Agent task not found', code: 'TASK_NOT_FOUND' })
  return true
}

function queryNumber(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

const packageZipBody = raw({
  limit: '128mb',
  type: (request) => {
    const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    return contentType === 'application/zip' || contentType === 'application/x-zip-compressed' || contentType === 'application/octet-stream'
  },
})

function uploadProvenance(request: Request): unknown {
  const header = request.get('x-canai-package-provenance')
  if (!header) return undefined
  if (header.length > 4_096) throw new AgentPackageError('SOURCE_INVALID', 'provenance header is too large', 400)
  try { return JSON.parse(header) as unknown }
  catch { throw new AgentPackageError('SOURCE_INVALID', 'provenance header must be JSON', 400) }
}

export function createAgentRouter(host: AgentHost, packages: AgentPackageRegistry, manager?: AgentPackageManager): Router {
  const router = Router()

  router.get('/agents/llm/catalog', (_request, response) => {
    return response.json(host.llmCatalog())
  })

  router.get('/agents/generation/catalog', (_request, response) => {
    return response.json(host.generationCatalog())
  })

  router.post('/agents/generation/capture', async (request, response) => {
    try {
      const body = bodyOf(request)
      const project = body.projectRef && typeof body.projectRef === 'object' && !Array.isArray(body.projectRef)
        ? body.projectRef as Record<string, unknown>
        : {}
      const inputs: AgentGenerationCaptureInput[] = Array.isArray(body.inputs)
        ? body.inputs.map((value) => {
          const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
          return { itemId: typeof row.itemId === 'string' ? row.itemId : '', kind: row.kind as AgentGenerationCaptureInput['kind'] }
        })
        : []
      const projectRevision = Number.isSafeInteger(body.projectRevision) && (body.projectRevision as number) >= 1
        ? body.projectRevision as number
        : null
      if (projectRevision === null) throw new AgentHostError('CAPTURE_INVALID', 'projectRevision must be the saved board revision', 400)
      const capture = await host.captureGenerationInputs({
        projectRef: { source: 'local', id: typeof project.id === 'string' ? project.id : '' },
        inputs,
        projectRevision,
      } satisfies AgentGenerationCaptureRequest)
      return response.json({ receipts: capture })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  router.get('/agents/runtime/python', async (_request, response) => {
    if (!manager) return response.status(503).json({ error: 'Agent installer is unavailable', code: 'PACKAGE_MANAGER_UNAVAILABLE' })
    try {
      return response.json({ runtime: await manager.runtimeStatus() })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  router.post('/agents/runtime/python/install', async (request, response) => {
    if (!manager) return response.status(503).json({ error: 'Agent installer is unavailable', code: 'PACKAGE_MANAGER_UNAVAILABLE' })
    try {
      if (bodyOf(request).confirm !== true) throw new AgentPackageError('TRUST_REQUIRED', 'Explicit confirmation is required to download the official portable Python runtime', 403)
      return response.status(201).json({ runtime: await manager.installPythonRuntime() })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  router.get('/agents/packages', async (_request, response) => {
    try {
      if (manager) return response.json({ library: await manager.list() })
      return response.json({ packages: packages.list().map((pkg) => packages.summary(pkg)) })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  router.get('/agents/packages/:packageId', async (request, response) => {
    try {
      const library = manager ? await manager.list() : null
      const summary = (library?.packages ?? packages.list().map((pkg) => packages.summary(pkg))).find((candidate) => candidate.id === request.params.packageId)
      if (!summary) return response.status(404).json({ error: 'Agent package was not found', code: 'PACKAGE_NOT_FOUND' })
      return response.json({ package: summary })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  router.post('/agents/packages/upload', packageZipBody, async (request, response) => {
    if (!manager) return response.status(503).json({ error: 'Agent installer is unavailable', code: 'PACKAGE_MANAGER_UNAVAILABLE' })
    try {
      const requestId = request.get('idempotency-key') || request.get('x-request-id') || ''
      const archive = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)
      const upload = await manager.uploadArchive(requestId, archive, uploadProvenance(request))
      return response.status(201).json({ upload })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  router.post('/agents/packages/check', async (request, response) => {
    if (!manager) return response.status(503).json({ error: 'Agent installer is unavailable', code: 'PACKAGE_MANAGER_UNAVAILABLE' })
    try {
      const body = bodyOf(request)
      const source = body.source && typeof body.source === 'object' && !Array.isArray(body.source) ? body.source as { kind?: unknown; url?: unknown; ref?: unknown; archiveId?: unknown; subdir?: unknown } : {}
      const checkedSource = source.kind === 'archive'
        ? { kind: 'archive' as const, archiveId: String(source.archiveId ?? ''), ...(typeof source.subdir === 'string' ? { subdir: source.subdir } : {}) }
        : { kind: 'git' as const, url: String(source.url ?? ''), ...(typeof source.ref === 'string' ? { ref: source.ref } : {}), ...(typeof source.subdir === 'string' ? { subdir: source.subdir } : {}) }
      const check = await manager.check({
        requestId: String(body.requestId ?? ''),
        source: checkedSource,
      })
      return response.json({ check })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  router.post('/agents/packages/install', async (request, response) => {
    if (!manager) return response.status(503).json({ error: 'Agent installer is unavailable', code: 'PACKAGE_MANAGER_UNAVAILABLE' })
    try {
      const body = bodyOf(request)
      if (body.trustConfirmed !== true) throw new AgentPackageError('TRUST_REQUIRED', 'Explicit package confirmation is required', 403)
      const installation = await manager.install({
        requestId: String(body.requestId ?? ''), checkId: String(body.checkId ?? ''), expectedRevision: Number(body.expectedRevision),
        trustConfirmed: true, approvedPermissions: Array.isArray(body.approvedPermissions) ? body.approvedPermissions.map(String) : [],
        ...(typeof body.priorInstallationId === 'string' ? { priorInstallationId: body.priorInstallationId } : {}),
      })
      return response.json({ installation, library: await manager.list() })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  router.post('/agents/packages/update', async (request, response) => {
    if (!manager) return response.status(503).json({ error: 'Agent installer is unavailable', code: 'PACKAGE_MANAGER_UNAVAILABLE' })
    try {
      const body = bodyOf(request)
      if (body.trustConfirmed !== true) throw new AgentPackageError('TRUST_REQUIRED', 'Explicit package confirmation is required', 403)
      const installation = await manager.install({
        requestId: String(body.requestId ?? ''), checkId: String(body.checkId ?? ''), expectedRevision: Number(body.expectedRevision),
        trustConfirmed: true, approvedPermissions: Array.isArray(body.approvedPermissions) ? body.approvedPermissions.map(String) : [], priorInstallationId: String(body.priorInstallationId ?? ''),
      })
      return response.json({ installation, library: await manager.list() })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  for (const action of ['enable', 'disable', 'rollback', 'remove'] as const) {
    router.post(`/agents/packages/${action}`, async (request, response) => {
      if (!manager) return response.status(503).json({ error: 'Agent installer is unavailable', code: 'PACKAGE_MANAGER_UNAVAILABLE' })
      try {
        const body = bodyOf(request)
        const installation = await manager.manage(action, {
          requestId: String(body.requestId ?? ''), expectedRevision: Number(body.expectedRevision),
          ...(typeof body.installationId === 'string' ? { installationId: body.installationId } : {}),
          ...(typeof body.packageId === 'string' ? { packageId: body.packageId } : {}),
        })
        return response.json({ installation, library: await manager.list() })
      } catch (error) {
        const failure = httpError(error)
        return response.status(failure.status).json(failure.body)
      }
    })
  }

  router.post('/agent-tasks', async (request, response) => {
    const body = bodyOf(request)
    try {
      rejectRemoteCloudCreate(response, body)
      const llm = body.llm && typeof body.llm === 'object' && !Array.isArray(body.llm)
        ? body.llm as Record<string, unknown>
        : undefined
      const generation = body.generation && typeof body.generation === 'object' && !Array.isArray(body.generation)
        ? body.generation as Record<string, unknown>
        : undefined
      const task = await host.create({
        requestId: String(body.requestId ?? ''),
        packageId: String(body.packageId ?? ''),
        taskType: String(body.taskType ?? ''),
        instruction: String(body.instruction ?? ''),
        input: body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input as Record<string, unknown> : {},
        projectRef: body.projectRef as { source: 'local'; id: string },
        inputs: Array.isArray(body.inputs) ? body.inputs as never : [],
        ...(Array.isArray(body.capturedArtifacts) ? { capturedArtifacts: body.capturedArtifacts as AgentGenerationCaptureReceipt[] } : {}),
        ...(llm ? {
          llm: {
            connectionId: String(llm.connectionId ?? ''),
            textTransferConsent: llm.textTransferConsent === true,
            maxCostMicros: Number(llm.maxCostMicros),
            ...(typeof llm.expectedModelId === 'string' ? { expectedModelId: llm.expectedModelId } : {}),
            ...(llm.expectedCatalogRevision !== undefined ? { expectedCatalogRevision: Number(llm.expectedCatalogRevision) } : {}),
          } as AgentLlmAuthorization,
        } : {}),
        ...(generation ? {
          generation: {
            connectionId: String(generation.connectionId ?? ''),
            mediaTransferConsent: generation.mediaTransferConsent === true,
            maxCostMicros: Number(generation.maxCostMicros),
            ...(generation.maxCalls !== undefined ? { maxCalls: Number(generation.maxCalls) } : {}),
            ...(typeof generation.expectedModelId === 'string' ? { expectedModelId: generation.expectedModelId } : {}),
            ...(generation.expectedCatalogRevision !== undefined ? { expectedCatalogRevision: Number(generation.expectedCatalogRevision) } : {}),
            ...(Array.isArray(generation.artifactRefs) ? { artifactRefs: generation.artifactRefs } : {}),
            ...(generation.params && typeof generation.params === 'object' && !Array.isArray(generation.params) ? { params: generation.params as Record<string, unknown> } : {}),
          } as AgentGenerationAuthorization,
        } : {}),
      })
      return response.status(201).json({ task: host.view(task) })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  router.get('/agent-tasks', async (request, response) => {
    try {
      const all = await host.list()
      const source = request.query.projectSource
      const id = request.query.projectId
      const tasks = all.filter((task) => (
        (!remoteTablet(response) || task.projectRef.source === 'local')
        && (source === undefined || task.projectRef.source === source)
        && (id === undefined || task.projectRef.id === id)
      ))
      return response.json({ tasks: tasks.map((task) => host.view(task)) })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  router.get('/agent-tasks/:taskId/events', async (request, response) => {
    try {
      const task = await host.get(request.params.taskId)
      if (!task) return response.status(404).json({ error: 'Agent task not found', code: 'TASK_NOT_FOUND' })
      if (hiddenRemoteCloudTask(response, task)) return undefined
      response.status(200)
      response.setHeader('content-type', 'text/event-stream; charset=utf-8')
      response.setHeader('cache-control', 'no-cache, no-transform')
      response.setHeader('connection', 'keep-alive')
      const write = (event: unknown) => {
        response.write(`event: agent\ndata: ${JSON.stringify(event)}\n\n`)
      }
      const after = queryNumber(request.query.after)
      let replaying = true
      const buffered: Array<{ cursor: number }> = []
      const unsubscribe = host.subscribe(task.taskId, (event) => {
        if (replaying) {
          buffered.push(event as { cursor: number })
          return
        }
        write(event)
      })
      try {
        const backlog = await host.events(task.taskId, after)
        const seen = new Set<number>()
        for (const event of backlog) { seen.add(event.cursor); write(event) }
        replaying = false
        for (const event of buffered) if (event.cursor > after && !seen.has(event.cursor)) { seen.add(event.cursor); write(event) }
      } catch (error) {
        unsubscribe()
        throw error
      }
      const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 15_000)
      request.on('close', () => { clearInterval(keepAlive); unsubscribe() })
      return undefined
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  router.get('/agent-tasks/:taskId', async (request, response) => {
    try {
      const task = await host.get(request.params.taskId)
      if (hiddenRemoteCloudTask(response, task)) return undefined
      return sendTask(host, response, task)
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    router.post(`/agent-tasks/:taskId/${action}`, async (request, response) => {
      try {
        const current = await host.get(request.params.taskId)
        if (hiddenRemoteCloudTask(response, current)) return undefined
        const body = bodyOf(request)
        const task = await host.control(request.params.taskId, action, {
          requestId: String(body.requestId ?? ''),
          expectedRevision: Number(body.expectedRevision),
          reason: String(body.reason ?? ''),
        })
        return response.json({ task: host.view(task) })
      } catch (error) {
        const failure = httpError(error)
        return response.status(failure.status).json(failure.body)
      }
    })
  }

  router.post('/agent-tasks/:taskId/reviews/:reviewId/decision', async (request, response) => {
    try {
      const current = await host.get(request.params.taskId)
      if (hiddenRemoteCloudTask(response, current)) return undefined
      const body = bodyOf(request)
      // Откуда пришёл запрос и какой дневной лимит подтверждений стоит на
      // планшете — решает ТОЛЬКО сервер (client сообщать «я планшет» нельзя:
      // это подделывается). Лимит читаем из настроек; при сбое чтения — 0
      // (не блокируем решение чужим сбоем, хуже не станет).
      const fromTablet = remoteTablet(response)
      const settings = await loadSettings().catch(() => null)
      const task = await host.decide(request.params.taskId, request.params.reviewId, {
        requestId: String(body.requestId ?? ''),
        expectedRevision: Number(body.expectedRevision),
        revision: Number(body.revision),
        decision: body.decision as AgentDecisionPayload['decision'],
        comment: typeof body.comment === 'string' ? body.comment : '',
        answers: body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers as Record<string, string> : {},
        consent: body.consent === true,
      }, {
        tablet: fromTablet,
        tabletApproveDailyLimit: settings ? settings.tabletApproveDailyLimit : 0,
      })
      return response.json({ task: host.view(task) })
    } catch (error) {
      const failure = httpError(error)
      return response.status(failure.status).json(failure.body)
    }
  })

  // Route-specific raw parsing happens before the upload handler's try/catch;
  // keep parser failures in the same small JSON API contract and never expose
  // Express parser internals to the client.
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    const type = error && typeof error === 'object' ? String((error as { type?: unknown }).type ?? '') : ''
    if (type === 'entity.too.large') return response.status(413).json({ error: 'ZIP upload exceeds the limit', code: 'ARCHIVE_TOO_LARGE' })
    if (type === 'entity.parse.failed' || type === 'encoding.unsupported') return response.status(400).json({ error: 'ZIP upload is invalid', code: 'ARCHIVE_INVALID' })
    return next(error)
  })

  return router
}

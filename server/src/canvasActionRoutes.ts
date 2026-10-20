import { buildLocalCanvasActionSystemPrompt, resolveLocalCanvasActionProfile, type LocalCanvasActionProfile } from './canvasActionPreparation.js'
import { JobLimitError, MAX_LIVE_JOBS, type Job } from './jobs.js'
import { profileError, routeError } from './canvasActionRouteErrors.js'
import { Router, type Response } from 'express'
import {
  CanvasActionRequestError,
  parseCanvasActionRequest,
} from './canvasActionPreparationService.js'
import {
  GenerationRouteError,
  GenerationShuttingDownError,
  type GenerationRoute,
} from './generationGate.js'
import {
  actionTargetMatches,
  idempotencyConflict,
  refsHash,
  withActionKeyLock,
} from './canvasActionRouteAdmission.js'
import {
  mergeCanvasActionRouteDeps,
  type CanvasActionRouteDeps,
} from './canvasActionRouteDeps.js'
import {
  startView,
  statusView,
} from './canvasActionRouteViews.js'

export type {
  CanvasActionPreparationProfileView,
  CanvasActionPreparationStart,
  CanvasActionPreparationStatus,
} from './canvasActionRouteViews.js'
export type { CanvasActionRouteDeps } from './canvasActionRouteDeps.js'

/**
 * Durable text-only preparation for the canvas action dock.  The router has no
 * media-launch endpoint by design: callers review `result.text`, then use the
 * existing generation launch with their chosen image model.
 */
export function createCanvasActionRouter(overrides: CanvasActionRouteDeps = {}): Router {
  const deps = mergeCanvasActionRouteDeps(overrides)
  const router = Router()
  const actionLocks = new Map<string, Promise<void>>()
  // A custom store used by an embedding/test must not leave a create-before-
  // enqueue phantom behind when its enqueue callback fails. The real JobStore
  // removes the job in persistAndEnqueueJob; this fallback keeps retries from
  // turning an admitted-but-never-durable job into a false 200 replay.
  const admissionFailures = new Set<string>()

  router.post('/canvas/actions/prepare', async (req, res) => {
    try {
      if (deps.isShuttingDown()) throw new GenerationShuttingDownError()
      const input = parseCanvasActionRequest(req.body)
      const lockKey = `${input.projectRef.source}\u0000${input.projectRef.id}\u0000${input.idempotencyKey}`
      await withActionKeyLock(actionLocks, lockKey, async () => {
        if (admissionFailures.has(lockKey)) {
          throw new CanvasActionRequestError(
            500,
            'Could not safely persist the job to disk',
            'CANVAS_ACTION_PERSIST_FAILED',
          )
        }
        const repeated = deps.jobStore.all().find((candidate) => actionTargetMatches(candidate, input))
        if (repeated) {
          if (idempotencyConflict(repeated, input)) {
            throw new CanvasActionRequestError(409, 'Run key is already linked to another action', 'IDEMPOTENCY_CONFLICT')
          }
          res.json(startView(repeated))
          return
        }
        if ((deps.jobStore.liveCount?.() ?? 0) >= MAX_LIVE_JOBS) {
          throw new JobLimitError()
        }
        if (input.assistantId === null && input.profileVersionId != null) {
          throw new CanvasActionRequestError(400, 'The universal assistant has no profile version', 'CANVAS_ACTION_PROFILE_INVALID')
        }

        let profile: LocalCanvasActionProfile | null = null
        let model: string
        let executionPrompt: string
        let params: Record<string, unknown>
        {
          try {
            profile = await deps.resolveLocalProfile(input.assistantId)
          } catch (error) {
            throw profileError(error)
          }
          if (input.assistantId !== undefined && input.assistantId !== null && !profile) {
            throw new CanvasActionRequestError(404, 'Selected assistant not found', 'CANVAS_ACTION_PROFILE_NOT_FOUND')
          }
          const settings = await deps.loadAppSettings()
          model = profile?.modelId || settings.assistantModelId || 'gemini'
          params = {
            system_prompt: profile?.systemPrompt
              ?? buildLocalCanvasActionSystemPrompt(),
            max_tokens: 1_024,
          }
          executionPrompt = input.prompt
        }

        let generationRoute: GenerationRoute
        try {
          generationRoute = deps.chooseRoute({
            projectSource: 'local',
            localConfigured: deps.isLocalConfigured(),
            mockMode: deps.mockMode(),
          })
        } catch (error) {
          if (error instanceof GenerationRouteError) {
            const status = error.code === 'local-provider-required'
              ? 503
              : 409
            throw new CanvasActionRequestError(status, error.message, error.code)
          }
          throw error
        }

        const target = {
          kind: 'canvas-action' as const,
          projectId: input.projectRef.id,
          source: 'local' as const,
          assistantId: profile?.id ?? null,
          assistantVersionId: null,
          refsHash: refsHash(input.refs),
          idempotencyKey: input.idempotencyKey!,
        }
        let job: Job
        try {
          job = deps.jobStore.create('text', input.prompt, input.refs, model, params, target)
        } catch (error) {
          if (error instanceof JobLimitError) throw error
          throw error
        }
        job.canvasActionPrompt = executionPrompt
        job.generationRoute = generationRoute
        try {
          await deps.enqueue(job)
        } catch (error) {
          let removed = false
          try {
            if (deps.jobStore.remove) {
              deps.jobStore.remove(job.id)
              removed = !deps.jobStore.get(job.id)
            }
          } catch {
            removed = false
          }
          if (!removed) {
            admissionFailures.add(lockKey)
          }
          if (error instanceof GenerationShuttingDownError) throw error
          throw new CanvasActionRequestError(500, 'Could not safely persist the job to disk', 'CANVAS_ACTION_PERSIST_FAILED')
        }
        admissionFailures.delete(lockKey)
        res.status(202).json(startView(job))
      })
      return
    } catch (error) {
      routeError(res, error)
    }
  })

  const getAction = (req: { params: { id: string } }, res: Response) => {
    const job = deps.jobStore.get(req.params.id)
    if (!job || job.target?.kind !== 'canvas-action') {
      res.status(404).json({ error: 'Preparation not found' })
      return
    }
    res.json(statusView(job))
  }
  router.get('/canvas/actions/prepare/:id', getAction)

  router.post('/canvas/actions/prepare/:id/cancel', async (req, res) => {
    try {
      const job = deps.jobStore.get(req.params.id)
      if (!job || job.target?.kind !== 'canvas-action') {
        return res.status(404).json({ error: 'Preparation not found' })
      }
      const outcome = await deps.cancel(req.params.id)
      if (outcome === 'not-found') return res.status(404).json({ error: 'Preparation not found' })
      return res.json({ ok: true, status: outcome })
    } catch {
      return res.status(500).json({ error: 'Cancellation accepted but could not be saved to disk' })
    }
  })

  return router
}

export const canvasActionRouter = createCanvasActionRouter()

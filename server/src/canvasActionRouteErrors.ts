import type { Response } from 'express'
import { CanvasActionRequestError, type CanvasActionPreparationRequest } from './canvasActionPreparationService.js'
import { GenerationShuttingDownError } from './generationGate.js'
import { JobLimitError } from './jobs.js'
import { formatExactUsd } from './priceFormat.js'

export function routeError(res: Response, error: unknown): void {
  if (error instanceof CanvasActionRequestError) {
    res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) })
    return
  }
  if (error instanceof GenerationShuttingDownError) {
    res.status(503).json({ error: error.message, code: 'CANVAS_ACTION_SHUTTING_DOWN' })
    return
  }
  if (error instanceof JobLimitError) {
    res.status(429).json({ error: error.message, code: 'CANVAS_ACTION_JOB_LIMIT' })
    return
  }
  res.status(500).json({ error: error instanceof Error ? error.message : 'Could not prepare action' })
}

export function profileError(error: unknown): CanvasActionRequestError {
  const message = error instanceof Error ? error.message : 'Assistant profile unavailable'
  const lower = message.toLocaleLowerCase('ru-RU')
  if (/изменил|недоступ|неполный|выберите|changed|unavailable|incomplete|select/u.test(lower)) {
    return new CanvasActionRequestError(409, message, 'CANVAS_ACTION_PROFILE_CHANGED')
  }
  return new CanvasActionRequestError(502, message, 'CANVAS_ACTION_PROFILE_UNAVAILABLE')
}

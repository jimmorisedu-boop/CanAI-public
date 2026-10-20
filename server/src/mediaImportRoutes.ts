import { Readable } from 'node:stream'
import { Router, type Request, type Response } from 'express'
import type { MediaImportTask, MediaLinkPreview } from './mediaImportTypes.js'
import { MediaLinkError, normalizeMediaLink } from './mediaLinkUrl.js'
import { proxyRemoteRange, type SafeRemoteResponse } from './safeRemote.js'

const SAFE_ENTRY_ID = /^[A-Za-z0-9._:-]{1,128}$/

export interface MediaImportManagerLike {
  preview(url: string): Promise<MediaLinkPreview>
  create(input: { url: string; entryIds?: string[] }): Promise<MediaImportTask>
  get(id: string): Promise<MediaImportTask | null>
  cancel(id: string): Promise<MediaImportTask>
}

interface MediaImportRouterDeps {
  proxyRange?: (url: string, range?: string) => Promise<SafeRemoteResponse>
}

function bodyUrl(request: Request): string {
  const value = request.body?.url
  if (typeof value !== 'string' || value.length > 4_096) throw new MediaLinkError('Link has an invalid format')
  return normalizeMediaLink(value).url
}

function errorCode(error: unknown): { status: number; code: string; message: string; details?: unknown } {
  if (error instanceof MediaLinkError) {
    return { status: 400, code: error.code, message: error.message, details: error.details }
  }
  const message = error instanceof Error ? error.message : 'Could not process link'
  if (/внутреннюю сеть|небезопасн|internal network|private network|unsafe external URL|internal address/i.test(message)) {
    return { status: 400, code: 'MEDIA_LINK_UNSAFE', message: 'Link points to a private or internal network address' }
  }
  if (/не найдена|не найден|not found|does not exist|HTTP 404/i.test(message)) {
    return { status: 404, code: 'MEDIA_IMPORT_NOT_FOUND', message }
  }
  return { status: 400, code: 'MEDIA_IMPORT_FAILED', message }
}

function sendError(response: Response, error: unknown): void {
  const mapped = errorCode(error)
  response.status(mapped.status).json({
    error: mapped.message,
    code: mapped.code,
    ...(mapped.details === undefined ? {} : { details: mapped.details }),
  })
}

export function createMediaImportRouter(
  manager: MediaImportManagerLike,
  deps: MediaImportRouterDeps = {},
): Router {
  const router = Router()
  const proxy = deps.proxyRange ?? proxyRemoteRange

  router.post('/media-imports/preview', async (request, response) => {
    try {
      response.json(await manager.preview(bodyUrl(request)))
    } catch (error) {
      sendError(response, error)
    }
  })

  router.post('/media-imports', async (request, response) => {
    try {
      const url = bodyUrl(request)
      const rawIds = request.body?.entryIds
      let entryIds: string[] | undefined
      if (rawIds !== undefined) {
        if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100 || rawIds.some((id) => typeof id !== 'string' || !SAFE_ENTRY_ID.test(id))) {
          throw new MediaLinkError('Invalid media list', 'MEDIA_IMPORT_INVALID')
        }
        entryIds = [...new Set(rawIds)]
        if (entryIds.length !== rawIds.length) throw new MediaLinkError('The media list contains duplicates', 'MEDIA_IMPORT_INVALID')
      }
      const task = await manager.create({ url, entryIds })
      response.status(202).json({ task })
    } catch (error) {
      sendError(response, error)
    }
  })

  router.get('/media-imports/direct-preview', async (request, response) => {
    try {
      const rawUrl = request.query.url
      if (typeof rawUrl !== 'string' || rawUrl.length > 4_096) throw new MediaLinkError('Link has an invalid format')
      const normalized = normalizeMediaLink(rawUrl)
      if (normalized.provider !== 'direct') throw new MediaLinkError('Preview available only for direct links')
      const upstream = await proxy(normalized.url, typeof request.headers.range === 'string' ? request.headers.range : undefined)
      response.status(upstream.response.status)
      response.setHeader('Cache-Control', 'private, max-age=300')
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges'] as const) {
        const value = upstream.response.headers.get(header)
        if (value) response.setHeader(header, value)
      }
      if (!upstream.response.body) return response.end()
      const body = Readable.fromWeb(upstream.response.body as import('node:stream/web').ReadableStream<Uint8Array>)
      request.once('close', () => body.destroy())
      body.once('error', () => { if (!response.headersSent) response.status(502); response.end() })
      body.pipe(response)
    } catch (error) {
      if (!response.headersSent) sendError(response, error)
      else response.end()
    }
  })

  router.get('/media-imports/:id', async (request, response) => {
    try {
      const task = await manager.get(request.params.id)
      if (!task) return response.status(404).json({ error: 'Download job not found', code: 'MEDIA_IMPORT_NOT_FOUND' })
      response.json({ task })
    } catch (error) {
      sendError(response, error)
    }
  })

  router.post('/media-imports/:id/cancel', async (request, response) => {
    try {
      response.json({ task: await manager.cancel(request.params.id) })
    } catch (error) {
      sendError(response, error)
    }
  })

  return router
}

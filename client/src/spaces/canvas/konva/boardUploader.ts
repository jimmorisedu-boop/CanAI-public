import { api } from '../../../api'
import type { JobResult, ProjectRef } from '../../../types'
import type { CanvasMediaUploader } from './cropApply'

let target: ProjectRef | null = null
export interface BoardFileTransport { pathPrefix: '/api/assets'; fetch: typeof fetch }
export function setBoardUploadTarget(project: ProjectRef | null, _via: BoardFileTransport | null = null): void { target = project }
export function getBoardUploadTarget(): ProjectRef | null { return target }
export function boardMediaUploader(_project: ProjectRef | null = target): CanvasMediaUploader { return api.uploadFile }
export interface AdoptHooks { onProgress?(loaded: number, total: number): void }
export async function adoptForBoard(media: { url: string; mime: string; assetId?: string; assetRevision?: number; assetChecksum?: string }, _name: string, _project: ProjectRef | null = target, _hooks: AdoptHooks = {}): Promise<typeof media> { return media }
export async function adoptResultForBoard(result: JobResult, name: string, project: ProjectRef | null = target): Promise<JobResult> {
  if (!result.url || result.assetId) return result
  const adopted = await adoptForBoard({ url: result.url, mime: result.mime ?? '', ...(result.assetRevision !== undefined ? { assetRevision: result.assetRevision } : {}), ...(result.assetChecksum ? { assetChecksum: result.assetChecksum } : {}) }, name, project)
  return { ...result, url: adopted.url, ...(adopted.assetId ? { assetId: adopted.assetId } : {}), ...(adopted.assetRevision !== undefined ? { assetRevision: adopted.assetRevision } : {}), ...(adopted.assetChecksum ? { assetChecksum: adopted.assetChecksum } : {}), ...(adopted.mime ? { mime: adopted.mime } : {}) }
}

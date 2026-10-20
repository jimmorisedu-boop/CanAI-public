import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentArtifact,
  AgentArtifactRef,
  AgentGenerationCaptureReceipt,
  AgentGenerationCaptureRequest,
} from '../../../packages/agent-protocol/index.js'
import { isCanvasSnapshot, isValidMediaSrc } from '../canvasSnapshot.js'
import { loadProjectSnapshot } from '../projects.js'
import { mediaFileName, resolveMediaInAsync } from '../mediaLayout.js'
import { mimeForExt } from '../mediaTypes.js'
import { AgentHostError } from './host-shared.js'

const MAX_CAPTURE_BYTES = 512 * 1024 * 1024
const MEDIA_KIND = new Set<AgentArtifact['kind']>(['image', 'video', 'audio'])
const CHECKSUM = /^[a-f0-9]{64}$/u
const SAFE_ITEM_ID = /^[A-Za-z0-9_-]{1,100}$/u

function rootChild(root: string, value: string, label: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(value)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new AgentHostError('CAPTURE_INVALID', `${label} is outside the media folder`)
  }
  return resolved
}

function captureError(message: string): AgentHostError {
  return new AgentHostError('CAPTURE_INVALID', message, 409)
}

function mediaExtension(src: string): string {
  const extension = path.extname(mediaFileName(src)).slice(1).toLowerCase()
  return /^[a-z0-9]{1,12}$/u.test(extension) ? extension : 'bin'
}

async function checksumFile(filePath: string): Promise<{ checksum: string; sizeBytes: number }> {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size < 1 || stat.size > MAX_CAPTURE_BYTES) {
    throw captureError('Selected media file is missing or too large')
  }
  const digest = crypto.createHash('sha256')
  let sizeBytes = 0
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer
    sizeBytes += bytes.length
    if (sizeBytes > MAX_CAPTURE_BYTES) throw captureError('Selected media file is too large')
    digest.update(bytes)
  }
  return { checksum: digest.digest('hex'), sizeBytes }
}

function artifactId(projectId: string, itemId: string, kind: AgentArtifact['kind'], extension: string, checksum: string): string {
  const digest = crypto.createHash('sha256')
    .update(`${projectId}\0${itemId}\0${kind}\0${extension}\0${checksum}`, 'utf8')
    .digest('hex')
  return `agent-ref-${digest.slice(0, 48)}`
}

function captionFor(item: Record<string, unknown>, itemId: string): string {
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  return (name || `Media ${itemId}`).slice(0, 200)
}

async function publishFrozen(
  mediaDir: string,
  sourcePath: string,
  projectId: string,
  itemId: string,
  kind: AgentArtifact['kind'],
  caption: string,
  mimeType: string,
  extension: string,
): Promise<AgentArtifact> {
  const root = path.resolve(mediaDir)
  await fs.mkdir(root, { recursive: true })
  const temporary = rootChild(root, path.join(root, `.agent-capture-${process.pid}-${crypto.randomUUID()}.tmp`), 'Temporary capture file')
  try {
    await fs.copyFile(sourcePath, temporary)
    const frozen = await checksumFile(temporary)
    const id = artifactId(projectId, itemId, kind, extension, frozen.checksum)
    const fileName = `${id}.${extension}`
    const destination = rootChild(root, path.join(root, fileName), 'Capture file')
    try {
      await fs.rename(temporary, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      const existing = await checksumFile(destination)
      if (existing.checksum !== frozen.checksum || existing.sizeBytes !== frozen.sizeBytes) {
        throw captureError('Frozen artifactId already contains different bytes')
      }
    }
    return {
      artifactId: id,
      revision: 1,
      checksum: frozen.checksum,
      kind,
      caption,
      mimeType,
      sizeBytes: frozen.sizeBytes,
      mediaSrc: `/media/${fileName}`,
      provenance: 'reference',
    }
  } finally {
    if (await fs.stat(temporary).then(() => true, () => false)) await fs.unlink(temporary).catch(() => undefined)
  }
}

function refsKey(ref: AgentArtifactRef): string {
  return `${ref.artifactId}\0${ref.revision}\0${ref.checksum}`
}

function artifactRef(artifact: AgentArtifact): AgentArtifactRef {
  return { artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum }
}

/**
 * Re-hash a receipt at task admission.  The browser may only echo a Host
 * receipt; it cannot turn a media URL or a guessed asset id into authority.
 */
export async function validateCapturedArtifacts(
  receipts: readonly AgentGenerationCaptureReceipt[] | undefined,
  mediaDir: string | undefined,
  expectedRefs: readonly AgentArtifactRef[] = [],
  projectId?: string,
): Promise<AgentArtifact[]> {
  const values = receipts ?? []
  if (values.length === 0 && expectedRefs.length === 0) return []
  if (!mediaDir) throw new AgentHostError('CAPTURE_UNAVAILABLE', 'Host has not configured native media capture', 409)
  if (values.length !== expectedRefs.length) throw captureError('Native artifacts do not match the approved refs')
  const expected = new Set(expectedRefs.map(refsKey))
  const seen = new Set<string>()
  const result: AgentArtifact[] = []
  const root = path.resolve(mediaDir)
  if (!projectId) throw new AgentHostError('CAPTURE_INVALID', 'Native artifact receipt is not linked to the local board', 409)
  const snapshot = await loadProjectSnapshot(projectId)
  if (!snapshot || !isCanvasSnapshot(snapshot.snapshot)) throw new AgentHostError('CAPTURE_SOURCE_NOT_FOUND', 'Local board was not found or changed', 409)
  const items = (snapshot.snapshot as { items: Array<Record<string, unknown>> }).items
  for (const receipt of values) {
    const artifact = receipt?.artifact
    if (!receipt || typeof receipt.itemId !== 'string' || !SAFE_ITEM_ID.test(receipt.itemId)) throw captureError('Native artifact receipt has the wrong board item identity')
    if (!artifact || !MEDIA_KIND.has(artifact.kind) || artifact.provenance !== 'reference') throw captureError('Only native media reference artifacts are allowed')
    if (!SAFE_ITEM_ID.test(artifact.artifactId) || !Number.isSafeInteger(artifact.revision) || artifact.revision < 1 || !CHECKSUM.test(artifact.checksum)) throw captureError('Native artifact receipt has an invalid identity')
    if (!isValidMediaSrc(artifact.mediaSrc) || artifact.mediaSrc.includes('..') || artifact.mediaSrc.includes('\\')) throw captureError('Native artifact receipt has an invalid mediaSrc')
    const key = refsKey(artifactRef(artifact))
    if (!expected.has(key) || seen.has(key)) throw captureError('Native artifact receipt does not match the generation grant')
    seen.add(key)
    const sourcePath = rootChild(root, await resolveMediaInAsync(root, mediaFileName(artifact.mediaSrc)), 'Native artifact')
    const actual = await checksumFile(sourcePath)
    if (actual.checksum !== artifact.checksum || actual.sizeBytes !== artifact.sizeBytes) throw captureError('Native media changed after capture; approve again')
    const item = items.find((candidate) => candidate.id === receipt.itemId)
    if (!item || item.kind !== artifact.kind || typeof item.src !== 'string' || !isValidMediaSrc(item.src)) throw captureError('Selected board item no longer matches the native receipt')
    const currentSource = rootChild(root, await resolveMediaInAsync(root, mediaFileName(item.src)), 'Current board media')
    const current = await checksumFile(currentSource)
    if (current.checksum !== artifact.checksum) throw captureError('Original board media changed; approve generation again')
    result.push(structuredClone(artifact))
  }
  return result
}

/** Resolve current board items and freeze their native bytes on the local Host. */
export async function captureGenerationInputs(
  request: AgentGenerationCaptureRequest,
  mediaDir: string | undefined,
): Promise<AgentGenerationCaptureReceipt[]> {
  if (request.projectRef.source !== 'local') throw new AgentHostError('CAPTURE_LOCAL_ONLY', 'Native media capture is available only to the local Host', 409)
  if (!mediaDir) throw new AgentHostError('CAPTURE_UNAVAILABLE', 'Host has not configured native media capture', 409)
  if (!Number.isSafeInteger(request.projectRevision) || request.projectRevision < 1) throw captureError('Native capture requires a saved board revision')
  if (!Array.isArray(request.inputs) || request.inputs.length > 100) throw captureError('Too many media inputs for capture')
  const seen = new Set<string>()
  const snapshot = await loadProjectSnapshot(request.projectRef.id)
  if (!snapshot || !isCanvasSnapshot(snapshot.snapshot)) throw new AgentHostError('CAPTURE_SOURCE_NOT_FOUND', 'Local board was not found or is not saved yet', 409)
  if (request.projectRevision !== undefined && request.projectRevision !== snapshot.revision) {
    throw new AgentHostError('CAPTURE_SOURCE_NOT_FOUND', 'Board changed before media capture; save it and approve again', 409)
  }
  const items = (snapshot.snapshot as { items: Array<Record<string, unknown>> }).items
  const receipts: AgentGenerationCaptureReceipt[] = []
  for (const input of request.inputs) {
    if (!input || !SAFE_ITEM_ID.test(input.itemId) || !MEDIA_KIND.has(input.kind) || seen.has(input.itemId)) throw captureError('Native capture input has an invalid or duplicate identity')
    seen.add(input.itemId)
    const item = items.find((candidate) => candidate.id === input.itemId)
    if (!item || item.kind !== input.kind || typeof item.src !== 'string' || !isValidMediaSrc(item.src)) throw captureError('Selected media input no longer matches the local board')
    const root = path.resolve(mediaDir)
    const sourcePath = rootChild(root, await resolveMediaInAsync(root, mediaFileName(item.src)), 'Original media file')
    const extension = mediaExtension(item.src)
    const mimeType = typeof item.mime === 'string' && item.mime.trim() ? item.mime.slice(0, 100) : mimeForExt(extension)
    const artifact = await publishFrozen(
      root,
      sourcePath,
      request.projectRef.id,
      input.itemId,
      input.kind,
      captionFor(item, input.itemId),
      mimeType,
      extension,
    )
    receipts.push({ itemId: input.itemId, artifact })
  }
  return receipts
}

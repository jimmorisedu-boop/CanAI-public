import crypto, { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extForMime } from '../mediaTypes.js'
import { mediaWritePath } from '../mediaLayout.js'
import type { AgentArtifact } from '../../../packages/agent-protocol/index.js'
import type { AgentTaskRecord } from './types.js'
import { AgentToolError, MAX_ARTIFACT_BYTES, artifactKind, mime, safeSegment, stableId, text } from './tool-shared.js'
import { checkRelativePath } from './validation.js'

interface StoredArtifactFile {
  fileName: string
  filePath: string
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')
}

async function existingArtifactFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) {
      throw new AgentToolError('FILE_INVALID', 'Saved result file is corrupt')
    }
    return true
  } catch (error) {
    if (error instanceof AgentToolError) throw error
    if (isMissing(error)) return false
    throw error
  }
}

async function persistImmutable(sourcePath: string, file: StoredArtifactFile): Promise<void> {
  if (await existingArtifactFile(file.filePath)) return

  const tempPath = `${file.filePath}.${process.pid}-${randomUUID()}.tmp`
  let received = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      if (received > MAX_ARTIFACT_BYTES) callback(new AgentToolError('FILE_INVALID', 'Result file is too large'))
      else callback(null, chunk)
    },
  })

  try {
    await pipeline(createReadStream(sourcePath), limiter, createWriteStream(tempPath, { flags: 'wx' }))
    if (received < 1) throw new AgentToolError('FILE_INVALID', 'Result file is empty')
    try {
      // A hard link publishes the completed temp file without allowing a
      // concurrent replay to replace an already published operation.
      await fs.link(tempPath, file.filePath)
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || (error as { code?: unknown }).code !== 'EEXIST') throw error
    }
  } finally {
    await fs.unlink(tempPath).catch(() => undefined)
  }
}

async function checksumFile(filePath: string): Promise<{ checksum: string; sizeBytes: number }> {
  const hash = crypto.createHash('sha256')
  let sizeBytes = 0
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer
    sizeBytes += bytes.length
    hash.update(bytes)
  }
  if (sizeBytes < 1 || sizeBytes > MAX_ARTIFACT_BYTES) throw new AgentToolError('FILE_INVALID', 'Saved result file is corrupt')
  return { checksum: hash.digest('hex'), sizeBytes }
}

async function describeArtifact(
  file: StoredArtifactFile,
  artifactId: string,
  kind: AgentArtifact['kind'],
  caption: string,
  mimeType: string,
  provenance: AgentArtifact['provenance'],
): Promise<AgentArtifact> {
  const { checksum, sizeBytes } = await checksumFile(file.filePath)
  const artifact: AgentArtifact = {
    artifactId,
    revision: 1,
    checksum,
    kind,
    caption,
    mimeType,
    sizeBytes,
    mediaSrc: `/media/${file.fileName}` as AgentArtifact['mediaSrc'],
    provenance,
  }
  if ((kind === 'text' || kind === 'plan') && sizeBytes <= 16_000) {
    artifact.text = await fs.readFile(file.filePath, 'utf8')
  }
  return artifact
}

export async function copyArtifact(task: AgentTaskRecord, args: Record<string, unknown>, operationId: string): Promise<AgentArtifact> {
  const relativePath = checkRelativePath(args.path, 'artifact.publish.path')
  const kind = artifactKind(args.kind)
  const caption = text(args.caption, 'caption')
  const mimeType = mime(args.mimeType)
  const provenance = args.provenance
  if (provenance !== 'generated' && provenance !== 'reference' && provenance !== 'derived') {
    throw new AgentToolError('INPUT_INVALID', 'provenance is not supported')
  }
  if (provenance === 'generated' && (kind === 'image' || kind === 'video' || kind === 'audio')) {
    throw new AgentToolError('INPUT_INVALID', 'provenance "generated" for media is allowed only for the generation broker')
  }

  // Both the artifact ID and its short filename are derived from the complete
  // task/operation identity.  The latter keeps Windows paths bounded while
  // retaining the same collision resistance as the protocol ID.
  const artifactId = stableId('artifact', task.taskId, operationId)
  const fileName = `${safeSegment(artifactId)}.${extForMime(mimeType)}`
  const filePath = await mediaWritePath(fileName)
  const file = { fileName, filePath }

  // A retry after a lost receipt must return the already published bytes even
  // when the workspace source has since changed or disappeared.
  if (await existingArtifactFile(filePath)) {
    return describeArtifact(file, artifactId, kind, caption, mimeType, provenance)
  }

  const root = path.resolve(task.workspacePath)
  const source = path.resolve(root, relativePath)
  if (!source.startsWith(root + path.sep)) throw new AgentToolError('PATH_INVALID', 'File is outside the workspace')
  const realRoot = await fs.realpath(root).catch(() => root)
  const realSource = await fs.realpath(source).catch(() => '')
  if (!realSource || !realSource.startsWith(realRoot + path.sep)) throw new AgentToolError('PATH_INVALID', 'File is outside the workspace')
  const stat = await fs.stat(realSource)
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) throw new AgentToolError('FILE_INVALID', 'Result file is missing or too large')

  await persistImmutable(realSource, file)
  return describeArtifact(file, artifactId, kind, caption, mimeType, provenance)
}

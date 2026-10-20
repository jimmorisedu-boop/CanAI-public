import crypto from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AgentArtifact, AgentArtifactRef } from '../../../packages/agent-protocol/index.js'
import { isValidMediaSrc } from '../canvasSnapshot.js'
import { mediaFileName, resolveMediaInAsync } from '../mediaLayout.js'
import { extForMime } from '../mediaTypes.js'
import type { AgentTaskRecord } from './types.js'
import { AgentToolError, MAX_ARTIFACT_BYTES, type ToolResult } from './tool-shared.js'
import {
  CHECKSUM,
  SAFE_ID,
  assertSafeTree,
  digestFile,
  ensureChildDirectory,
  errorCode,
  missing,
  placeExclusive,
  type FileDigest,
  type LinkFile,
} from './tool-paths.js'
import { checkRelativePath } from './validation.js'

const READ_DIRECTORY = 'media-read'
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u
const ARTIFACT_KINDS = new Set<AgentArtifact['kind']>(['image', 'video', 'audio', 'text', 'document', 'plan'])
// Имя копии — начало контрольной суммы. Сорока знаков (160 бит) хватает, чтобы
// два разных файла не совпали, а путь остаётся коротким: полное имя с id
// артефакта доходило до 165 знаков и вместе с рабочей папкой переваливало за
// предел Windows.
const NAME_CHECKSUM_CHARS = 40
/** MAX_PATH Windows — 260 вместе с завершающим нулём. Node открывает и более
 *  длинные пути, а ffmpeg и Python, ради которых файл и кладётся, — нет. */
const WINDOWS_MAX_PATH = 259

export interface MediaReadOptions {
  /** Подмена жёсткой ссылки в тестах: на exFAT и FAT её нет. */
  link?: LinkFile
}

export interface VerifiedSource {
  artifact: AgentArtifact
  /** Файл в медиа Host. Workspace агента сюда не попадает никогда. */
  file: string
}

function refKey(ref: AgentArtifactRef): string {
  return `${ref.artifactId}\0${ref.revision}\0${ref.checksum}`
}

function validateReceiptMetadata(artifact: AgentArtifact): void {
  if (!ARTIFACT_KINDS.has(artifact.kind)
    || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 || artifact.sizeBytes > MAX_ARTIFACT_BYTES
    || typeof artifact.mimeType !== 'string' || !MIME.test(artifact.mimeType)) {
    throw new AgentToolError('REF_NOT_AVAILABLE', 'Native artifact receipt contains incompatible metadata')
  }
  const prefix = artifact.kind === 'image' || artifact.kind === 'video' || artifact.kind === 'audio'
    ? `${artifact.kind}/`
    : undefined
  if (prefix && !artifact.mimeType.toLowerCase().startsWith(prefix)) {
    throw new AgentToolError('REF_NOT_AVAILABLE', 'Native artifact receipt contains an incompatible kind/mimeType')
  }
}

/** Точный ref без лишних полей: путь, URL или имя файла сюда не протащить. */
export function parseArtifactRef(value: unknown, label: string): AgentArtifactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentToolError('INPUT_INVALID', `${label} requires an exact artifactRef`)
  const object = value as Record<string, unknown>
  if (Object.keys(object).some((key) => key !== 'artifactId' && key !== 'revision' && key !== 'checksum')
    || typeof object.artifactId !== 'string' || !SAFE_ID.test(object.artifactId)
    || !Number.isSafeInteger(object.revision) || Number(object.revision) < 1
    || typeof object.checksum !== 'string' || !CHECKSUM.test(object.checksum)) {
    throw new AgentToolError('INPUT_INVALID', `${label} requires an exact artifactRef`)
  }
  return { artifactId: object.artifactId, revision: Number(object.revision), checksum: object.checksum }
}

/** Квитанция Host на этот ref. Агент называет артефакт, а не файл. */
export function sourceArtifact(task: AgentTaskRecord, ref: AgentArtifactRef): AgentArtifact {
  if (task.projectRef.source !== 'local') {
    throw new AgentToolError('UNSUPPORTED_TOOL', 'Reading Cloud media requires a separate shared Host')
  }
  const input = task.inputs.find((candidate) =>
    candidate.artifactId === ref.artifactId && candidate.revision === ref.revision && candidate.checksum === ref.checksum)
  const artifact = task.artifacts.find((candidate) => refKey(candidate) === refKey(ref))
  if (!input && !artifact) throw new AgentToolError('REF_NOT_AVAILABLE', 'Unknown artifact ref: it is not among the task inputs or results')
  if (!artifact) throw new AgentToolError('REF_NOT_AVAILABLE', 'No Host-issued native receipt for the input ref')
  if (input && input.kind !== artifact.kind) throw new AgentToolError('REF_NOT_AVAILABLE', 'Input ref does not match the native receipt')
  validateReceiptMetadata(artifact)
  if (!isValidMediaSrc(artifact.mediaSrc)) throw new AgentToolError('PATH_INVALID', 'Native artifact receipt contains an invalid mediaSrc')
  return artifact
}

async function sourceFile(mediaDir: string, artifact: AgentArtifact): Promise<string> {
  const root = await assertSafeTree(mediaDir, mediaDir, 'Media storage')
  const name = mediaFileName(artifact.mediaSrc)
  if (!name || name === '.' || name === '..') throw new AgentToolError('PATH_INVALID', 'Native artifact receipt contains an invalid filename')
  // Где файл лежит сейчас, знает только индекс: раскладка по доскам переносит
  // его между папками, а ссылка при этом не меняется.
  const candidate = await resolveMediaInAsync(root, name)
  const candidateStat = await fsp.lstat(candidate).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (!candidateStat) throw new AgentToolError('REF_NOT_AVAILABLE', 'Native media file was not found')
  const source = await assertSafeTree(root, candidate, 'Native media')
  const stat = await fsp.lstat(source)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AgentToolError('FILE_INVALID', 'Native media file is missing or is a link')
  // Размер сверяем до чтения: чужой или раздувшийся файл не должен стоить
  // копирования сотен мегабайт ради отказа.
  if (stat.size !== artifact.sizeBytes) throw new AgentToolError('FILE_INVALID', 'Native media changed after Host capture')
  return source
}

function assertUnchanged(actual: FileDigest, ref: AgentArtifactRef, artifact: AgentArtifact): void {
  if (actual.checksum !== ref.checksum || actual.sizeBytes !== artifact.sizeBytes) {
    throw new AgentToolError('FILE_INVALID', 'Native media changed after Host capture')
  }
}

/**
 * Исходник, которым владеет Host: квитанция задачи, файл в медиа и сверка его
 * байтов с ref. Этим путём обязан ходить всякий инструмент Host, которому
 * нужны сами байты (монтаж): копия в рабочей папке агента ему не подходит —
 * агент может подменить её между проверкой и чтением.
 */
export async function resolveVerifiedSource(task: AgentTaskRecord, mediaDir: string | undefined, ref: AgentArtifactRef): Promise<VerifiedSource> {
  const artifact = sourceArtifact(task, ref)
  if (!mediaDir) throw new AgentToolError('MEDIA_UNAVAILABLE', 'Host has not configured native media storage')
  const file = await sourceFile(mediaDir, artifact)
  assertUnchanged(await digestFile(file), ref, artifact)
  return { artifact, file }
}

export function materializedMediaPath(ref: AgentArtifactRef, mimeType: string): string {
  return `${READ_DIRECTORY}/${ref.checksum.slice(0, NAME_CHECKSUM_CHARS)}.${extForMime(mimeType)}`
}

/** Откроют ли этот путь ffmpeg и Python. Вне Windows предела нет. */
export function materializedPathFits(absolutePath: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' || absolutePath.length <= WINDOWS_MAX_PATH
}

type OutputState = 'missing' | 'intact' | 'corrupted'

async function outputState(root: string, target: string, expected: FileDigest): Promise<OutputState> {
  const stat = await fsp.lstat(target).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (!stat) return 'missing'
  if (stat.isSymbolicLink()) throw new AgentToolError('PATH_INVALID', 'Materialized media output uses a symlink or junction')
  await assertSafeTree(root, target, 'Materialized media output')
  if (!stat.isFile() || stat.size !== expected.sizeBytes) return 'corrupted'
  const actual = await digestFile(target)
  return actual.checksum === expected.checksum ? 'intact' : 'corrupted'
}

/** Копия для агента — настоящая, не ссылка: через жёсткую ссылку агент правил
 *  бы файл Host. Сверяем те байты, которые легли на диск. */
async function copyVerified(source: string, target: string, workspaceRoot: string, expected: FileDigest, link?: LinkFile): Promise<void> {
  const temporary = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`
  const hash = crypto.createHash('sha256')
  let sizeBytes = 0
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length
      if (sizeBytes > MAX_ARTIFACT_BYTES) callback(new AgentToolError('FILE_INVALID', 'Native media file is too large'))
      else {
        hash.update(chunk)
        callback(null, chunk)
      }
    },
  })
  try {
    await pipeline(createReadStream(source), tap, createWriteStream(temporary, { flags: 'wx' }))
    if (sizeBytes < 1) throw new AgentToolError('FILE_INVALID', 'Native media file is empty')
    if (hash.digest('hex') !== expected.checksum || sizeBytes !== expected.sizeBytes) {
      throw new AgentToolError('FILE_INVALID', 'Native media changed after Host capture')
    }
    if (await placeExclusive(temporary, target, link) === 'exists') {
      // Параллельный вызов успел раньше. Его файл обязан быть тем же самым.
      if (await outputState(workspaceRoot, target, expected) !== 'intact') {
        throw new AgentToolError('FILE_INVALID', 'Parallel materialized output is corrupt')
      }
    }
  } finally {
    await fsp.unlink(temporary).catch(() => undefined)
  }
}

async function prepareDirectory(workspacePath: string): Promise<{ root: string; directory: string }> {
  const root = await assertSafeTree(workspacePath, workspacePath, 'Workspace')
  const directory = await ensureChildDirectory(root, READ_DIRECTORY, 'Materialized media folder')
  return { root, directory }
}

export async function readMedia(
  task: AgentTaskRecord,
  mediaDir: string | undefined,
  args: Record<string, unknown>,
  options: MediaReadOptions = {},
): Promise<ToolResult> {
  const ref = parseArtifactRef(args, 'media.read')
  const artifact = sourceArtifact(task, ref)
  const prepared = await prepareDirectory(task.workspacePath)
  const relativePath = materializedMediaPath(ref, artifact.mimeType)
  checkRelativePath(relativePath, 'media.read.file.path')
  const target = path.join(prepared.directory, path.basename(relativePath))
  if (!materializedPathFits(target)) {
    throw new AgentToolError('PATH_TOO_LONG', 'Task workspace is too deep: file paths longer than 259 characters cannot be opened by ffmpeg or Python')
  }
  const expected = { checksum: ref.checksum, sizeBytes: artifact.sizeBytes }
  const file = { path: relativePath, checksum: ref.checksum, sizeBytes: artifact.sizeBytes, mimeType: artifact.mimeType, kind: artifact.kind }

  const state = await outputState(prepared.root, target, expected)
  if (state === 'intact') return { result: { file } }

  if (!mediaDir) throw new AgentToolError('MEDIA_UNAVAILABLE', 'Host has not configured native media storage')
  const source = await sourceFile(mediaDir, artifact)
  if (path.relative(target, source) === '') {
    throw new AgentToolError('PATH_INVALID', 'Materialized output cannot be the same as the source media file')
  }
  if (state === 'corrupted') {
    // Копию испортили в рабочей папке, а исходник Host цел — чиним, а не
    // отказываем навсегда. Но только убедившись, что чинить есть чем: при
    // изменённом исходнике испорченная копия остаётся уликой.
    assertUnchanged(await digestFile(source), ref, artifact)
    await fsp.unlink(target).catch((error) => {
      if (missing(error)) return
      throw new AgentToolError('FILE_INVALID', `Saved materialized media output is corrupt and in use (${errorCode(error) ?? 'error'})`, true)
    })
  }
  await copyVerified(source, target, prepared.root, expected, options.link)
  return { result: { file } }
}
